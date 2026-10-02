import { describe, expect, it, vi } from 'vitest';
import { LATE_MAX_MS, Speaker } from '../src/ai/speech';
import { pickBrowserVoice, routeFor, tierFor, type VoiceLike } from '../src/ai/voiceRouter';
import { AudioCache, cacheKey, memoryStore, type BlobStore } from '../src/ai/audioCache';
import { Tracer, exportResults, headlineOf, lineInfoOf, stagesOf, type Trace } from '../src/perf';
import { addHeard, countHeard, HEARD_CAP, type HeardEntry } from '../src/voice/heard';
import { parseCommand, resolveDetailed } from '../src/voice/command';
import { VoiceListener, type RecognitionLike } from '../src/voice/listener';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blob = (n = 4) => new Blob(['x'.repeat(n)]);

describe('voice router', () => {
  it('only reactions are flavor; answers, confirmations, errors and the turn line are instant', () => {
    expect(tierFor('reaction')).toBe('flavor');
    for (const k of ['answer', 'confirmation', 'turn', 'error', undefined, 'line']) expect(tierFor(k)).toBe('instant');
  });
  it('hybrid: instant -> device, flavor -> late Lazybird; lazybird mode blocks in order; browser mode never uses the cloud', () => {
    expect(routeFor('hybrid', 'instant', true)).toBe('browser');
    expect(routeFor('hybrid', 'flavor', true)).toBe('cloud-late');
    expect(routeFor('lazybird', 'instant', true)).toBe('cloud-block');
    expect(routeFor('lazybird', 'flavor', true)).toBe('cloud-block');
    expect(routeFor('browser', 'flavor', true)).toBe('browser');
  });
  it('without a Lazybird key everything is on-device, whatever the mode', () => {
    for (const mode of ['hybrid', 'lazybird', 'browser'] as const) for (const tier of ['instant', 'flavor'] as const) expect(routeFor(mode, tier, false)).toBe('browser');
  });
  it('picks the saved voice, else the best English voice (local + natural names first), else nothing', () => {
    const v = (voiceURI: string, name: string, lang: string, localService: boolean): VoiceLike => ({ voiceURI, name, lang, localService });
    const voices = [v('fr', 'Amelie', 'fr-FR', true), v('online', 'Google US English', 'en-US', false), v('local', 'Samantha', 'en-US', true), v('nat', 'Samantha (Enhanced)', 'en-US', true), v('uk', 'Daniel', 'en-GB', true)];
    expect(pickBrowserVoice(voices, 'uk')?.voiceURI).toBe('uk'); // saved choice wins
    expect(pickBrowserVoice(voices, '')?.voiceURI).toBe('nat'); // local + enhanced beats local beats online
    expect(pickBrowserVoice(voices, 'gone')?.voiceURI).toBe('nat'); // saved voice no longer installed
    expect(pickBrowserVoice([v('fr', 'Amelie', 'fr-FR', true)], '')).toBeUndefined();
    expect(pickBrowserVoice([], '')).toBeUndefined();
  });
});

function rig(over: Partial<ConstructorParameters<typeof Speaker>[0]> = {}) {
  const spoken: { text: string; at: number }[] = [];
  const t0 = performance.now();
  const synth = vi.fn(async (_t: string, _s: boolean, onTiming?: (t: { startedAt: number; firstByteAt: number; doneAt: number; bytes: number }) => void) => {
    const startedAt = performance.now(); await sleep(60);
    const firstByteAt = performance.now(); onTiming?.({ startedAt, firstByteAt, doneAt: firstByteAt + 1, bytes: 4 });
    return blob();
  });
  const sp = new Speaker({
    synth, playBlob: async (_b, _s, on) => { spoken.push({ text: 'cloud', at: performance.now() - t0 }); on?.(); await sleep(20); },
    fallback: async (text, _s, on) => { spoken.push({ text, at: performance.now() - t0 }); on?.(); await sleep(20); },
    ...over,
  });
  return { sp, spoken, synth };
}

describe('Speaker routing', () => {
  it('browser-route lines never touch Lazybird and are marked as such', async () => {
    const tr = new Tracer(); const id = tr.start('voice');
    const { sp, synth, spoken } = rig({ route: () => 'browser' });
    sp.speak('Player 2 draws 1.', { trace: tr.ref(id), kind: 'confirmation' });
    await sleep(60);
    expect(synth).not.toHaveBeenCalled();
    expect(spoken.map((s) => s.text)).toEqual(['Player 2 draws 1.']);
    const line = tr.get(id)!.lines[0]!;
    expect(line.meta).toMatchObject({ route: 'browser', tier: 'instant', voicePath: 'browser' });
    expect(stagesOf(tr.get(id)!).some((s) => s.key === 'browserVoiceStart')).toBe(true);
  });
  it('a quick on-device line is not held up by a slow flavor line queued before it', async () => {
    const { sp, spoken } = rig({
      route: (k) => (k === 'reaction' ? 'cloud-late' : 'browser'),
      synth: async () => { await sleep(300); return blob(); }, // slow Lazybird
    });
    sp.speak('Nice play.', { kind: 'reaction' }); // flavor first...
    sp.speak('Sam, you are up.', { kind: 'turn' }); // ...but the quick line is spoken right away
    await sleep(80);
    expect(spoken.map((s) => s.text)).toEqual(['Sam, you are up.']);
    expect(spoken[0]!.at).toBeLessThan(60);
    await sleep(400);
    expect(spoken.map((s) => s.text)).toEqual(['Sam, you are up.', 'cloud']); // the reaction arrives late, then plays
  });
  it('a late flavor line is dropped if a newer interaction started before it was ready', async () => {
    const tr = new Tracer(); const id = tr.start('voice');
    const { sp, spoken } = rig({ route: () => 'cloud-late', synth: async () => { await sleep(80); return blob(); } });
    sp.speak('Nice play.', { trace: tr.ref(id), kind: 'reaction' });
    sp.newInteraction(); // someone moved again
    await sleep(200);
    expect(spoken).toEqual([]);
    expect(tr.get(id)!.lines[0]!.meta.skipped).toBe('stale');
    expect(lineInfoOf(tr.get(id)!)[0]!.skipped).toBe('stale');
  });
  it('a late flavor line is dropped after the late limit, using the injected clock', async () => {
    let now = 1_000;
    const { sp, spoken } = rig({ route: () => 'cloud-late', now: () => now, synth: async () => { await sleep(30); now += LATE_MAX_MS + 1; return blob(); } });
    sp.speak('Too slow.', { kind: 'reaction' });
    await sleep(120);
    expect(spoken).toEqual([]);
  });
  it('a late flavor line that fails is skipped silently, with no slower second attempt on the device voice', async () => {
    const tr = new Tracer(); const id = tr.start('voice');
    const { sp, spoken } = rig({ route: () => 'cloud-late', synth: async () => { throw new Error('boom'); } });
    sp.speak('Nice.', { trace: tr.ref(id), kind: 'reaction' });
    await sleep(80);
    expect(spoken).toEqual([]);
    expect(tr.get(id)!.lines[0]!.meta.skipped).toBe('lazybird-failed');
  });
  it('blocking Lazybird lines keep their order, and a failure falls back to the device voice', async () => {
    let n = 0;
    const { sp, spoken } = rig({ route: () => 'cloud-block', synth: async (text) => { n++; if (text === 'bad') throw new Error('x'); await sleep(text === 'first' ? 80 : 10); return blob(); } });
    sp.speak('first', {}); sp.speak('bad', {}); sp.speak('third', {});
    await sleep(300);
    expect(n).toBe(3); // all three requested up front (pipelined)
    expect(spoken.map((s) => s.text)).toEqual(['cloud', 'bad', 'cloud']); // spoken in order; the failed one on-device
  });
  it('stop() makes pending late lines stale and clears the queue', async () => {
    const { sp, spoken } = rig({ route: () => 'cloud-late', synth: async () => { await sleep(60); return blob(); } });
    sp.speak('Nice.', { kind: 'reaction' });
    sp.stop();
    await sleep(150);
    expect(spoken).toEqual([]);
  });
  it('falls back to the device voice when Lazybird is not configured even if the route says cloud', async () => {
    const sp = new Speaker({ route: () => 'cloud-block', fallback: async (t, _s, on) => { spoken.push(t); on?.(); } });
    const spoken: string[] = [];
    sp.speak('hello', { kind: 'reaction' });
    await sleep(30);
    expect(spoken).toEqual(['hello']);
  });
});

describe('Speaker + audio cache', () => {
  it('first time: miss -> synthesize -> store. Second time: hit, no request, near-instant', async () => {
    const cache = new AudioCache(memoryStore());
    const tr = new Tracer(); const a = tr.start('voice'); const b = tr.start('voice');
    const { sp, synth } = rig({ route: () => 'cloud-block', cache, voiceId: 'v1' });
    sp.speak('Nice play, Sam.', { trace: tr.ref(a), kind: 'reaction' });
    await sleep(200);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(tr.get(a)!.lines[0]!.meta.cache).toBe('miss');
    sp.speak('Nice play, Sam.', { trace: tr.ref(b), kind: 'reaction' });
    await sleep(120);
    expect(synth).toHaveBeenCalledTimes(1); // served from cache
    const l = tr.get(b)!.lines[0]!;
    expect(l.meta.cache).toBe('hit');
    const first = Object.fromEntries(stagesOf(tr.get(a)!).map((s) => [s.key, s.ms]));
    const second = Object.fromEntries(stagesOf(tr.get(b)!).map((s) => [s.key, s.ms]));
    expect(first.voiceFirstByte).toBeGreaterThanOrEqual(55); // a real round trip the first time
    expect(second.voiceFirstByte).toBeLessThan(15); // effectively none from the cache
    expect(lineInfoOf(tr.get(b)!)[0]!.cache).toBe('hit');
  });
  it('the cache is per voice and per text/ssml; different voice or text is a miss', async () => {
    expect(cacheKey('v1', 'hi', false)).not.toBe(cacheKey('v2', 'hi', false));
    expect(cacheKey('v1', 'hi', false)).not.toBe(cacheKey('v1', 'hi', true));
    expect(cacheKey('v1', 'hi', false)).not.toBe(cacheKey('v1', 'ho', false));
  });
  it('a broken cache never breaks speech', async () => {
    const broken: BlobStore = { get: async () => { throw new Error('idb'); }, put: async () => { throw new Error('idb'); }, delete: async () => {}, entries: async () => { throw new Error('idb'); } };
    const { sp, spoken, synth } = rig({ route: () => 'cloud-block', cache: new AudioCache(broken), voiceId: 'v' });
    sp.speak('still works', { kind: 'reaction' });
    await sleep(150);
    expect(synth).toHaveBeenCalledOnce();
    expect(spoken.map((s) => s.text)).toEqual(['cloud']);
  });
});

describe('AudioCache (LRU)', () => {
  it('evicts the least recently used entry when over the entry limit, and a read refreshes recency', async () => {
    let t = 0; const c = new AudioCache(memoryStore(), { maxEntries: 3, maxBytes: 1e9 }, () => ++t);
    await c.put('a', blob()); await c.put('b', blob()); await c.put('c', blob());
    await c.get('a'); // a is now the most recent; b is the oldest
    await c.put('d', blob());
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('a')).toBeDefined(); expect(await c.get('c')).toBeDefined(); expect(await c.get('d')).toBeDefined();
  });
  it('evicts by total size too, and refuses a single clip bigger than the whole budget', async () => {
    let t = 0; const c = new AudioCache(memoryStore(), { maxEntries: 100, maxBytes: 10 }, () => ++t);
    await c.put('a', blob(4)); await c.put('b', blob(4)); await c.put('c', blob(4)); // 12 > 10: oldest goes
    expect(await c.get('a')).toBeUndefined();
    expect(await c.get('b')).toBeDefined();
    await c.put('huge', blob(50));
    expect(await c.get('huge')).toBeUndefined();
    await c.put('empty', new Blob([]));
    expect(await c.get('empty')).toBeUndefined();
  });
});

describe('heard-text log', () => {
  const e = (text: string, via: HeardEntry['via'], command = 'unknown'): HeardEntry => ({ text, via, command });
  it('keeps the last 20 and counts how each was understood', () => {
    let list: HeardEntry[] = [];
    for (let i = 0; i < 25; i++) list = addHeard(list, e(`t${i}`, i % 3 === 0 ? 'none' : 'grammar'));
    expect(list).toHaveLength(HEARD_CAP);
    expect(list[0]!.text).toBe('t5');
    expect(countHeard([e('a', 'grammar'), e('b', 'model'), e('c', 'none'), e('d', 'model')])).toEqual({ grammar: 1, model: 2, none: 1 });
  });
  it('transcripts are exported only when the user opts in; counts are always safe to share', () => {
    const heard = [e('whose go is it', 'model', 'turn'), e('banana', 'none')];
    const ctx = { userAgent: 'UA', mic: 'wake', commentary: 'canned', voice: 'lazybird' as const, speak: true };
    const without = JSON.stringify(exportResults([], ctx, { heard }));
    expect(without).not.toContain('whose go is it');
    expect(without).not.toContain('banana');
    expect(JSON.parse(without).heard).toEqual({ counts: { grammar: 0, model: 1, none: 1 } });
    const withText = JSON.parse(JSON.stringify(exportResults([], ctx, { heard, includeHeardText: true })));
    expect(withText.heard.entries).toHaveLength(2);
    expect(withText.heard.entries[0].text).toBe('whose go is it');
    expect(JSON.parse(JSON.stringify(exportResults([], ctx))).heard.counts).toEqual({ grammar: 0, model: 0, none: 0 });
  });
});

describe('resolveDetailed', () => {
  it('reports how a command was understood and the model time', async () => {
    expect(await resolveDetailed('whose turn', {})).toEqual({ cmd: { type: 'turn' }, via: 'grammar' });
    const m = await resolveDetailed('gimme another one', { apiKey: 'k', model: 'm', chatImpl: async () => { await sleep(15); return 'draw'; } });
    expect(m).toMatchObject({ cmd: { type: 'draw' }, via: 'model' });
    expect(m.modelMs).toBeGreaterThanOrEqual(10);
    expect(await resolveDetailed('banana', { apiKey: 'k', model: 'm', chatImpl: async () => 'none' })).toMatchObject({ cmd: { type: 'unknown' }, via: 'none' });
    expect((await resolveDetailed('banana', {})).via).toBe('none'); // no key: never calls out
    expect((await resolveDetailed('banana', { apiKey: 'k', model: 'm', chatImpl: async () => { throw new Error('x'); } })).via).toBe('none');
  });
});

describe('broader grammar', () => {
  it.each([
    ['who goes next', 'turn'], ["who's going", 'turn'], ['whose go is it', 'turn'], ['is it my turn', 'turn'], ["who's playing", 'turn'],
    ["who's leading", 'score'], ['how am I doing', 'score'], ['who is in the lead', 'score'],
    ['how many cards do I have', 'cards'], ['how many do I have', 'cards'],
    ["what's showing", 'top'], ['what card is up', 'top'],
  ])('%s -> %s', (text, type) => expect(parseCommand(text).type).toBe(type));
  it('does not steal draw or last card', () => {
    expect(parseCommand('draw').type).toBe('draw');
    expect(parseCommand('last card').type).toBe('callLast');
    expect(parseCommand('one card left').type).toBe('callLast');
  });
});

class FakeRec implements RecognitionLike {
  continuous = false; interimResults = false; lang = '';
  onresult: RecognitionLike['onresult'] = null; onend: RecognitionLike['onend'] = null; onerror: RecognitionLike['onerror'] = null;
  start = vi.fn(); stop = vi.fn();
  result(t: string, isFinal: boolean) { this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: t } }] }); }
}

describe('listener: interim results and discards', () => {
  it('turns interim results on, and reports each partial result', () => {
    const rec = new FakeRec(); const ev: string[] = [];
    new VoiceListener({ mode: 'wake', wakeWord: 'hey deck', onUtterance: () => {}, onTiming: (e) => ev.push(e), factory: () => rec }).start();
    expect(rec.interimResults).toBe(true);
    rec.result('hey', false); rec.result('hey deck whose', false);
    expect(ev).toEqual(['interim', 'interim']);
  });
  it('a partial result never triggers a command; only the final does', () => {
    const rec = new FakeRec(); const got: string[] = [];
    new VoiceListener({ mode: 'wake', wakeWord: 'hey deck', onUtterance: (t) => got.push(t), factory: () => rec }).start();
    rec.result('hey deck draw', false);
    expect(got).toEqual([]);
    rec.result('hey deck draw', true);
    expect(got).toEqual(['draw']);
  });
  it('reports discarded finals (no wake word, or muted) so stale timing marks can be cleared', () => {
    const rec = new FakeRec(); const discard = vi.fn(); const got: string[] = [];
    const l = new VoiceListener({ mode: 'wake', wakeWord: 'hey deck', onUtterance: (t) => got.push(t), onDiscard: discard, factory: () => rec });
    l.start();
    rec.result('just chatting about lunch', true);
    expect(discard).toHaveBeenCalledOnce(); expect(got).toEqual([]);
    l.muted = true;
    rec.result('hey deck draw', true);
    expect(discard).toHaveBeenCalledTimes(2); expect(got).toEqual([]);
  });
});

describe('interim marks as the start point', () => {
  const trace = (marks: Record<string, number>): Trace => ({ id: 1, label: 'voice', startedAt: 0, meta: {}, lines: [], marks: Object.entries(marks).map(([name, t]) => ({ name, t })) });
  it('with no speechend (wake-word mode) the last interim result starts the clock', () => {
    const t = trace({ firstInterim: 100, lastInterim: 900, final: 1500, screenUpdated: 1520 });
    expect(Object.fromEntries(stagesOf(t).map((s) => [s.key, s.ms])).recognizerFinalize).toBe(600);
    expect(headlineOf(t).toScreenMs).toBe(620);
  });
  it('speechend still wins when Chrome sends it', () => {
    const t = trace({ lastInterim: 900, speechEnd: 1000, final: 1500 });
    expect(Object.fromEntries(stagesOf(t).map((s) => [s.key, s.ms])).recognizerFinalize).toBe(500);
  });
  it('setMark replaces the previous interim time, so the LAST partial result is kept', () => {
    let now = 0; const tr = new Tracer(() => now); const id = tr.start('voice'); const ref = tr.ref(id);
    now = 10; ref.set('lastInterim'); now = 50; ref.set('lastInterim'); now = 90; ref.set('lastInterim');
    expect(tr.get(id)!.marks).toEqual([{ name: 'lastInterim', t: 90 }]);
  });
});
