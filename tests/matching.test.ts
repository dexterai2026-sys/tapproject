import { describe, expect, it } from 'vitest';
import { matchingGame } from '../src/games/matching';
import { applyAction, handleTap, startGame, validatePlayerCount, viewFor } from '../src/engine/engine';
import { STANDARD_DECK, mulberry32, registerChip, resolveChip, simulatedChipId, simulatedChipMap } from '../src/engine/deck';
import { currentPlayer } from '../src/engine/turns';
import type { Card, GameState } from '../src/engine/types';

const rng = mulberry32(7);
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const card = (id: string) => STANDARD_DECK.find((c) => c.id === id) as Card;

/** A fixed scenario: top card star-5, given hands, a known draw pile. */
function scenario(hands: string[][], top = 'star-5', pile: string[] = ['circle-1', 'circle-2', 'circle-3', 'circle-4']): GameState {
  const s = startGame(matchingGame, mk(hands.length), rng);
  hands.forEach((h, i) => (s.private[`p${i}`] = { hand: h.map(card) }));
  s.public.discard = [card(top)];
  s.hidden.drawPile = pile.map(card);
  s.public.turn = { order: s.players.map((p) => p.id), index: 0, direction: 1 };
  s.public.pendingDraw = 0;
  s.public.lastCardPending = null;
  return s;
}
const play = (s: GameState, player: string, cardId: string) => applyAction(matchingGame, s, { type: 'play', player, cardId }, rng);
const draw = (s: GameState, player: string) => applyAction(matchingGame, s, { type: 'draw', player }, rng);

describe('setup', () => {
  it('deals and keeps hands out of the public view', () => {
    const s = startGame(matchingGame, mk(3), rng);
    expect(s.players.every((p) => s.private[p.id]?.hand.length === 7)).toBe(true);
    const total = 3 * 7 + s.hidden.drawPile.length + s.public.discard.length;
    expect(total).toBe(52);
    expect(s.public.discard[0]!.number).toBeLessThanOrEqual(10);
    const view = viewFor(s, 'p0');
    expect(view.private.hand).toHaveLength(7);
    expect(JSON.stringify(view.public)).not.toContain(s.private.p1!.hand[0]!.id + '"');
    expect('hidden' in view).toBe(false);
  });
  it('validates player count (2-10)', () => {
    expect(validatePlayerCount(matchingGame, 1)).not.toBeNull();
    expect(validatePlayerCount(matchingGame, 10)).toBeNull();
    expect(() => startGame(matchingGame, mk(11), rng)).toThrow();
  });
  it('deals a full 10-player game without running out', () => {
    const s = startGame(matchingGame, mk(10), rng);
    expect(s.hidden.drawPile.length).toBeGreaterThan(0);
  });
});

describe('play validation', () => {
  it('accepts a match by suit or number and rotates the turn', () => {
    const s = scenario([['star-9', 'circle-5', 'square-2'], ['circle-8']]);
    const r = play(s, 'p0', 'star-9');
    expect(r.ok).toBe(true);
    expect(currentPlayer(r.state.public.turn)).toBe('p1');
    expect(r.state.public.discard.at(-1)!.id).toBe('star-9');
    expect(play(s, 'p0', 'circle-5').ok).toBe(true);
  });
  it('rejects non-matching, out-of-turn and not-in-hand plays without changing state', () => {
    const s = scenario([['circle-9', 'star-2'], ['circle-8']]);
    for (const r of [play(s, 'p0', 'circle-9'), play(s, 'p1', 'circle-8'), play(s, 'p0', 'star-7')]) {
      expect(r.ok).toBe(false);
      expect(r.state).toBe(s);
    }
  });
});

describe('draw', () => {
  it('is only allowed with no playable card; passes the turn', () => {
    const s = scenario([['circle-9', 'star-2'], ['circle-8']]);
    expect(draw(s, 'p0').ok).toBe(false);
    const s2 = scenario([['circle-9', 'square-2'], ['circle-8']]);
    const r = draw(s2, 'p0');
    expect(r.ok).toBe(true);
    expect(r.state.private.p0!.hand).toHaveLength(3);
    expect(currentPlayer(r.state.public.turn)).toBe('p1');
  });
  it('reshuffles the discard pile when the draw pile runs out', () => {
    const s = scenario([['circle-9'], ['circle-8']], 'star-5', []);
    s.public.discard = [card('square-1'), card('square-2'), card('star-5')];
    const r = draw(s, 'p0');
    expect(r.ok).toBe(true);
    expect(r.state.private.p0!.hand).toHaveLength(2);
    expect(r.state.public.discard.map((c) => c.id)).toEqual(['star-5']);
  });
});

describe('special cards', () => {
  it('skip passes over the next player', () => {
    const s = scenario([['star-11', 'circle-1'], ['circle-8'], ['circle-9']]);
    expect(currentPlayer(play(s, 'p0', 'star-11').state.public.turn)).toBe('p2');
  });
  it('reverse flips direction (3+ players) and acts as skip for 2', () => {
    const s3 = scenario([['star-12', 'circle-1'], ['circle-8'], ['circle-9']]);
    const r3 = play(s3, 'p0', 'star-12');
    expect(currentPlayer(r3.state.public.turn)).toBe('p2');
    expect(r3.state.public.turn.direction).toBe(-1);
    const s2 = scenario([['star-12', 'circle-1'], ['circle-8']]);
    expect(currentPlayer(play(s2, 'p0', 'star-12').state.public.turn)).toBe('p0');
  });
  it('draw-two stacks and only a 13 can answer; otherwise draw the stack', () => {
    const s = scenario([['star-13', 'circle-1'], ['circle-13', 'circle-8'], ['circle-9']], 'star-5', [
      'circle-1', 'circle-2', 'circle-3', 'circle-4', 'square-1', 'square-2',
    ]);
    const a = play(s, 'p0', 'star-13').state;
    expect(a.public.pendingDraw).toBe(2);
    expect(play(a, 'p1', 'circle-8').ok).toBe(false);
    expect(draw(a, 'p1').state.private.p1!.hand).toHaveLength(4);
    const b = play(a, 'p1', 'circle-13').state;
    expect(b.public.pendingDraw).toBe(4);
    const c = draw(b, 'p2');
    expect(c.state.private.p2!.hand).toHaveLength(5);
    expect(c.state.public.pendingDraw).toBe(0);
  });
});

describe('last card + win', () => {
  it('flags a forgotten last-card call: next action penalises with draw 2', () => {
    const s = scenario([['star-9', 'circle-1'], ['circle-8', 'star-1']]);
    const a = play(s, 'p0', 'star-9').state;
    expect(a.public.lastCardPending).toBe('p0');
    const b = play(a, 'p1', 'star-1');
    expect(b.state.private.p0!.hand).toHaveLength(3);
    expect(b.state.public.lastCardPending).toBe('p1'); // p1 is now on one card itself
  });
  it('no penalty when last card is called', () => {
    const s = scenario([['star-9', 'circle-1'], ['circle-8', 'star-1']]);
    const a = play(s, 'p0', 'star-9').state;
    const called = applyAction(matchingGame, a, { type: 'callLast', player: 'p0' }, rng);
    expect(called.ok).toBe(true);
    expect(play(called.state, 'p1', 'star-1').state.private.p0!.hand).toHaveLength(1);
  });
  it('winning empties the hand, scores the others\' cards and ends the game', () => {
    const s = scenario([['star-9'], ['circle-8', 'circle-13']]);
    const r = play(s, 'p0', 'star-9');
    expect(r.state.public.status).toBe('finished');
    expect(r.state.public.winner).toBe('p0');
    expect(r.state.public.scores.p0).toBe(8 + 20);
    expect(play(r.state, 'p1', 'circle-8').ok).toBe(false);
  });
});

describe('tap pipeline + chip mapping', () => {
  it('resolves a simulated chip to the current player\'s play', () => {
    const map = simulatedChipMap();
    const s = scenario([['star-9', 'circle-1'], ['circle-8']]);
    const c = resolveChip(map, simulatedChipId('star-9'))!;
    expect(handleTap(matchingGame, s, c.id, rng).ok).toBe(true);
    expect(handleTap(matchingGame, s, 'circle-8', rng).ok).toBe(false); // p1's card, p0's turn
  });
  it('registerChip rebinds without duplicates', () => {
    let m = registerChip({}, 'AA', 'star-1');
    m = registerChip(m, 'BB', 'star-1');
    expect(m).toEqual({ BB: 'star-1' });
    expect(resolveChip(m, 'BB')!.id).toBe('star-1');
  });
});

describe('full simulated game', () => {
  it('plays to a finish with 4 players using a simple bot', () => {
    let s = startGame(matchingGame, mk(4), mulberry32(42));
    let steps = 0;
    while (s.public.status === 'playing' && steps++ < 2000) {
      const p = currentPlayer(s.public.turn);
      const hand = s.private[p]!.hand;
      const playable = hand.find((c) => play(s, p, c.id).ok);
      let r = playable ? play(s, p, playable.id) : draw(s, p);
      if (r.ok && r.state.public.lastCardPending) {
        r = applyAction(matchingGame, r.state, { type: 'callLast', player: p }, rng);
      }
      expect(r.ok).toBe(true);
      s = r.state;
    }
    expect(s.public.status).toBe('finished');
    expect(s.public.winner).not.toBeNull();
    const all = [...s.hidden.drawPile, ...s.public.discard, ...s.players.flatMap((p) => s.private[p.id]!.hand)];
    expect(new Set(all.map((c) => c.id)).size).toBe(52);
  });
});

describe('scoring', () => {
  it('numbers score face value; Skip, Reverse and +2 are worth 20', async () => {
    const { cardPoints } = await import('../src/games/matching');
    expect([1, 7, 10].map((n) => cardPoints({ id: 'x', number: n, suit: 'star' } as Card))).toEqual([1, 7, 10]);
    expect([11, 12, 13].map((n) => cardPoints({ id: 'x', number: n, suit: 'star' } as Card))).toEqual([20, 20, 20]);
  });
  it('a winning +2 still makes the next player draw two, and those cards count', () => {
    const s = scenario([['star-13'], ['circle-8'], ['star-1']], 'star-5', ['circle-4', 'circle-3']);
    const r = play(s, 'p0', 'star-13');
    expect(r.state.public.status).toBe('finished');
    expect(r.state.private.p1!.hand).toHaveLength(3);
    expect(r.state.public.pendingDraw).toBe(0);
    expect(r.state.public.scores.p0).toBe(8 + 4 + 3 + 1);
  });
});

describe('play on: the last player holding cards loses (3+ players)', () => {
  const playOn = (hands: string[][], top = 'star-5') => {
    const s = scenario(hands, top);
    s.table = { ...s.table, playOn: true };
    return s;
  };
  it('the first player out leaves the turn order and the game goes on', () => {
    const s = playOn([['star-9'], ['circle-8', 'circle-2'], ['star-1', 'star-2']]);
    const r = play(s, 'p0', 'star-9');
    expect(r.ok).toBe(true);
    expect(r.state.public.status).toBe('playing');
    expect(r.state.public.placings).toEqual(['p0']);
    expect(r.state.public.turn.order).toEqual(['p1', 'p2']);
    expect(currentPlayer(r.state.public.turn)).toBe('p1');
    expect(r.message).toMatch(/1st place/);
  });
  it('when one player is left they lose, the first one out wins, and the loser\'s hand is the score', () => {
    let s = playOn([['star-9'], ['star-8'], ['circle-1', 'circle-13']]);
    s = play(s, 'p0', 'star-9').state; // p0 out, p1 up
    const r = play(s, 'p1', 'star-8');
    expect(r.state.public.status).toBe('finished');
    expect(r.state.public.placings).toEqual(['p0', 'p1']);
    expect(r.state.public.winner).toBe('p0');
    expect(r.state.public.loser).toBe('p2');
    expect(r.state.public.scores.p0).toBe(1 + 20);
    expect(r.message).toMatch(/P2 is the last one holding cards/);
  });
  it('a Reverse with two left hands the turn straight back, and a +2 out of the game stays owed', () => {
    let s = playOn([['star-9'], ['star-12', 'circle-2'], ['star-1', 'star-2']]);
    s = play(s, 'p0', 'star-9').state; // order p1, p2
    const r = play(s, 'p1', 'star-12');
    expect(currentPlayer(r.state.public.turn)).toBe('p1');
    let t = playOn([['star-13'], ['circle-8', 'circle-2'], ['star-1', 'star-2']]);
    t = play(t, 'p0', 'star-13').state;
    expect(t.public.pendingDraw).toBe(2);
    expect(currentPlayer(t.public.turn)).toBe('p1');
  });
  it('with two players the switch does nothing: first out still wins at once', () => {
    const s = scenario([['star-9'], ['circle-8']]);
    s.table = { ...s.table, playOn: true };
    expect(play(s, 'p0', 'star-9').state.public.status).toBe('finished');
  });
});
