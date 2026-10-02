import { describe, expect, it, vi } from 'vitest';
import { Commentator, momentFor } from '../src/ai/commentator';
import { LINES, createLinePicker, fill } from '../src/ai/lines';
import { Speaker } from '../src/ai/speech';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import { matchingGame } from '../src/games/matching';
import { applyAction, startGame } from '../src/engine/engine';
import { STANDARD_DECK, mulberry32 } from '../src/engine/deck';
import type { Card, GameState } from '../src/engine/types';

const rng = mulberry32(3);
const card = (id: string) => STANDARD_DECK.find((c) => c.id === id) as Card;
function scenario(hands: string[][], top = 'star-5'): GameState {
  const s = startGame(matchingGame, hands.map((_, i) => ({ id: `p${i}`, name: `P${i}` })), rng);
  hands.forEach((h, i) => (s.private[`p${i}`] = { hand: h.map(card) }));
  s.public.discard = [card(top)];
  s.hidden.drawPile = ['circle-1', 'circle-2', 'circle-3', 'circle-4'].map(card);
  return s;
}
const play = (s: GameState, p: string, c: string) => {
  const a = { type: 'play' as const, player: p, cardId: c };
  return { a, r: applyAction(matchingGame, s, a, rng) };
};

describe('line pools', () => {
  it('has 20+ lines for the frequent moments and fills placeholders', () => {
    for (const m of ['turn', 'play', 'draw'] as const) expect(LINES[m].length).toBeGreaterThanOrEqual(20);
    expect(fill('Hi {name}', { name: 'Sam' })).toBe('Hi Sam');
  });
  it('never repeats the same line twice in a row', () => {
    const pick = createLinePicker(() => 0); // worst case: rng always same
    expect(pick('play', { name: 'A', card: 'x' })).not.toBe(pick('play', { name: 'A', card: 'x' }));
  });
});

describe('momentFor', () => {
  it('classifies results', () => {
    const s = scenario([['star-9', 'circle-1'], ['circle-8', 'star-11']]);
    const { a, r } = play(s, 'p0', 'star-9');
    expect(momentFor(s, a, r)).toBe('play');
    const bad = play(s, 'p1', 'circle-8');
    expect(momentFor(s, bad.a, bad.r)).toBeNull(); // rejected action: no commentary
    const win = play(scenario([['star-9'], ['circle-8']]), 'p0', 'star-9');
    expect(momentFor(scenario([['star-9'], ['circle-8']]), win.a, win.r)).toBe('win');
  });
});

function harness(over: Partial<Settings> = {}, chatImpl?: (o: never) => Promise<string>) {
  const settings = { ...DEFAULT_SETTINGS, ...over };
  const spoken: string[] = []; const kinds: string[] = []; const captions: string[] = []; const notices: string[] = [];
  const c = new Commentator({
    settings: () => settings,
    speak: (t, o) => { spoken.push(t); kinds.push(o?.kind ?? ''); },
    pick: (m, v) => `[${m}:${v.name}]`,
    caption: (t) => captions.push(t),
    notice: (m) => notices.push(m),
    chatImpl: chatImpl as never,
  });
  return { c, spoken, kinds, captions, notices };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Commentator', () => {
  const s = scenario([['star-9', 'circle-1'], ['circle-8']]);
  it('is silent when off or when the action was rejected', () => {
    const off = harness({ commentary: 'off' });
    const { a, r } = play(s, 'p0', 'star-9');
    off.c.onResult(s, a, r);
    const bad = play(s, 'p1', 'circle-8');
    const on = harness();
    on.c.onResult(s, bad.a, bad.r);
    expect(off.spoken.length + on.spoken.length).toBe(0);
  });
  it('canned mode speaks a pool line + the turn line and captions it, no AI call', () => {
    const chatImpl = vi.fn();
    const h = harness({ commentary: 'canned', openrouterKey: 'k' }, chatImpl);
    const { a, r } = play(s, 'p0', 'star-9');
    h.c.onResult(s, a, r);
    // Two separate lines: personality (reaction) and the functional "your turn" announcement.
    expect(h.spoken).toEqual(['[play:P0]', '[turn:P0]']);
    expect(h.kinds).toEqual(['reaction', 'turn']);
    expect(h.captions).toEqual(['[play:P0] [turn:P0]']); // the caption still reads as one sentence
    expect(h.captions).toHaveLength(1);
    expect(chatImpl).not.toHaveBeenCalled();
  });
  it('live mode uses the premium model for a play, then respects the cap', async () => {
    const chatImpl = vi.fn(async () => '"Spicy!"');
    const h = harness({ commentary: 'live', openrouterKey: 'k', premiumModel: 'prem', liveCap: 1 }, chatImpl);
    const { a, r } = play(s, 'p0', 'star-9');
    h.c.onResult(s, a, r); await tick();
    expect(chatImpl).toHaveBeenCalledOnce();
    expect((chatImpl.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe('prem');
    expect(h.spoken[0]).toContain('Spicy!');
    expect(h.spoken[1]).toBe('[turn:P0]');
    h.c.onResult(s, a, r); await tick(); // over cap -> canned
    expect(chatImpl).toHaveBeenCalledOnce();
    expect(h.spoken[2]).toContain('[play:P0]');
    expect(h.kinds.slice(0, 3)).toEqual(['reaction', 'turn', 'reaction']);
  });
  it('live failure falls back to the pool line and posts a notice', async () => {
    const h = harness({ commentary: 'live', openrouterKey: 'k' }, async () => { throw new Error('boom'); });
    const { a, r } = play(s, 'p0', 'star-9');
    h.c.onResult(s, a, r); await tick();
    expect(h.spoken[0]).toContain('[play:P0]');
    expect(h.notices[0]).toContain('boom');
  });
  it('live mode without a key stays canned', () => {
    const chatImpl = vi.fn();
    const h = harness({ commentary: 'live', openrouterKey: '' }, chatImpl);
    const { a, r } = play(s, 'p0', 'star-9');
    h.c.onResult(s, a, r);
    expect(chatImpl).not.toHaveBeenCalled();
    expect(h.spoken).toHaveLength(2); // reaction + turn line
  });
});

describe('Speaker', () => {
  it('speaks sequentially via cloud voice and falls back to browser voice on failure', async () => {
    const played: string[] = []; const fell: string[] = [];
    const sp = new Speaker({
      synth: async (t) => { if (t === 'bad') throw new Error('x'); return new Blob([t]); },
      playBlob: async (b) => { played.push(await b.text()); },
      fallback: async (t) => { fell.push(t); },
    });
    sp.speak('one'); sp.speak('bad'); sp.speak('two');
    await new Promise((r) => setTimeout(r, 20));
    expect(played).toEqual(['one', 'two']);
    expect(fell).toEqual(['bad']);
  });
  it('uses fallback with no cloud voice, uses plain text for SSML, drops stale lines, honors disabled and stop', async () => {
    const fell: string[] = [];
    const sp = new Speaker({ fallback: async (t) => { fell.push(t); await new Promise((r) => setTimeout(r, 5)); } });
    sp.speak('<speak>x</speak>', { ssml: true, plain: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    expect(fell).toEqual(['x']);
    fell.length = 0;
    for (const t of ['a', 'b', 'c', 'd', 'e']) sp.speak(t);
    await new Promise((r) => setTimeout(r, 60));
    expect(fell.length).toBeLessThanOrEqual(4); // oldest queued lines dropped
    expect(fell.at(-1)).toBe('e');
    sp.enabled = false; fell.length = 0; sp.speak('z');
    await new Promise((r) => setTimeout(r, 10));
    expect(fell).toEqual([]);
  });
  it('reports busy state', async () => {
    const busy: boolean[] = [];
    const sp = new Speaker({ fallback: async () => {}, onBusyChange: (b) => busy.push(b) });
    sp.speak('hi');
    await new Promise((r) => setTimeout(r, 10));
    expect(busy).toEqual([true, false]);
  });
});
