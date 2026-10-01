import type { Action, ActionResult, Cartridge, Card, GameState, Player, PlayerId, Rng } from '../engine/types';
import { STANDARD_DECK, shuffle } from '../engine/deck';
import { advance, createTurn, currentPlayer, reverse, skip } from '../engine/turns';

/** Original name (Uno is a Mattel trademark); placeholder until the brief's naming step. */
export const MATCHING_NAME = 'Match Up';

export const SKIP = 11;
export const REVERSE = 12;
export const DRAW_TWO = 13;

export function handSizeFor(playerCount: number): number {
  return playerCount <= 4 ? 7 : playerCount <= 6 ? 5 : 4;
}

export function cardPoints(card: Card): number {
  return Math.min(card.number, 10);
}

export function isPlayable(card: Card, top: Card, pendingDraw: number): boolean {
  if (pendingDraw > 0) return card.number === DRAW_TWO; // only a stack can answer a stack
  return card.number === top.number || card.suit === top.suit;
}

const name = (s: GameState, id: PlayerId) => s.players.find((p) => p.id === id)?.name ?? id;
const topOf = (s: GameState) => s.public.discard[s.public.discard.length - 1] as Card;

function sync(s: GameState): void {
  s.public.drawPileCount = s.hidden.drawPile.length;
  for (const p of s.players) s.public.handCounts[p.id] = s.private[p.id]?.hand.length ?? 0;
}

function logLine(s: GameState, line: string): void {
  s.public.log.push(line);
  if (s.public.log.length > 200) s.public.log.shift();
}

function drawCards(s: GameState, player: PlayerId, n: number, rng: Rng): number {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (s.hidden.drawPile.length === 0) {
      const top = s.public.discard.pop() as Card;
      s.hidden.drawPile = shuffle(s.public.discard, rng);
      s.public.discard = [top];
    }
    const card = s.hidden.drawPile.pop();
    if (!card) break;
    s.private[player]?.hand.push(card);
    drawn++;
  }
  return drawn;
}

function setup(players: Player[], rng: Rng): GameState {
  const pile = shuffle(STANDARD_DECK, rng);
  const private_: GameState['private'] = {};
  const size = handSizeFor(players.length);
  for (const p of players) private_[p.id] = { hand: pile.splice(-size) };

  // Start on a plain number card so nobody opens under a penalty.
  let guard = 0;
  while ((pile[pile.length - 1] as Card).number > 10 && guard++ < 100) {
    pile.unshift(pile.pop() as Card);
  }
  const first = pile.pop() as Card;

  const state: GameState = {
    cartridgeId: 'matching',
    players,
    public: {
      status: 'playing',
      turn: createTurn(players.map((p) => p.id)),
      discard: [first],
      drawPileCount: 0,
      handCounts: {},
      pendingDraw: 0,
      lastCardPending: null,
      scores: Object.fromEntries(players.map((p) => [p.id, 0])),
      winner: null,
      log: [],
    },
    private: private_,
    hidden: { drawPile: pile },
  };
  sync(state);
  logLine(state, `Game on! ${name(state, currentPlayer(state.public.turn))} goes first.`);
  return state;
}

/** A player who reached one card and never called it draws two once play moves on. */
function settleLastCard(s: GameState, actor: PlayerId, rng: Rng): void {
  const pending = s.public.lastCardPending;
  if (!pending) return;
  s.public.lastCardPending = null;
  if (pending !== actor) {
    const n = drawCards(s, pending, 2, rng);
    logLine(s, `${name(s, pending)} forgot to call last card and draws ${n}.`);
  }
}

function fail(state: GameState, message: string): ActionResult {
  return { ok: false, state, message };
}

function reduce(prev: GameState, action: Action, rng: Rng): ActionResult {
  if (prev.public.status === 'finished') return fail(prev, 'The game is over.');
  const s = structuredClone(prev);
  const pub = s.public;
  const who = name(s, action.player);

  if (action.type === 'callLast') {
    if (pub.lastCardPending !== action.player) return fail(prev, `${who} has nothing to call.`);
    pub.lastCardPending = null;
    logLine(s, `${who}: last card!`);
    return { ok: true, state: s, message: `${who} calls last card.` };
  }

  if (currentPlayer(pub.turn) !== action.player) {
    return fail(prev, `It's ${name(s, currentPlayer(pub.turn))}'s turn, not ${who}'s.`);
  }
  const hand = (s.private[action.player] as GameState['private'][string]).hand;
  const top = topOf(s);

  if (action.type === 'draw') {
    if (pub.pendingDraw === 0 && hand.some((c) => isPlayable(c, top, 0))) {
      return fail(prev, `${who} has a playable card and can't draw.`);
    }
    settleLastCard(s, action.player, rng);
    const owed = pub.pendingDraw || 1;
    const n = drawCards(s, action.player, owed, rng);
    pub.pendingDraw = 0;
    pub.turn = advance(pub.turn);
    logLine(s, `${who} draws ${n}.`);
    sync(s);
    return { ok: true, state: s, message: `${who} draws ${n}.` };
  }

  // play
  const card = hand.find((c) => c.id === action.cardId);
  if (!card) return fail(prev, `${action.cardId} isn't in ${who}'s hand.`);
  if (!isPlayable(card, top, pub.pendingDraw)) {
    return fail(
      prev,
      pub.pendingDraw > 0
        ? `${who} must play a 13 to stack, or draw ${pub.pendingDraw}.`
        : `${card.id} doesn't match ${top.id}.`,
    );
  }
  settleLastCard(s, action.player, rng);
  hand.splice(hand.indexOf(card), 1);
  pub.discard.push(card);
  logLine(s, `${who} plays ${card.id}.`);

  if (hand.length === 0) {
    const total = s.players
      .filter((p) => p.id !== action.player)
      .reduce((sum, p) => sum + (s.private[p.id]?.hand ?? []).reduce((a, c) => a + cardPoints(c), 0), 0);
    pub.status = 'finished';
    pub.winner = action.player;
    pub.scores[action.player] = (pub.scores[action.player] ?? 0) + total;
    logLine(s, `${who} wins and scores ${total}!`);
    sync(s);
    return { ok: true, state: s, message: `${who} wins!` };
  }
  if (hand.length === 1) pub.lastCardPending = action.player;

  if (card.number === SKIP) {
    pub.turn = skip(pub.turn);
    logLine(s, `${name(s, currentPlayer(advance(pub.turn, -1)))} is skipped.`);
  } else if (card.number === REVERSE) {
    pub.turn = reverse(pub.turn);
    // With two players a reverse hands the turn straight back.
    if (s.players.length > 2) pub.turn = advance(pub.turn);
    logLine(s, 'Direction reversed.');
  } else if (card.number === DRAW_TWO) {
    pub.pendingDraw += 2;
    pub.turn = advance(pub.turn);
    logLine(s, `${name(s, currentPlayer(pub.turn))} must play a 13 or draw ${pub.pendingDraw}.`);
  } else {
    pub.turn = advance(pub.turn);
  }
  sync(s);
  return { ok: true, state: s, message: `${who} plays ${card.id}.` };
}

function tapToAction(state: GameState, card: Card): Action {
  return { type: 'play', player: currentPlayer(state.public.turn), cardId: card.id };
}

export const matchingGame: Cartridge = {
  id: 'matching',
  name: MATCHING_NAME,
  description: 'Match the top card by number or shape. First to empty their hand wins.',
  players: { kind: 'range', min: 2, max: 10 },
  setup,
  reduce,
  tapToAction,
};
