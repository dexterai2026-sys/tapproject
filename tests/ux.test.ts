import { describe, expect, it, vi } from 'vitest';
import { cleanNames, clearGame, isOnboarded, loadDealSetup, loadGame, loadNames, loadTally, recordWin, resetTally, saveDealSetup, saveGame, saveNames, saveTally, setOnboarded, type Store } from '../src/save';
import { createFeedback, cueFor, type AudioCtxLike } from '../src/ui/feedback';
import { Onboarding } from '../src/ui/onboarding';
import { applyDisplay, displayAttrs } from '../src/ui/display';
import { matchingGame } from '../src/games/matching';
import { applyAction, startGame } from '../src/engine/engine';
import { mulberry32 } from '../src/engine/deck';
import { currentPlayer } from '../src/engine/turns';
import { ALL_CARD_IDS } from '../src/engine/deckConfig';

function memStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const players = [{ id: 'p0', name: 'Sam' }, { id: 'p1', name: 'Lee' }, { id: 'p2', name: 'Kai' }];

describe('pause / resume', () => {
  it('round-trips the exact mid-game state, then continues identically', () => {
    const store = memStore();
    const rng = mulberry32(5);
    let s = startGame(matchingGame, players, rng);
    for (let i = 0; i < 6; i++) {
      const p = currentPlayer(s.public.turn);
      const hand = s.private[p]!.hand;
      const play = hand.find((c) => applyAction(matchingGame, s, { type: 'play', player: p, cardId: c.id }, rng).ok);
      s = applyAction(matchingGame, s, play ? { type: 'play', player: p, cardId: play.id } : { type: 'draw', player: p }, rng).state;
    }
    saveGame({ cartridgeId: 'matching', players, realNfc: false, state: s }, store, 123);
    const loaded = loadGame(store)!;
    expect(loaded.state).toEqual(s);
    expect(loaded.savedAt).toBe(123);
    // restored state is playable: same legal move gives the same result either way
    const p = currentPlayer(s.public.turn);
    const act = { type: 'draw' as const, player: p };
    expect(applyAction(matchingGame, loaded.state, act, mulberry32(1)).ok).toBe(applyAction(matchingGame, s, act, mulberry32(1)).ok);
    clearGame(store);
    expect(loadGame(store)).toBeNull();
  });
  it('ignores corrupt or blocked storage', () => {
    const store = memStore();
    store.setItem('tap.savedGame.v1', '{not json');
    expect(loadGame(store)).toBeNull();
    store.setItem('tap.savedGame.v1', JSON.stringify({ cartridgeId: 'x' }));
    expect(loadGame(store)).toBeNull();
    expect(loadGame(null)).toBeNull();
    expect(() => saveGame({ cartridgeId: 'matching', players, realNfc: false, state: startGame(matchingGame, players, mulberry32(1)) }, null)).not.toThrow();
  });
});

describe('player names', () => {
  it('cleans, defaults and de-duplicates', () => {
    expect(cleanNames(['  Sam ', '', 'sam', 'Sam'])).toEqual(['Sam', 'Player 2', 'sam 2', 'Sam 3']);
    expect(cleanNames(['x'.repeat(40)])[0]).toHaveLength(16);
  });
  it('persists', () => {
    const store = memStore();
    saveNames(['A', 'B'], store);
    expect(loadNames(store)).toEqual(['A', 'B']);
    expect(loadNames(memStore())).toEqual([]);
  });
});

describe('game-night tally', () => {
  it('accumulates wins across games and resets', () => {
    const store = memStore();
    let t = loadTally(store);
    expect(t).toEqual({ games: 0, wins: {} });
    t = recordWin(recordWin(recordWin(t, 'Sam'), 'Lee'), 'Sam');
    saveTally(t, store);
    expect(loadTally(store)).toEqual({ games: 3, wins: { Sam: 2, Lee: 1 } });
    resetTally(store);
    expect(loadTally(store).games).toBe(0);
  });
});

describe('onboarding', () => {
  it('flag persists and replay clears it', () => {
    const store = memStore();
    expect(isOnboarded(store)).toBe(false);
    setOnboarded(true, store);
    expect(isOnboarded(store)).toBe(true);
    setOnboarded(false, store);
    expect(isOnboarded(store)).toBe(false);
  });
  it('guided tap then voice step, finishing once', () => {
    const done = vi.fn();
    const o = new Onboarding(true, true, done);
    expect(o.step).toBe('tap');
    o.onTap(false); // an illegal tap isn't the guided first tap
    expect(o.step).toBe('tap');
    o.onTap(true);
    expect(o.step).toBe('voice');
    expect(done).toHaveBeenCalledOnce(); // flag set after the guided tap, not after voice
    expect(o.message('hey deck', 'wake')).toContain('hey deck');
    expect(o.message('hey deck', 'push')).toContain('hold the mic');
    o.onVoiceCommand();
    expect(o.step).toBe('done');
    expect(done).toHaveBeenCalledOnce(); // not called twice
    expect(o.active).toBe(false);
  });
  it('skips the voice step when no mic is available; skip works; inactive stays done', () => {
    const d2 = vi.fn();
    const o = new Onboarding(false, true, d2);
    o.onTap(true);
    expect(o.step).toBe('done');
    expect(d2).toHaveBeenCalledOnce();
    const d3 = vi.fn();
    const s = new Onboarding(true, true, d3); s.skip();
    expect(s.step).toBe('done');
    expect(d3).toHaveBeenCalledOnce();
    expect(new Onboarding(true, false).active).toBe(false);
  });
});

describe('feedback cues', () => {
  it('has distinct success vs error cues, and styles differ per game', () => {
    const ok = cueFor('success', 'playful'), err = cueFor('error', 'playful');
    expect(ok.tones[0]!.freq).not.toBe(err.tones[0]!.freq);
    expect(ok.vibrate).not.toEqual(err.vibrate);
    expect(cueFor('win', 'playful').tones.length).toBeGreaterThan(ok.tones.length); // game moments are more elaborate
    expect(cueFor('success', 'dramatic')).not.toEqual(ok);
    expect(cueFor('error', 'dramatic')).not.toEqual(err);
  });
  function fakeCtx() {
    const started: { type: string; freq: number; at: number }[] = [];
    const ctx: AudioCtxLike = {
      currentTime: 0, destination: {}, resume: async () => {},
      createOscillator: () => {
        const o = { type: '', frequency: { value: 0 }, connect() {}, stop() {}, start(at: number) { started.push({ type: o.type, freq: o.frequency.value, at }); } };
        return o;
      },
      createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
    };
    return { ctx, started };
  }
  it('plays the cue tones in sequence and vibrates', () => {
    const { ctx, started } = fakeCtx();
    const vibrate = vi.fn();
    createFeedback({ sound: true, style: 'playful', ctxFactory: () => ctx, vibrate })('win');
    const cue = cueFor('win', 'playful');
    expect(started.map((s) => s.freq)).toEqual(cue.tones.map((t) => t.freq));
    expect(started.map((s) => s.type)).toEqual(cue.tones.map((t) => t.type));
    expect(started.every((s, i) => i === 0 || s.at > started[i - 1]!.at)).toBe(true); // sequential, not stacked
    expect(vibrate).toHaveBeenCalledWith(cue.vibrate);
  });
  it('sound off still vibrates but never touches audio; failures never throw', () => {
    const factory = vi.fn();
    const vibrate = vi.fn();
    createFeedback({ sound: false, style: 'playful', ctxFactory: factory, vibrate })('error');
    expect(factory).not.toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalled();
    expect(() => createFeedback({ sound: true, style: 'playful', ctxFactory: () => { throw new Error('blocked'); }, vibrate: () => { throw new Error('x'); } })('win')).not.toThrow();
  });
});

describe('display settings', () => {
  it('maps settings to root attributes, defaulting unknown sizes', () => {
    expect(displayAttrs({ textSize: 'XL', highContrast: true })).toEqual({ size: 'XL', contrast: 'high' });
    expect(displayAttrs({ textSize: 'M', highContrast: false })).toEqual({ size: 'M', contrast: 'normal' });
    expect(displayAttrs({ textSize: 'huge' as never, highContrast: false }).size).toBe('M');
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyDisplay({ textSize: 'L', highContrast: true }, root);
    expect(root.dataset).toMatchObject({ size: 'L', contrast: 'high' });
  });
});

describe('saved games carry the table; deal setup is remembered', () => {
  it('a saved game without a table (an older save) is ignored instead of crashing', () => {
    const store = memStore();
    store.setItem('tap.savedGame.v2', JSON.stringify({ cartridgeId: 'matching', players, realNfc: false, savedAt: 1, state: { public: { turn: {} } } }));
    expect(loadGame(store)).toBeNull();
    store.setItem('tap.savedGame.v1', JSON.stringify({ cartridgeId: 'matching' }));
    expect(loadGame(store)).toBeNull(); // the old key is not even read
  });
  it('a physical game round-trips with its simulated hands', () => {
    const store = memStore();
    const state = startGame(matchingGame, players, mulberry32(2), { mode: 'physical', knowledge: 'scanned', deck: ALL_CARD_IDS, handSize: 7 });
    saveGame({ cartridgeId: 'matching', players, realNfc: false, state, sim: { hands: { p0: [], p1: [], p2: [] }, pile: [], discard: [] } }, store, 5);
    const back = loadGame(store)!;
    expect(back.state.table.mode).toBe('physical');
    expect(back.sim).toEqual({ hands: { p0: [], p1: [], p2: [] }, pile: [], discard: [] });
  });
  it('deal setup defaults to count-only with every card, and ignores junk', () => {
    const store = memStore();
    expect(loadDealSetup(store)).toEqual({ deal: 'counts', excluded: [], players: 4 });
    saveDealSetup({ deal: 'scanned', excluded: ['star-7'], players: 4 }, store);
    expect(loadDealSetup(store)).toEqual({ deal: 'scanned', excluded: ['star-7'], players: 4 });
    store.setItem('tap.dealSetup.v1', JSON.stringify({ deal: 'banana', excluded: [1, 'x', null] }));
    expect(loadDealSetup(store)).toEqual({ deal: 'counts', excluded: ['x'], players: 4 });
    store.setItem('tap.dealSetup.v1', '{broken');
    expect(loadDealSetup(store)).toEqual({ deal: 'counts', excluded: [], players: 4 });
  });
  it('remembers the play-on switch only when it is on', () => {
    const store = memStore();
    expect('playOn' in loadDealSetup(store)).toBe(false);
    saveDealSetup({ deal: 'app', excluded: [], players: 4, playOn: true }, store);
    expect(loadDealSetup(store).playOn).toBe(true);
    store.setItem('tap.dealSetup.v1', JSON.stringify({ playOn: 'yes' }));
    expect('playOn' in loadDealSetup(store)).toBe(false);
  });
  it('remembers player count and the NFC choice; absent nfc stays absent', () => {
    const store = memStore();
    expect(loadDealSetup(store).players).toBe(4);
    expect('nfc' in loadDealSetup(store)).toBe(false);
    saveDealSetup({ deal: 'app', excluded: [], players: 6, nfc: true }, store);
    expect(loadDealSetup(store)).toEqual({ deal: 'app', excluded: [], players: 6, nfc: true });
    saveDealSetup({ deal: 'app', excluded: [], players: 3, nfc: false }, store);
    expect(loadDealSetup(store).nfc).toBe(false);
    for (const bad of [0, -2, 2.5, '5', null, 1000]) {
      store.setItem('tap.dealSetup.v1', JSON.stringify({ players: bad, nfc: 'yes' }));
      const d = loadDealSetup(store);
      expect(d.players).toBe(4);
      expect('nfc' in d).toBe(false);
    }
  });
});
