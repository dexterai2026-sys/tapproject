import { describe, expect, it, vi } from 'vitest';
import { Tracer, exportResults, headlineOf, percentile, slowest, stagesOf, summarize, type Trace } from '../src/perf';
import { Speaker } from '../src/ai/speech';
import { chat } from '../src/ai/openrouter';
import { synthesize } from '../src/ai/lazybird';
import { VoiceListener, type RecognitionLike } from '../src/voice/listener';
import { resolveCommand } from '../src/voice/command';
import { Commentator } from '../src/ai/commentator';
import { DEFAULT_SETTINGS } from '../src/settings';
import { matchingGame } from '../src/games/matching';
import { applyAction, startGame } from '../src/engine/engine';
import { STANDARD_DECK, mulberry32 } from '../src/engine/deck';
import type { Card } from '../src/engine/types';

const trace = (marks: Record<string, number>, meta: Trace['meta'] = {}, label = 'voice'): Trace => ({
  id: 1, label, startedAt: 0, meta, marks: Object.entries(marks).map(([name, t]) => ({ name, t })),
});

describe('stage math', () => {
  const full = trace({
    pressed: 1000, audioStart: 1150, speechStart: 1300, speechEnd: 2000, final: 2900, parsed: 2905, acted: 2910,
    textReady: 2910, screenUpdated: 2915, queued: 2911, synthStart: 2912, synthFirstByte: 3700, synthDone: 3900,
    playStart: 3980, playEnd: 6000,
  });
  it('computes every stage from fixed timestamps', () => {
    const s = Object.fromEntries(stagesOf(full).map((x) => [x.key, x.ms]));
    expect(s).toMatchObject({
      micWarmup: 150, recognizerFinalize: 900, parse: 5, action: 5, commentary: 0, queueWait: 1,
      voiceFirstByte: 788, voiceDownload: 200, playbackStart: 80,
    });
    expect(s.browserVoiceStart).toBeUndefined(); // only when the browser fallback ran
  });
  it('headline numbers are measured from the end of speech', () => {
    expect(headlineOf(full)).toEqual({ toScreenMs: 915, toFirstSoundMs: 1980, playbackMs: 2020 });
  });
  it('falls back to the transcript, then the input, as the starting point', () => {
    expect(headlineOf(trace({ final: 100, screenUpdated: 130 })).toScreenMs).toBe(30);
    expect(headlineOf(trace({ input: 50, screenUpdated: 52, playStart: 400 }, {}, 'tap'))).toEqual({ toScreenMs: 2, toFirstSoundMs: 350 });
  });
  it('skips stages with missing or out-of-order marks instead of guessing', () => {
    expect(stagesOf(trace({ speechEnd: 10 }))).toEqual([]);
    expect(stagesOf(trace({ speechEnd: 500, final: 100 }))).toEqual([]);
    expect(headlineOf(trace({}))).toEqual({});
  });
  it('identifies the slowest stage', () => {
    expect(slowest(stagesOf(full))?.key).toBe('recognizerFinalize'); // 900 beats Lazybird first byte at 788
    expect(slowest([])).toBeUndefined();
  });
  it('browser-voice fallback gets its own stage', () => {
    const s = stagesOf(trace({ fallbackStart: 100, playStart: 460 }));
    expect(s).toEqual([{ key: 'browserVoiceStart', label: 'Browser voice start', ms: 360 }]);
  });
});

describe('percentiles and summary', () => {
  it('median and p90', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([30, 10, 20], 50)).toBe(20); // order independent
  });
  it('summarizes stages and both headline numbers across traces', () => {
    const mk = (fin: number, play: number) => trace({ speechEnd: 0, final: fin, screenUpdated: fin + 10, playStart: play });
    const sum = summarize([mk(500, 1500), mk(900, 2100), mk(700, 1900)]);
    expect(sum.toFirstSound).toMatchObject({ n: 3, median: 1900, p90: 2100 });
    expect(sum.toScreen).toMatchObject({ n: 3, median: 710, p90: 910 });
    expect(sum.stages.find((s) => s.key === 'recognizerFinalize')).toMatchObject({ n: 3, median: 700 });
    expect(summarize([]).toFirstSound).toBeUndefined();
  });
});

describe('Tracer', () => {
  it('records marks with an injectable clock, markOnce keeps the first, meta is stored', () => {
    let now = 100;
    const t = new Tracer(() => now, () => 1_700_000_000_000);
    const id = t.start('voice');
    now = 150; t.mark(id, 'final');
    now = 160; t.markOnce(id, 'final'); t.markOnce(id, 'parsed');
    t.setMeta(id, 'command', 'draw');
    const ref = t.ref(id); ref.mark('acted', 999); ref.meta('ok', true);
    const tr = t.get(id)!;
    expect(tr.marks).toEqual([{ name: 'final', t: 150 }, { name: 'parsed', t: 160 }, { name: 'acted', t: 999 }]);
    expect(tr.meta).toEqual({ command: 'draw', ok: true });
  });
  it('caps each label separately so taps never evict voice traces', () => {
    const t = new Tracer();
    const v = t.start('voice');
    for (let i = 0; i < 120; i++) t.start('tap');
    expect(t.get(v)).toBeDefined();
    expect(t.all().filter((x) => x.label === 'tap')).toHaveLength(50);
    for (let i = 0; i < 60; i++) t.start('voice');
    expect(t.all().filter((x) => x.label === 'voice')).toHaveLength(50);
    expect(t.get(v)).toBeUndefined(); // oldest voice trace went, as the cap intends
  });
  it('notifies subscribers, supports unsubscribe, clear, and ignores unknown ids', () => {
    const t = new Tracer(); const fn = vi.fn();
    const off = t.subscribe(fn);
    const id = t.start('voice'); t.mark(id, 'x');
    expect(fn).toHaveBeenCalledTimes(2);
    off(); t.mark(id, 'y'); expect(fn).toHaveBeenCalledTimes(2);
    expect(() => t.mark(999, 'z')).not.toThrow();
    t.clear(); expect(t.all()).toEqual([]);
  });
  it('lastMeasured can filter by label and skips empty traces', () => {
    const t = new Tracer();
    const a = t.start('voice'); t.mark(a, 'speechEnd', 0); t.mark(a, 'final', 400);
    t.start('voice'); // empty
    const c = t.start('tap'); t.mark(c, 'input', 0); t.mark(c, 'screenUpdated', 3);
    expect(t.lastMeasured()?.label).toBe('tap');
    expect(t.lastMeasured('voice')?.id).toBe(a);
  });
});

describe('export', () => {
  it('contains timings and settings labels but never keys or transcripts', () => {
    const settings = { ...DEFAULT_SETTINGS, openrouterKey: 'sk-SECRET', lazybirdKey: 'lb-SECRET' };
    const tr = trace({ speechEnd: 0, final: 800, screenUpdated: 820, playStart: 1900 }, { command: 'draw', mode: 'wake', voicePath: 'lazybird' });
    const out = JSON.stringify(exportResults([tr], { userAgent: 'UA', mic: settings.mic, commentary: settings.commentary, voice: 'lazybird', speak: true }));
    expect(out).not.toContain('SECRET');
    const parsed = JSON.parse(out);
    expect(parsed.traces[0].stages.recognizerFinalize).toBe(800);
    expect(parsed.traces[0].headline.toFirstSoundMs).toBe(1900);
    expect(parsed.summary.toFirstSound.median).toBe(1900);
    expect(parsed.context.voice).toBe('lazybird');
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Speaker timing', () => {
  it('marks queue -> synth -> first byte -> done -> play start/end in order, with the real waits', async () => {
    const t = new Tracer(); const id = t.start('voice');
    const sp = new Speaker({
      synth: async (_txt, _ssml, onTiming) => {
        const startedAt = performance.now(); await sleep(60);
        const firstByteAt = performance.now(); await sleep(40);
        onTiming?.({ startedAt, firstByteAt, doneAt: performance.now(), bytes: 1234 });
        return new Blob(['x']);
      },
      playBlob: async (_b, _s, onStart) => { await sleep(20); onStart?.(); await sleep(30); },
    });
    sp.speak('hello there', { trace: t.ref(id) });
    await sleep(250);
    const tr = t.get(id)!;
    const order = ['queued', 'synthStart', 'synthFirstByte', 'synthDone', 'playStart', 'playEnd'];
    const at = (n: string) => tr.marks.find((m) => m.name === n)!.t;
    for (let i = 1; i < order.length; i++) expect(at(order[i]!), order[i]).toBeGreaterThanOrEqual(at(order[i - 1]!));
    const s = Object.fromEntries(stagesOf(tr).map((x) => [x.key, x.ms]));
    expect(s.voiceFirstByte).toBeGreaterThanOrEqual(55);
    expect(s.voiceDownload).toBeGreaterThanOrEqual(35);
    expect(s.playbackStart).toBeGreaterThanOrEqual(15);
    expect(tr.meta).toMatchObject({ voicePath: 'lazybird', audioBytes: 1234, textChars: 11 });
  });
  it('a second line waits in the queue and that wait is measured', async () => {
    const t = new Tracer(); const a = t.start('voice'); const b = t.start('voice');
    const sp = new Speaker({ synth: async () => { await sleep(50); return new Blob(['x']); }, playBlob: async (_b, _s, on) => { on?.(); await sleep(80); } });
    sp.speak('first', { trace: t.ref(a) }); sp.speak('second', { trace: t.ref(b) });
    await sleep(400);
    const wait = stagesOf(t.get(b)!).find((x) => x.key === 'queueWait')!.ms;
    expect(wait).toBeGreaterThanOrEqual(110); // behind ~130ms of the first line
  });
  it('records the browser-voice path, and flags when it was a fallback after Lazybird failed', async () => {
    const t = new Tracer(); const a = t.start('voice'); const b = t.start('voice');
    const fb = async (_t: string, _s: AbortSignal, on?: () => void) => { await sleep(15); on?.(); };
    new Speaker({ fallback: fb }).speak('plain', { trace: t.ref(a) });
    new Speaker({ synth: async () => { throw new Error('boom'); }, playBlob: async () => {}, fallback: fb }).speak('plain', { trace: t.ref(b) });
    await sleep(120);
    expect(t.get(a)!.meta.voicePath).toBe('browser');
    expect(t.get(b)!.meta.voicePath).toBe('browser-after-lazybird-failed');
    expect(stagesOf(t.get(b)!).some((x) => x.key === 'browserVoiceStart')).toBe(true);
  });
  it('works without a trace (no-op) and a synth that reports no timing still gets synthDone', async () => {
    const t = new Tracer(); const id = t.start('voice');
    const sp = new Speaker({ synth: async () => new Blob(['x']), playBlob: async (_b, _s, on) => on?.() });
    sp.speak('no trace'); sp.speak('traced', { trace: t.ref(id) });
    await sleep(60);
    expect(t.get(id)!.marks.map((m) => m.name)).toEqual(expect.arrayContaining(['synthDone', 'playStart', 'playEnd']));
  });
});

describe('API timing hooks', () => {
  it('openrouter reports its round trip, success and failure', async () => {
    const seen: { ms: number; ok: boolean }[] = [];
    const okFetch = (async () => { await sleep(30); return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] })); }) as unknown as typeof fetch;
    await chat({ apiKey: 'k', model: 'm', messages: [], fetchImpl: okFetch, onTiming: (x) => seen.push(x) });
    await chat({ apiKey: 'k', model: 'm', messages: [], fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch, onTiming: (x) => seen.push(x) }).catch(() => {});
    expect(seen[0]!.ok).toBe(true); expect(seen[0]!.ms).toBeGreaterThanOrEqual(25);
    expect(seen[1]!.ok).toBe(false);
  });
  it('lazybird reports first byte and download separately', async () => {
    let got: { startedAt: number; firstByteAt: number; doneAt: number; bytes: number } | undefined;
    const f = (async () => { await sleep(40); return new Response(new Blob(['abcdef'])); }) as unknown as typeof fetch;
    await synthesize('hi', 'v', { apiKey: 'k', fetchImpl: f, onTiming: (x) => (got = x) });
    expect(got!.firstByteAt - got!.startedAt).toBeGreaterThanOrEqual(35);
    expect(got!.doneAt).toBeGreaterThanOrEqual(got!.firstByteAt);
    expect(got!.bytes).toBe(6);
  });
  it('command fallback reports its model call only when it was needed', async () => {
    const times: number[] = [];
    await resolveCommand('draw', { apiKey: 'k', model: 'm', chatImpl: async () => 'draw', onFallbackTiming: (m) => times.push(m) });
    expect(times).toEqual([]);
    await resolveCommand('gimme another', { apiKey: 'k', model: 'm', chatImpl: async () => { await sleep(20); return 'draw'; }, onFallbackTiming: (m) => times.push(m) });
    expect(times).toHaveLength(1); expect(times[0]).toBeGreaterThanOrEqual(15);
  });
});

describe('listener timing events', () => {
  it('forwards audio start, speech start and speech end', () => {
    const rec = { continuous: false, interimResults: false, lang: '', onresult: null, onend: null, onerror: null, start: vi.fn(), stop: vi.fn() } as unknown as RecognitionLike;
    const got: string[] = [];
    new VoiceListener({ mode: 'push', wakeWord: '', onUtterance: () => {}, onTiming: (e) => got.push(e), factory: () => rec }).start();
    rec.onaudiostart!(); rec.onspeechstart!(); rec.onspeechend!();
    expect(got).toEqual(['audioStart', 'speechStart', 'speechEnd']);
  });
});

describe('Commentator tracing', () => {
  const rng = mulberry32(3);
  const card = (id: string) => STANDARD_DECK.find((c) => c.id === id) as Card;
  const prev = (() => { const s = startGame(matchingGame, [{ id: 'p0', name: 'A' }, { id: 'p1', name: 'B' }], rng); s.private.p0 = { hand: ['star-9', 'circle-1'].map(card) }; s.public.discard = [card('star-5')]; return s; })();
  const act = { type: 'play' as const, player: 'p0', cardId: 'star-9' };
  const result = applyAction(matchingGame, prev, act, rng);
  it('canned lines mark textReady immediately and pass the trace to the speaker', () => {
    const t = new Tracer(); const id = t.start('voice'); const speak = vi.fn();
    new Commentator({ settings: () => ({ ...DEFAULT_SETTINGS, commentary: 'canned' }), speak, pick: () => 'line', caption: () => {} }).onResult(prev, act, result, t.ref(id));
    expect(t.get(id)!.marks.map((m) => m.name)).toEqual(expect.arrayContaining(['textReady', 'captionShown']));
    expect(speak.mock.calls[0]![1].trace).toBeDefined();
    expect(t.get(id)!.meta.liveAI).toBeUndefined();
  });
  it('live lines record that AI was used and its time', async () => {
    const t = new Tracer(); const id = t.start('voice'); const spoken: string[] = [];
    new Commentator({
      settings: () => ({ ...DEFAULT_SETTINGS, commentary: 'live', openrouterKey: 'k', liveCap: 5 }),
      speak: (x) => spoken.push(x), pick: () => 'line', caption: () => {},
      chatImpl: async (o) => { o.onTiming?.({ ms: 777, ok: true }); await sleep(30); return 'live line'; },
    }).onResult(prev, act, result, t.ref(id));
    await sleep(80);
    expect(t.get(id)!.meta).toMatchObject({ liveAI: true, liveAIMs: 777 });
    expect(spoken[0]).toContain('live line');
    const names = t.get(id)!.marks.map((m) => m.name);
    expect(names).toContain('textReady'); // marked when the AI line arrived, not before
  });
});
