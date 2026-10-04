import { describe, expect, it } from 'vitest';
import { ALL_CARD_IDS, deckForCount, describeDeck, deckFromExcluded, excludedFromDeck, sanitizeDeck } from '../src/engine/deckConfig';
import { matchingGame, handSizeFor, nextScanner, planDeal } from '../src/games/matching';
import { applyAction, startGame } from '../src/engine/engine';
import { cardById, mulberry32 } from '../src/engine/deck';
import { currentPlayer } from '../src/engine/turns';
import { defaultTable, handCount, restockDue, syncCounts } from '../src/engine/table';
import { SimTable, syncSim } from '../src/ui/simTable';
import type { Action, Card, GameState, Knowledge, TableConfig } from '../src/engine/types';

const rng = () => mulberry32(11);
const names = ['Sam', 'Lee', 'Kai', 'Joy', 'Max', 'Ana', 'Bo', 'Cy', 'Di', 'Ed'];
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: names[i] as string }));
const table = (deck: string[], knowledge: Knowledge = 'counts', mode: 'physical' | 'virtual' = 'physical', handSize = 7): TableConfig => ({ mode, knowledge, deck, handSize });
const act = (s: GameState, a: Action, r = rng()) => applyAction(matchingGame, s, a, r);
const card = (id: string) => cardById(id) as Card;
const pile = (s: GameState) => s.public.drawPileCount;
const invariant = (s: GameState) => expect(pile(s) + s.public.discard.length + s.players.reduce((n, p) => n + handCount(s, p.id), 0)).toBe(s.table.deck.length);

describe('deck in play (open-ended)', () => {
  it('any count from 0 to 52; the highest numbers go first, so 40 cards is numbers 1-10 in every shape', () => {
    expect(deckForCount(52)).toEqual(ALL_CARD_IDS);
    expect(deckForCount(99)).toHaveLength(52);
    expect(deckForCount(-3)).toEqual([]);
    const forty = deckForCount(40);
    expect(forty).toHaveLength(40);
    expect(new Set(forty.map((id) => cardById(id)!.number))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(describeDeck(forty)).toBe('40 cards: numbers 1-10 in all 4 shapes');
  });
  it('an odd count removes within the top number, last shape first', () => {
    const d = deckForCount(42);
    expect(d).toHaveLength(42);
    expect(d).toContain('circle-11'); expect(d).toContain('triangle-11');
    expect(d).not.toContain('square-11'); expect(d).not.toContain('star-11');
    expect(d).not.toContain('circle-12');
  });
  it('counts of every size produce exactly that many distinct real cards', () => {
    for (let n = 0; n <= 52; n++) { const d = deckForCount(n); expect(d).toHaveLength(n); expect(new Set(d).size).toBe(n); }
  });
  it('excluded <-> deck round-trip, sanitizing junk and duplicates and keeping canonical order', () => {
    expect(deckFromExcluded(['star-7'])).toHaveLength(51);
    expect(excludedFromDeck(deckFromExcluded(['star-7', 'circle-1']))).toEqual(['circle-1', 'star-7']);
    expect(sanitizeDeck(['star-7', 'nope', 'star-7', 'circle-1'])).toEqual(['circle-1', 'star-7']);
  });
  it('describes a deck with one lost card, and an irregular one, readably', () => {
    expect(describeDeck(ALL_CARD_IDS)).toBe('All 52 cards');
    expect(describeDeck(deckFromExcluded(['star-7']))).toBe('51 cards (missing star-7)');
    expect(describeDeck([])).toBe('No cards');
    // a short deck that has also lost a card: the range, then what is missing inside it
    expect(describeDeck(deckForCount(40).filter((id) => id !== 'star-7'))).toBe('39 cards: numbers 1-10, missing star-7');
    expect(describeDeck(deckForCount(40).filter((id) => !['star-7', 'circle-2'].includes(id)))).toBe('38 cards: numbers 1-10, missing circle-2, star-7');
    expect(describeDeck(['circle-1', 'star-9'])).toContain('2 cards');
  });
});

describe('planDeal', () => {
  it('matches the usual table sizes with a full deck', () => {
    expect(planDeal(4, 52)).toEqual({ handSize: 7, pile: 23 });
    expect(planDeal(6, 52)).toEqual({ handSize: 5, pile: 21 });
    expect(planDeal(10, 52)).toEqual({ handSize: 4, pile: 11 });
  });
  it('shrinks the hand for a smaller deck, and refuses when the deck is too small', () => {
    expect(planDeal(4, 40)).toEqual({ handSize: 7, pile: 11 });
    expect(planDeal(4, 20)).toEqual({ handSize: 4, pile: 3 });
    expect(planDeal(8, 20)).toHaveProperty('error');
    expect(planDeal(2, 7)).toHaveProperty('error');
    expect(handSizeFor(4, 3)).toBe(0);
  });
  it('the plan agrees with the real deal in both modes', () => {
    for (const mode of ['virtual', 'physical'] as const) {
      for (const [n, size] of [[2, 52], [4, 40], [3, 20], [7, 52], [10, 52]] as const) {
        const deck = deckForCount(size);
        const plan = planDeal(n, deck.length) as { handSize: number; pile: number };
        let s = startGame(matchingGame, mk(n), rng(), table(deck, 'counts', mode, plan.handSize));
        if (mode === 'physical') s = act(s, { type: 'flip', cardId: deck.find((id) => cardById(id)!.number <= 10 && id !== deck[0])! }).state;
        expect(s.players.every((p) => handCount(s, p.id) === plan.handSize)).toBe(true);
        expect(pile(s)).toBe(plan.pile);
        invariant(s);
      }
    }
  });
});

describe('virtual dealing with a custom deck', () => {
  it('deals only from the cards in play and never loses or invents a card', () => {
    const deck = deckForCount(32);
    const s = startGame(matchingGame, mk(3), rng(), table(deck, 'counts', 'virtual', 7));
    const all = [...s.hidden.drawPile, ...s.public.discard, ...s.players.flatMap((p) => s.private[p.id]!.hand)].map((c) => c.id).sort();
    expect(all).toEqual([...deck].sort());
    expect(s.public.drawPileCount).toBe(32 - 21 - 1);
  });
  it('rejects a tap of a card that is not in the deck being played', () => {
    const s = startGame(matchingGame, mk(2), rng(), table(deckForCount(40), 'counts', 'virtual', 7));
    const r = act(s, { type: 'play', player: currentPlayer(s.public.turn), cardId: 'star-13' });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('star-13 was left out of this game (40 cards in play).');
  });
  it('lets a left-out card be added back, keeping the pile count honest', () => {
    const s = startGame(matchingGame, mk(2), rng(), table(deckForCount(40), 'counts', 'virtual', 7));
    const r = act(s, { type: 'addCard', cardId: 'star-13' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.table.deck).toHaveLength(41);
    expect(r.state.table.deck).toContain('star-13');
    expect(act(r.state, { type: 'addCard', cardId: 'star-13' }).ok).toBe(false);
    expect(act(s, { type: 'addCard', cardId: 'nope' }).ok).toBe(false);
  });
  it('refuses to start when there are not enough cards', () => {
    expect(() => startGame(matchingGame, mk(8), rng(), table(deckForCount(20), 'counts', 'virtual', 4))).toThrow(/Not enough cards/);
  });
});

describe('physical table: counts only', () => {
  const start = () => startGame(matchingGame, mk(3), rng(), table(ALL_CARD_IDS, 'counts'));
  const playing = (flip = 'star-5') => act(start(), { type: 'flip', cardId: flip }).state;

  it('starts in setup: counts known, no identities, pile derived', () => {
    const s = start();
    expect(s.public.status).toBe('setup');
    expect(s.players.map((p) => handCount(s, p.id))).toEqual([7, 7, 7]);
    expect(s.players.every((p) => s.private[p.id]!.hand.length === 0)).toBe(true);
    expect(pile(s)).toBe(52 - 21);
    expect(s.public.discard).toEqual([]);
    invariant(s);
  });
  it('cannot play or draw before the first card is flipped', () => {
    const s = start();
    for (const a of [{ type: 'play', player: 'p0', cardId: 'star-5' }, { type: 'draw', player: 'p0' }] as Action[]) {
      const r = act(s, a); expect(r.ok).toBe(false); expect(r.message).toMatch(/flip the first card/); expect(r.state).toBe(s);
    }
  });
  it('flip: a special card is refused (put it back), a normal card starts the game', () => {
    const s = start();
    const bad = act(s, { type: 'flip', cardId: 'star-13' });
    expect(bad.ok).toBe(false); expect(bad.message).toMatch(/special card/);
    const ok = act(s, { type: 'flip', cardId: 'star-5' });
    expect(ok.ok).toBe(true);
    expect(ok.state.public.status).toBe('playing');
    expect(ok.state.public.discard.map((c) => c.id)).toEqual(['star-5']);
    expect(pile(ok.state)).toBe(52 - 21 - 1);
    expect(act(ok.state, { type: 'flip', cardId: 'star-6' }).message).toMatch(/already started/);
    expect(act(s, { type: 'flip', cardId: 'nope' }).ok).toBe(false);
  });
  it('a play of an unidentified card matching the top is accepted: count drops, pile unchanged, identity goes to the discard', () => {
    const s = playing();
    const r = act(s, { type: 'play', player: 'p0', cardId: 'star-9' });
    expect(r.ok).toBe(true);
    expect(handCount(r.state, 'p0')).toBe(6);
    expect(r.state.public.discard.at(-1)!.id).toBe('star-9');
    expect(pile(r.state)).toBe(pile(s));
    expect(currentPlayer(r.state.public.turn)).toBe('p1');
    invariant(r.state);
  });
  it('still enforces matching, turn order, and that a card already on the pile cannot be played again', () => {
    const s = playing();
    expect(act(s, { type: 'play', player: 'p0', cardId: 'circle-9' }).message).toMatch(/doesn't match/);
    expect(act(s, { type: 'play', player: 'p1', cardId: 'star-9' }).message).toMatch(/turn/);
    const a = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    const dup = act(a, { type: 'play', player: 'p1', cardId: 'star-9' });
    expect(dup.ok).toBe(false); expect(dup.message).toMatch(/already on the pile/);
    expect(act(a, { type: 'play', player: 'p1', cardId: 'star-5' }).message).toMatch(/already on the pile/); // the flipped card too
  });
  it('draw is allowed (honor system): count +1, pile -1, turn passes', () => {
    const s = playing();
    const r = act(s, { type: 'draw', player: 'p0' });
    expect(r.ok).toBe(true);
    expect(handCount(r.state, 'p0')).toBe(8);
    expect(pile(r.state)).toBe(pile(s) - 1);
    expect(currentPlayer(r.state.public.turn)).toBe('p1');
    invariant(r.state);
  });
  it('a +2 stack: the next player draws the pending cards, counts follow', () => {
    const s = playing('star-5');
    const a = act(s, { type: 'play', player: 'p0', cardId: 'star-13' }).state;
    expect(a.public.pendingDraw).toBe(2);
    expect(act(a, { type: 'play', player: 'p1', cardId: 'star-9' }).ok).toBe(false);
    const b = act(a, { type: 'draw', player: 'p1' }).state;
    expect(handCount(b, 'p1')).toBe(9);
    expect(b.public.pendingDraw).toBe(0);
    invariant(b);
  });
  it('last card is derived from the count; forgetting to call it costs two cards', () => {
    let s = playing('star-5');
    s.private.p0!.unknown = 2; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    expect(s.public.lastCardPending).toBe('p0');
    s = act(s, { type: 'play', player: 'p1', cardId: 'star-1' }).state; // p1 acts without p0 having called it
    expect(handCount(s, 'p0')).toBe(3);
    expect(s.public.lastCardPending).toBeNull();
    invariant(s);
  });
  it('count hits zero -> the table must confirm; other actions are refused until then', () => {
    let s = playing('star-5');
    s.private.p0!.unknown = 1; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    expect(s.public.status).toBe('confirming');
    expect(s.public.winner).toBeNull();
    expect(s.public.pendingWin).toBe('p0');
    for (const a of [{ type: 'play', player: 'p1', cardId: 'star-1' }, { type: 'draw', player: 'p1' }] as Action[]) {
      const r = act(s, a); expect(r.ok).toBe(false); expect(r.message).toMatch(/Confirm whether Sam is out/);
    }
  });
  it('denying the win puts the card back in their count and play continues', () => {
    let s = playing('star-5');
    s.private.p0!.unknown = 1; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    const turnBefore = currentPlayer(s.public.turn);
    const r = act(s, { type: 'confirm', ok: false });
    expect(r.ok).toBe(true);
    expect(r.state.public.status).toBe('playing');
    expect(handCount(r.state, 'p0')).toBe(1);
    expect(currentPlayer(r.state.public.turn)).toBe(turnBefore);
    invariant(r.state);
  });
  it('confirming a win moves to scoring: tap the leftover cards, each once, then finish', () => {
    let s = playing('star-5');
    s.private.p0!.unknown = 1; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    s = act(s, { type: 'confirm', ok: true }).state;
    expect(s.public.status).toBe('scoring');
    expect(s.public.winner).toBe('p0');
    s = act(s, { type: 'score', cardId: 'circle-13' }).state; // worth 20
    s = act(s, { type: 'score', cardId: 'square-4' }).state;
    expect(s.public.scores.p0).toBe(24);
    expect(act(s, { type: 'score', cardId: 'circle-13' }).message).toMatch(/already counted/);
    expect(act(s, { type: 'score', cardId: 'star-9' }).message).toMatch(/was played/);
    expect(act(s, { type: 'play', player: 'p1', cardId: 'star-1' }).message).toMatch(/Score the leftover/);
    s = act(s, { type: 'finishScoring' }).state;
    expect(s.public.status).toBe('finished');
    expect(act(s, { type: 'score', cardId: 'square-5' }).ok).toBe(false);
  });
  it('finishing with no leftover taps simply scores zero', () => {
    let s = playing('star-5');
    s.private.p0!.unknown = 1; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    s = act(act(s, { type: 'confirm', ok: true }).state, { type: 'finishScoring' }).state;
    expect(s.public.scores.p0).toBe(0);
    expect(s.public.winner).toBe('p0');
  });
  it('adjust fixes a count (and the derived pile), refuses what is impossible, and is for real cards only', () => {
    const s = playing();
    const up = act(s, { type: 'adjust', player: 'p1', delta: 1 });
    expect(handCount(up.state, 'p1')).toBe(8);
    expect(pile(up.state)).toBe(pile(s) - 1);
    const down = act(up.state, { type: 'adjust', player: 'p1', delta: -2 });
    expect(handCount(down.state, 'p1')).toBe(6);
    expect(act(s, { type: 'adjust', player: 'p1', delta: -8 }).ok).toBe(false);
    expect(act(s, { type: 'adjust', player: 'p1', delta: 0 }).ok).toBe(false);
    expect(act(s, { type: 'adjust', player: 'p1', delta: 99 }).ok).toBe(false);
    const hog = structuredClone(s); hog.private.p1!.unknown = handCount(s, 'p1') + pile(s); syncCounts(hog);
    expect(act(hog, { type: 'adjust', player: 'p1', delta: 1 }).message).toMatch(/aren't that many cards/);
    const v = startGame(matchingGame, mk(2), rng());
    expect(act(v, { type: 'adjust', player: 'p0', delta: 1 }).message).toMatch(/app deals/);
  });
  it('the pile running out: the discard is reshuffled (top kept), counts stay consistent, and it says so', () => {
    const deck = deckForCount(20);
    let s = startGame(matchingGame, mk(2), rng(), table(deck, 'counts', 'physical', 7));
    s = act(s, { type: 'flip', cardId: deck[2]! }).state; // pile = 20 - 14 - 1 = 5
    expect(pile(s)).toBe(5);
    s.public.discard = [card('circle-1'), card('circle-2'), card('circle-3'), card(deck[2]!)]; // three cards were played before
    s.private.p0!.unknown = 7 - 3 + 0; // balance: those 3 left the hands
    s.private.p1!.unknown = 7; syncCounts(s);
    const before = pile(s);
    const r = act(s, { type: 'draw', player: 'p0' });
    expect(r.ok).toBe(true);
    expect(before).toBeGreaterThan(0);
    invariant(r.state);
    // Force an empty pile and draw: reshuffle kicks in
    const e = structuredClone(s); e.private.p0!.unknown = (e.private.p0!.unknown ?? 0) + pile(e); syncCounts(e);
    expect(pile(e)).toBe(0);
    const d = act(e, { type: 'draw', player: 'p0' });
    expect(d.ok).toBe(true);
    expect(d.message).toMatch(/reshuffle the discard pile, keeping the top card/);
    expect(d.state.public.discard).toHaveLength(1);
    expect(handCount(d.state, 'p0')).toBe(handCount(e, 'p0') + 1);
    invariant(d.state);
  });
  it('the whole game running out of cards is reported honestly', () => {
    const deck = deckForCount(11);
    let s = startGame(matchingGame, mk(2), rng(), table(deck, 'counts', 'physical', 3)); // 6 dealt, 1 flipped, 4 in pile
    s = act(s, { type: 'flip', cardId: deck[0]! }).state;
    s.private.p0!.unknown = (s.private.p0!.unknown ?? 0) + pile(s); syncCounts(s); // everything is in hands
    const r = act(s, { type: 'draw', player: 'p0' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Only 0 cards left in the whole game/);
    expect(handCount(r.state, 'p0')).toBe(handCount(s, 'p0'));
  });
});

describe('physical table: scanned hands', () => {
  const hands: Record<string, string[]> = { p0: ['star-9', 'circle-1', 'square-2'], p1: ['circle-8', 'star-1', 'square-3'] };
  const deck = deckForCount(40);
  const start = () => startGame(matchingGame, mk(2), rng(), table(deck, 'scanned', 'physical', 3));

  it('taps during setup scan cards into the first player who still has unscanned cards, in seat order', () => {
    let s = start();
    expect(nextScanner(s)).toBe('p0');
    expect(matchingGame.tapToAction(s, card('star-9'))).toEqual({ type: 'scan', player: 'p0', cardId: 'star-9' });
    for (const id of hands.p0!) s = act(s, matchingGame.tapToAction(s, card(id))).state;
    expect(s.private.p0!.hand.map((c) => c.id)).toEqual(hands.p0);
    expect(s.private.p0!.unknown).toBe(0);
    expect(nextScanner(s)).toBe('p1');
    for (const id of hands.p1!) s = act(s, matchingGame.tapToAction(s, card(id))).state;
    expect(nextScanner(s)).toBeNull();
    expect(matchingGame.tapToAction(s, card('star-5'))).toEqual({ type: 'flip', cardId: 'star-5' }); // everyone scanned: the next tap flips
    invariant(s);
  });
  it('refuses a card that is already scanned, in someone else\'s hand, not in the deck, or when the hand is complete', () => {
    let s = start();
    s = act(s, { type: 'scan', player: 'p0', cardId: 'star-9' }).state;
    expect(act(s, { type: 'scan', player: 'p0', cardId: 'star-9' }).message).toMatch(/already scanned/);
    expect(act(s, { type: 'scan', player: 'p1', cardId: 'star-9' }).message).toMatch(/in Sam's hand/);
    expect(act(s, { type: 'scan', player: 'p1', cardId: 'star-13' }).message).toMatch(/left out of this game/);
    for (const id of ['circle-1', 'square-2']) s = act(s, { type: 'scan', player: 'p0', cardId: id }).state;
    expect(act(s, { type: 'scan', player: 'p0', cardId: 'circle-3' }).message).toMatch(/no unscanned cards left/);
  });
  it('skipping a player keeps their cards as an unidentified count, and nextScanner moves on', () => {
    let s = start();
    s = act(s, { type: 'skipScan', player: 'p0' }).state;
    expect(nextScanner(s)).toBe('p1');
    expect(handCount(s, 'p0')).toBe(3);
    expect(s.private.p0!.hand).toEqual([]);
  });
  const ready = () => {
    let s = start();
    for (const [p, ids] of Object.entries(hands)) for (const id of ids) s = act(s, { type: 'scan', player: p, cardId: id }).state;
    return act(s, { type: 'flip', cardId: 'star-5' }).state;
  };
  it('with every card identified: ownership and the "draw only when stuck" rule are enforced', () => {
    const s = ready();
    expect(act(s, { type: 'play', player: 'p0', cardId: 'circle-8' }).message).toMatch(/That's Lee's card/);
    expect(act(s, { type: 'draw', player: 'p0' }).message).toMatch(/playable card and can't draw/); // star-9 matches star-5
    const ok = act(s, { type: 'play', player: 'p0', cardId: 'star-9' });
    expect(ok.ok).toBe(true);
    expect(ok.state.private.p0!.hand.map((c) => c.id)).toEqual(['circle-1', 'square-2']);
  });
  it('a draw asks the player to tap what they drew; the turn waits, then play continues', () => {
    let s = ready();
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state; // top star-9, p1: circle-8 no, star-1 yes...
    s = act(s, { type: 'play', player: 'p1', cardId: 'star-1' }).state; // now top star-1; p0: circle-1 matches number
    s = act(s, { type: 'play', player: 'p0', cardId: 'circle-1' }).state; // top circle-1; p1 has circle-8 (matches shape)
    // make p1 stuck by giving them a hand with nothing playable
    const stuck = structuredClone(s); stuck.private.p1 = { hand: [card('square-3')], unknown: 0 }; syncCounts(stuck);
    const d = act(stuck, { type: 'draw', player: 'p1' });
    expect(d.ok).toBe(true);
    expect(d.state.public.status).toBe('scanning');
    expect(d.state.public.scanning).toEqual({ player: 'p1', remaining: 1 });
    expect(act(d.state, { type: 'play', player: 'p0', cardId: 'square-2' }).message).toMatch(/Finish tapping the drawn cards/);
    expect(matchingGame.tapToAction(d.state, card('star-4'))).toEqual({ type: 'scan', player: 'p1', cardId: 'star-4' });
    const done = act(d.state, { type: 'scan', player: 'p1', cardId: 'star-4' }).state;
    expect(done.public.status).toBe('playing');
    expect(done.private.p1!.hand.map((c) => c.id)).toEqual(['square-3', 'star-4']);
    invariant(done);
  });
  it('skipping the scan of drawn cards returns to play with those cards counted but unidentified', () => {
    const s = ready();
    const stuck = structuredClone(s); stuck.private.p0 = { hand: [card('circle-1')], unknown: 0 }; syncCounts(stuck);
    const d = act(stuck, { type: 'draw', player: 'p0' }).state;
    expect(d.public.status).toBe('scanning');
    const sk = act(d, { type: 'skipScan', player: 'p0' }).state;
    expect(sk.public.status).toBe('playing');
    expect(handCount(sk, 'p0')).toBe(2);
    expect(sk.private.p0!.unknown).toBe(1);
  });
  it('winning with identified hands: the others\' leftover cards are scored automatically and the game finishes', () => {
    let s = ready();
    s.private.p0 = { hand: [card('star-9')], unknown: 0 }; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    expect(s.public.status).toBe('confirming');
    const c = act(s, { type: 'confirm', ok: true }).state;
    expect(c.public.status).toBe('finished'); // every other card was identified: nothing left to tap
    expect(c.public.scores.p0).toBe(8 + 1 + 3); // circle-8, star-1, square-3
  });
  it('a mix: identified leftovers are scored automatically, unidentified ones are tapped', () => {
    let s = ready();
    s.private.p0 = { hand: [card('star-9')], unknown: 0 };
    s.private.p1 = { hand: [card('circle-8')], unknown: 2 }; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    s = act(s, { type: 'confirm', ok: true }).state;
    expect(s.public.status).toBe('scoring');
    expect(s.public.scores.p0).toBe(8);
    expect(act(s, { type: 'score', cardId: 'circle-8' }).message).toMatch(/already counted/);
    s = act(s, { type: 'score', cardId: 'square-6' }).state;
    expect(s.public.scores.p0).toBe(14);
  });
});

describe('simulated physical table vs the engine (ground truth)', () => {
  /** People with real cards play a full game through taps only; after every step the engine's counts must equal reality. */
  function playOut(seed: number, nPlayers: number, deckSize: number, knowledge: Knowledge, calls = true, maxSteps = 4000, playOn = false): { finished: boolean; loser: string | null; steps: number; penalties: number } {
    const r = mulberry32(seed);
    const deck = deckForCount(deckSize);
    const plan = planDeal(nPlayers, deck.length) as { handSize: number; pile: number };
    const players = mk(nPlayers);
    let s = startGame(matchingGame, players, r, { ...table(deck, knowledge, 'physical', plan.handSize), ...(playOn ? { playOn: true } : {}) });
    const sim = new SimTable(deck.map(card), players.map((p) => p.id), plan.handSize, r);
    const step = (a: Action): GameState => {
      const res = applyAction(matchingGame, s, a, r);
      if (!res.ok) throw new Error(`seed ${seed}: engine refused a legal action ${JSON.stringify(a)}: ${res.message}`);
      const drawn = syncSim(sim, s, res.state, a);
      s = res.state;
      s = scanDrawn(s, drawn);
      return s;
    };
    const scanDrawn = (st: GameState, drawn: Record<string, Card[]>): GameState => {
      if (knowledge !== 'scanned') return st;
      let cur = st;
      // Only the player the table is waiting on taps their own drawn cards (penalty cards for others stay unidentified).
      const who = cur.public.scanning?.player;
      for (const c of who ? (drawn[who] ?? []) : []) {
        if (cur.public.status !== 'scanning') break;
        const res = applyAction(matchingGame, cur, matchingGame.tapToAction(cur, c), r);
        if (!res.ok) throw new Error(`seed ${seed}: scan refused: ${res.message}`);
        cur = res.state;
      }
      return cur;
    };
    const check = () => {
      for (const p of players) expect(handCount(s, p.id), `seed ${seed} hand ${p.id}`).toBe(sim.hands[p.id]!.length);
      expect(pile(s), `seed ${seed} pile`).toBe(sim.pile.length);
      expect(s.public.discard.at(-1)?.id).toBe(sim.discard.at(-1)?.id);
      invariant(s);
    };
    if (knowledge === 'scanned') for (const p of players) for (const c of sim.hands[p.id]!) s = applyAction(matchingGame, s, matchingGame.tapToAction(s, c), r).state;
    const first = sim.flip()!;
    step({ type: 'flip', cardId: first.id });
    check();
    let steps = 0;
    while (s.public.status !== 'finished' && steps++ < maxSteps) {
      const st = s.public.status;
      if (st === 'confirming') { step({ type: 'confirm', ok: true }); check(); continue; }
      if (st === 'scoring') {
        for (const c of sim.leftover(s.public.winner as string)) { const res = applyAction(matchingGame, s, matchingGame.tapToAction(s, c), r); if (res.ok) s = res.state; }
        s = applyAction(matchingGame, s, { type: 'finishScoring' }, r).state;
        continue;
      }
      const p = currentPlayer(s.public.turn);
      const top = s.public.discard.at(-1) as Card;
      const hand = sim.hands[p]!;
      const play = hand.find((c) => (s.public.pendingDraw > 0 ? c.number === 13 : c.number === top.number || c.suit === top.suit));
      if (play) step(matchingGame.tapToAction(s, play));
      else step({ type: 'draw', player: p });
      if (calls && s.public.lastCardPending) step({ type: 'callLast', player: s.public.lastCardPending });
      check();
    }
    return { finished: s.public.status === 'finished', loser: s.public.loser ?? null, steps, penalties: s.public.log.filter((l) => /forgot to call last card/.test(l)).length };
  }

  it.each([['counts'], ['scanned']] as const)('%s: counts, pile and discard match the real cards through whole games (many seeds, tables and deck sizes)', (knowledge) => {
    let finished = 0, total = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const nPlayers = 2 + (seed % 7);
      const deckSize = [52, 40, 32, 26, 52, 36][seed % 6]!;
      if ('error' in planDeal(nPlayers, deckSize)) continue;
      total++;
      if (playOut(seed, nPlayers, deckSize, knowledge).finished) finished++;
    }
    expect(total).toBeGreaterThan(40);
    expect(finished).toBe(total); // every game that can be played reaches a confirmed finish
  });
  it.each([['counts'], ['scanned']] as const)('%s: a tiny 10-card deck keeps running out and restocking, and every count still matches reality', (knowledge) => {
    let total = 0, finished = 0;
    for (let seed = 1; seed <= 90; seed++) {
      const nPlayers = 2 + (seed % 3);
      if ('error' in planDeal(nPlayers, 10)) continue;
      total++;
      if (playOut(seed, nPlayers, 10, knowledge, true, 600).finished) finished++;
    }
    expect(total).toBeGreaterThan(25);
    expect(finished).toBe(total);
  });
  it.each([['counts'], ['scanned']] as const)('%s: play-on games (last player holding cards loses) finish with a loser and the counts always match reality', (knowledge) => {
    let finished = 0, total = 0, withLoser = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const nPlayers = 3 + (seed % 4);
      if ('error' in planDeal(nPlayers, 52)) continue;
      total++;
      const out = playOut(seed, nPlayers, 52, knowledge, true, 4000, true);
      if (out.finished) finished++;
      if (out.loser) withLoser++;
    }
    expect(finished).toBe(total);
    expect(withLoser).toBe(total);
  });
  it('forgetting to call last card costs two cards, and the counts still match the real hands through every penalty', () => {
    // Bots that never call last card are penalized each time they reach one card, so these games cannot finish by design:
    // what matters is that the engine's counts, pile and discard stay equal to reality through all those penalty draws.
    let penalties = 0;
    for (let seed = 100; seed < 112; seed++) penalties += playOut(seed, 3, 52, seed % 2 ? 'counts' : 'scanned', false, 160).penalties;
    expect(penalties).toBeGreaterThan(10);
  });
});

describe('SimTable (the pretend people)', () => {
  const deck = () => deckForCount(52).map(card);
  it('deals real hands and a real pile that add up to the deck', () => {
    const t = new SimTable(deck(), ['a', 'b', 'c'], 7, mulberry32(3));
    expect(Object.values(t.hands).every((h) => h.length === 7)).toBe(true);
    expect(t.pile.length).toBe(52 - 21);
    const all = [...Object.values(t.hands).flat(), ...t.pile].map((c) => c.id);
    expect(new Set(all).size).toBe(52);
  });
  it('flip never starts the pile on a special card, and puts it back', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const t = new SimTable(deck(), ['a', 'b'], 7, mulberry32(seed));
      const before = t.pile.length;
      const c = t.flip()!;
      expect(c.number).toBeLessThanOrEqual(10);
      expect(t.pile.length).toBe(before - 1); // special cards were returned, not lost
      expect(t.discard).toEqual([c]);
    }
  });
  it('drawing from an empty pile reshuffles the discard pile, keeping the top card', () => {
    const t = new SimTable(deck().slice(0, 12), ['a', 'b'], 3, mulberry32(4)); // 6 dealt, 6 in the pile
    t.flip();
    t.pile.length = 0; // pretend it ran out
    t.discard = [card('circle-1'), card('circle-2'), card('circle-3')];
    const got = t.draw('a', 2);
    expect(got).toHaveLength(2);
    expect(t.discard.map((c) => c.id)).toEqual(['circle-3']);
    expect(t.pile).toHaveLength(0); // the two reshuffled cards were both drawn
  });
  it('drawing from a game with nothing left returns what exists', () => {
    const t = new SimTable(deck().slice(0, 7), ['a', 'b'], 3, mulberry32(4)); // 6 dealt, 1 left
    expect(t.draw('a', 5)).toHaveLength(1);
    expect(t.draw('a', 5)).toHaveLength(0);
  });
  it('snapshot and restore reproduce the exact table, and a restored copy is independent', () => {
    const t = new SimTable(deck(), ['a', 'b'], 7, mulberry32(8));
    t.flip(); t.play('a', t.hands.a![0]!.id);
    const snap = t.snapshot();
    const r = SimTable.restore(snap, mulberry32(9));
    expect(r.hands).toEqual(t.hands); expect(r.pile).toEqual(t.pile); expect(r.discard).toEqual(t.discard);
    r.draw('a', 3);
    expect(t.hands.a!.length).not.toBe(r.hands.a!.length);
    expect(t.play('a', 'not-a-card')).toBe(false);
  });
});

describe('restocking the draw pile', () => {
  it('flags a restock the moment the pile hits zero, counts each restock, and passes when nothing is left', () => {
    const deck = deckForCount(10);
    let s = startGame(matchingGame, mk(2), rng(), table(deck, 'counts', 'physical', 4)); // 8 dealt, 1 flipped, 1 in the pile
    s = act(s, { type: 'flip', cardId: deck[2]! }).state;
    expect(pile(s)).toBe(1);
    expect(restockDue(s)).toBe(false); // nothing to shuffle yet
    s.public.discard = [card('circle-1'), card('circle-2'), card(deck[2]!)];
    s.private.p0!.unknown = 3; s.private.p1!.unknown = 4; syncCounts(s); // one card each was played: 7 in hands + 3 on the pile = 10, nothing left to draw
    expect(pile(s)).toBe(0);
    expect(restockDue(s)).toBe(true);
    const d = act(s, { type: 'draw', player: currentPlayer(s.public.turn) });
    expect(d.ok).toBe(true);
    expect(d.state.public.reshuffles).toBe(1);
    expect(d.state.public.log.some((l) => /restock #1/.test(l))).toBe(true);
    expect(restockDue(d.state)).toBe(false);
  });
  it('a virtual game counts its restocks too', () => {
    let s = startGame(matchingGame, mk(2), rng(), table(deckForCount(10), 'counts', 'virtual', 4));
    for (let i = 0; i < 30 && !s.public.reshuffles; i++) {
      const p = currentPlayer(s.public.turn);
      const top = s.public.discard.at(-1) as Card;
      const play = s.private[p]!.hand.find((c) => c.number === top.number || c.suit === top.suit);
      const r = applyAction(matchingGame, s, play ? { type: 'play', player: p, cardId: play.id } : { type: 'draw', player: p }, rng());
      if (r.ok) s = r.state;
      if (s.public.status === 'finished') break;
    }
    expect(s.public.reshuffles ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe('physical table: winning +2 and play-on mode', () => {
  const base = (playOn: boolean) => {
    const t = table(ALL_CARD_IDS, 'counts');
    return act(startGame(matchingGame, mk(3), rng(), playOn ? { ...t, playOn: true } : t), { type: 'flip', cardId: 'star-5' }).state;
  };
  it('a winning +2: once confirmed, the next player draws the two cards before the points are counted', () => {
    let s = base(false);
    s.private.p0!.unknown = 1; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-13' }).state;
    expect(s.public.pendingDraw).toBe(2);
    const before = handCount(s, 'p1');
    s = act(s, { type: 'confirm', ok: true }).state;
    expect(handCount(s, 'p1')).toBe(before + 2);
    expect(s.public.pendingDraw).toBe(0);
    expect(s.public.status).toBe('scoring'); // the unidentified cards still need tapping
    invariant(s);
  });
  it('play-on: confirming a win keeps the game going; when one player is left the round goes to scoring with a named loser', () => {
    let s = base(true);
    s.private.p0!.unknown = 1; s.private.p1!.unknown = 1; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    s = act(s, { type: 'confirm', ok: true }).state;
    expect(s.public.status).toBe('playing');
    expect(s.public.placings).toEqual(['p0']);
    expect(s.public.turn.order).toEqual(['p1', 'p2']);
    s = act(s, { type: 'play', player: 'p1', cardId: 'star-8' }).state;
    s = act(s, { type: 'confirm', ok: true }).state;
    expect(s.public.placings).toEqual(['p0', 'p1']);
    expect(s.public.status).toBe('scoring');
    expect(s.public.winner).toBe('p0');
    expect(s.public.loser).toBe('p2');
    s = act(s, { type: 'score', cardId: 'circle-13' }).state;
    expect(s.public.scores.p0).toBe(20);
    expect(act(s, { type: 'finishScoring' }).state.public.status).toBe('finished');
  });
  it('play-on: denying a win still puts the card back and nobody leaves', () => {
    let s = base(true);
    s.private.p0!.unknown = 1; syncCounts(s);
    s = act(s, { type: 'play', player: 'p0', cardId: 'star-9' }).state;
    s = act(s, { type: 'confirm', ok: false }).state;
    expect(s.public.status).toBe('playing');
    expect(s.public.placings ?? []).toEqual([]);
    expect(s.public.turn.order).toHaveLength(3);
    expect(handCount(s, 'p0')).toBe(1);
  });
});
