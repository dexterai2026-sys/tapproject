import type { Action, ActionResult, Cartridge, Card, GameState, GameStatus, Player, PlayerId, Rng, TableConfig } from '../engine/types';
import { cardById, shuffle } from '../engine/deck';
import { ALL_CARD_IDS } from '../engine/deckConfig';
import { advance, createTurn, currentPlayer, reverse, skip } from '../engine/turns';
import { deckCards, deckHas, defaultTable, fullyKnown, handCount, inDiscard, knownOwner, knownPoints, outOfDeckMessage, physicalDraw, scanInto, syncCounts, unknownOf } from '../engine/table';

/** Original name (Uno is a Mattel trademark); placeholder until the brief's naming step. */
export const MATCHING_NAME = 'Match Up';

export const SKIP = 11;
export const REVERSE = 12;
export const DRAW_TWO = 13;

/** Cards each player is dealt: fewer for bigger tables, and never more than the cards in play allow. */
export function handSizeFor(playerCount: number, deckSize = 52): number {
  const base = playerCount <= 4 ? 7 : playerCount <= 6 ? 5 : 4;
  return Math.max(0, Math.min(base, Math.floor((deckSize - 2) / playerCount)));
}

const MIN_HAND = 3;

export function planDeal(playerCount: number, deckSize: number): { handSize: number; pile: number } | { error: string } {
  const handSize = handSizeFor(playerCount, deckSize);
  if (handSize < MIN_HAND) {
    return { error: `Not enough cards: ${playerCount} players need at least ${playerCount * MIN_HAND + 2} cards in play (${deckSize} selected).` };
  }
  return { handSize, pile: deckSize - playerCount * handSize - 1 }; // minus the card flipped to start the pile
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
const isPhysical = (s: GameState) => s.table.mode === 'physical';

function logLine(s: GameState, line: string): void {
  s.public.log.push(line);
  if (s.public.log.length > 200) s.public.log.shift();
}

/** The app dealing: draw from the app's own pile, reshuffling the discard when it runs out. */
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

/** Pick up cards for `player`, however the cards are being dealt. Returns how many, plus any instruction for the table. */
function pickUp(s: GameState, player: PlayerId, n: number, rng: Rng): { drawn: number; note: string } {
  if (!isPhysical(s)) return { drawn: drawCards(s, player, n, rng), note: '' };
  const r = physicalDraw(s, player, n);
  return { drawn: r.drawn, note: r.note };
}

function emptyPublic(players: Player[], status: GameStatus): GameState['public'] {
  return {
    status,
    turn: createTurn(players.map((p) => p.id)),
    discard: [],
    drawPileCount: 0,
    handCounts: {},
    pendingDraw: 0,
    lastCardPending: null,
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    winner: null,
    log: [],
    scanDone: [],
    scanning: null,
    pendingWin: null,
    scoredCards: [],
  };
}

function setup(players: Player[], rng: Rng, requested?: TableConfig): GameState {
  const deckIds = requested?.deck ?? defaultTable(0).deck;
  const plan = planDeal(players.length, deckIds.length);
  if ('error' in plan) throw new Error(plan.error);
  const wanted = requested?.handSize ?? plan.handSize;
  const handSize = wanted >= 1 && wanted * players.length + 2 <= deckIds.length ? wanted : plan.handSize;
  const table: TableConfig = requested ? { ...requested, handSize } : defaultTable(handSize);

  if (table.mode === 'physical') {
    const state: GameState = {
      cartridgeId: 'matching',
      players,
      public: emptyPublic(players, 'setup'),
      private: Object.fromEntries(players.map((p) => [p.id, { hand: [], unknown: handSize }])),
      hidden: { drawPile: [] },
      table,
    };
    syncCounts(state);
    logLine(state, `Deal ${handSize} cards to each player${table.knowledge === 'scanned' ? ', then everyone taps their cards' : ''}. Then flip the top card of the pile and tap it.`);
    return state;
  }

  const pile = shuffle(deckCards(table), rng);
  const private_: GameState['private'] = {};
  for (const p of players) private_[p.id] = { hand: pile.splice(-handSize) };
  // Start on a plain number card so nobody opens under a penalty.
  let guard = 0;
  while (pile.length > 1 && (pile[pile.length - 1] as Card).number > 10 && guard++ < 100) pile.unshift(pile.pop() as Card);
  const first = pile.pop() as Card;
  const state: GameState = {
    cartridgeId: 'matching',
    players,
    public: { ...emptyPublic(players, 'playing'), discard: [first] },
    private: private_,
    hidden: { drawPile: pile },
    table,
  };
  syncCounts(state);
  logLine(state, `Game on! ${name(state, currentPlayer(state.public.turn))} goes first.`);
  return state;
}

function fail(state: GameState, message: string): ActionResult {
  return { ok: false, state, message };
}

/** A player who reached one card and never called it draws two once play moves on. */
function settleLastCard(s: GameState, actor: PlayerId, rng: Rng): void {
  const pending = s.public.lastCardPending;
  if (!pending) return;
  s.public.lastCardPending = null;
  if (pending !== actor) {
    const { drawn, note } = pickUp(s, pending, 2, rng);
    logLine(s, `${name(s, pending)} forgot to call last card and draws ${drawn}.${note ? ` ${note}` : ''}`);
  }
}

const WRONG_STATUS: Partial<Record<GameStatus, (s: GameState) => string>> = {
  setup: () => 'Deal the cards and flip the first card first.',
  scanning: () => 'Finish tapping the drawn cards first (or skip).',
  confirming: (s) => `Confirm whether ${name(s, s.public.pendingWin as string)} is out first.`,
  scoring: () => 'Score the leftover cards first (or finish).',
};

const ALLOWED: Record<Action['type'], GameStatus[]> = {
  play: ['playing'],
  draw: ['playing'],
  callLast: ['playing'],
  flip: ['setup'],
  scan: ['setup', 'scanning'],
  skipScan: ['setup', 'scanning'],
  confirm: ['confirming'],
  score: ['scoring'],
  finishScoring: ['scoring'],
  adjust: ['setup', 'playing'],
  addCard: ['setup', 'scanning', 'playing'],
};

function reduce(prev: GameState, action: Action, rng: Rng): ActionResult {
  const status = prev.public.status;
  if (status === 'finished') return fail(prev, 'The game is over.');
  if (!ALLOWED[action.type].includes(status)) {
    return fail(prev, WRONG_STATUS[status]?.(prev) ?? (status === 'playing' ? 'The game has already started.' : 'Not right now.'));
  }
  const s = structuredClone(prev);
  switch (action.type) {
    case 'flip': return doFlip(prev, s, action.cardId);
    case 'scan': return doScan(prev, s, action.player, action.cardId);
    case 'skipScan': return doSkipScan(s, action.player);
    case 'confirm': return doConfirm(s, action.ok);
    case 'score': return doScore(prev, s, action.cardId);
    case 'finishScoring': return doFinishScoring(s);
    case 'addCard': return doAddCard(prev, s, action.cardId);
    case 'adjust': return doAdjust(prev, s, action.player, action.delta);
    case 'callLast': return doCallLast(prev, s, action.player);
    case 'draw': return doDraw(prev, s, action.player, rng);
    case 'play': return doPlay(prev, s, action.player, action.cardId, rng);
  }
}

// ---- physical table: setup, scanning, confirming, scoring ------------------

function doAddCard(prev: GameState, s: GameState, cardId: string): ActionResult {
  const card = cardById(cardId);
  if (!card) return fail(prev, `${cardId} isn't a card in this game.`);
  if (deckHas(s, cardId)) return fail(prev, `${card.id} is already in the deck.`);
  s.table.deck = ALL_CARD_IDS.filter((id) => id === cardId || s.table.deck.includes(id));
  syncCounts(s);
  logLine(s, `${card.id} added to the deck (${s.table.deck.length} cards in play).`);
  return { ok: true, state: s, message: `${card.id} added to the deck.` };
}

function doFlip(prev: GameState, s: GameState, cardId: string): ActionResult {
  const card = cardById(cardId);
  if (!card || !deckHas(s, cardId)) return fail(prev, outOfDeckMessage(s, cardId));
  const owner = knownOwner(s, cardId);
  if (owner) return fail(prev, `${card.id} is in ${name(s, owner)}'s hand.`);
  if (card.number > 10) return fail(prev, `${card.id} is a special card. Put it back, shuffle it into the pile, and flip another.`);
  s.public.discard = [card];
  s.public.status = 'playing';
  syncCounts(s);
  const first = name(s, currentPlayer(s.public.turn));
  logLine(s, `Starting card ${card.id}. ${first} goes first. Draw pile: ${s.public.drawPileCount}.`);
  return { ok: true, state: s, message: `Starting card ${card.id}. ${first} goes first.` };
}

function doScan(prev: GameState, s: GameState, player: PlayerId, cardId: string): ActionResult {
  const pub = s.public;
  if (pub.status === 'scanning' && pub.scanning?.player !== player) return fail(prev, `Waiting for ${name(s, pub.scanning?.player ?? '')} to tap their drawn cards.`);
  const err = scanInto(s, player, cardId, (id) => name(s, id));
  if (err) return fail(prev, err);
  const who = name(s, player);
  const have = (s.private[player]?.hand.length ?? 0) + 0;
  const size = handCount(s, player);
  if (pub.status === 'setup') {
    if (unknownOf(s.private[player]) === 0 && !pub.scanDone.includes(player)) pub.scanDone.push(player);
    syncCounts(s);
    return { ok: true, state: s, message: `${who}: ${have} of ${size} cards scanned.` };
  }
  const sc = pub.scanning as { player: PlayerId; remaining: number };
  sc.remaining--;
  if (sc.remaining <= 0 || unknownOf(s.private[player]) === 0) {
    pub.status = 'playing';
    pub.scanning = null;
  }
  syncCounts(s);
  return { ok: true, state: s, message: `${who} scanned ${cardId}.` };
}

function doSkipScan(s: GameState, player: PlayerId): ActionResult {
  const pub = s.public;
  if (pub.status === 'setup') {
    if (!pub.scanDone.includes(player)) pub.scanDone.push(player);
  } else if (pub.scanning?.player === player) {
    pub.status = 'playing';
    pub.scanning = null;
  }
  return { ok: true, state: s, message: `${name(s, player)}: skipped scanning (counted only).` };
}

function doConfirm(s: GameState, ok: boolean): ActionResult {
  const pub = s.public;
  const w = pub.pendingWin as PlayerId;
  const who = name(s, w);
  if (!ok) {
    // The count had drifted: they still hold a card the app didn't know about.
    const hp = s.private[w];
    if (hp) hp.unknown = unknownOf(hp) + 1;
    pub.status = 'playing';
    pub.pendingWin = null;
    pub.lastCardPending = null;
    syncCounts(s);
    logLine(s, `${who} still has a card: count corrected.`);
    return { ok: true, state: s, message: `${who} still has a card. Count corrected.` };
  }
  const others = s.players.filter((p) => p.id !== w).map((p) => p.id);
  const kp = knownPoints(s, others, cardPoints);
  pub.scores[w] = (pub.scores[w] ?? 0) + kp.total;
  pub.scoredCards = kp.ids;
  pub.winner = w;
  pub.pendingWin = null;
  const unidentified = others.some((id) => unknownOf(s.private[id]) > 0);
  if (unidentified && s.table.mode === 'physical') {
    pub.status = 'scoring';
    logLine(s, `${who} is out! Tap the cards left in the other hands to score, or finish.`);
    syncCounts(s);
    return { ok: true, state: s, message: `${who} is out! Tap the cards left in the other hands to score, or finish.` };
  }
  pub.status = 'finished';
  logLine(s, `${who} wins and scores ${pub.scores[w]}!`);
  syncCounts(s);
  return { ok: true, state: s, message: `${who} wins!` };
}

function doScore(prev: GameState, s: GameState, cardId: string): ActionResult {
  const pub = s.public;
  const card = cardById(cardId);
  if (!card || !deckHas(s, cardId)) return fail(prev, outOfDeckMessage(s, cardId));
  if (inDiscard(s, cardId)) return fail(prev, `${card.id} was played, not left in a hand.`);
  if (pub.scoredCards.includes(cardId)) return fail(prev, `${card.id} is already counted.`);
  const w = pub.winner as PlayerId;
  pub.scores[w] = (pub.scores[w] ?? 0) + cardPoints(card);
  pub.scoredCards.push(cardId);
  return { ok: true, state: s, message: `+${cardPoints(card)} for ${card.id}. ${name(s, w)}: ${pub.scores[w]}.` };
}

function doFinishScoring(s: GameState): ActionResult {
  const pub = s.public;
  const w = pub.winner as PlayerId;
  pub.status = 'finished';
  logLine(s, `${name(s, w)} wins and scores ${pub.scores[w]}!`);
  return { ok: true, state: s, message: `${name(s, w)} wins!` };
}

/** Fix a player's card count (someone forgot to say "draw", or miscounted). Only for real cards. */
function doAdjust(prev: GameState, s: GameState, player: PlayerId, delta: number): ActionResult {
  if (!isPhysical(s)) return fail(prev, 'Hands are tracked automatically when the app deals.');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 5) return fail(prev, 'Adjust by a small whole number.');
  const hp = s.private[player] as GameState['private'][string];
  if (delta < 0 && unknownOf(hp) < -delta) return fail(prev, "Scanned cards can't be removed from the count.");
  const total = s.players.reduce((n, p) => n + handCount(s, p.id), 0) + delta;
  if (s.table.deck.length - total - s.public.discard.length < 0) return fail(prev, "There aren't that many cards in the game.");
  hp.unknown = unknownOf(hp) + delta;
  syncCounts(s);
  logLine(s, `${name(s, player)}'s count corrected to ${handCount(s, player)}.`);
  return { ok: true, state: s, message: `${name(s, player)} now has ${handCount(s, player)} cards.` };
}

// ---- the game itself --------------------------------------------------------

function doCallLast(prev: GameState, s: GameState, player: PlayerId): ActionResult {
  const pub = s.public;
  const who = name(s, player);
  if (pub.lastCardPending !== player) return fail(prev, `${who} has nothing to call.`);
  pub.lastCardPending = null;
  logLine(s, `${who}: last card!`);
  return { ok: true, state: s, message: `${who} calls last card.` };
}

function doDraw(prev: GameState, s: GameState, player: PlayerId, rng: Rng): ActionResult {
  const pub = s.public;
  const who = name(s, player);
  if (currentPlayer(pub.turn) !== player) return fail(prev, `It's ${name(s, currentPlayer(pub.turn))}'s turn, not ${who}'s.`);
  const hp = s.private[player] as GameState['private'][string];
  const top = topOf(s);
  // Only enforceable when the app has identified every card in the hand; otherwise it's the honor system.
  if (pub.pendingDraw === 0 && fullyKnown(s, player) && hp.hand.some((c) => isPlayable(c, top, 0))) {
    return fail(prev, `${who} has a playable card and can't draw.`);
  }
  settleLastCard(s, player, rng);
  const owed = pub.pendingDraw || 1;
  const { drawn, note } = pickUp(s, player, owed, rng);
  pub.pendingDraw = 0;
  pub.turn = advance(pub.turn);
  const line = `${who} draws ${drawn}.${note ? ` ${note}` : ''}`;
  logLine(s, line);
  if (isPhysical(s) && s.table.knowledge === 'scanned' && drawn > 0) {
    pub.status = 'scanning';
    pub.scanning = { player, remaining: drawn };
  }
  syncCounts(s);
  return { ok: true, state: s, message: line };
}

function doPlay(prev: GameState, s: GameState, player: PlayerId, cardId: string, rng: Rng): ActionResult {
  const pub = s.public;
  const who = name(s, player);
  if (currentPlayer(pub.turn) !== player) return fail(prev, `It's ${name(s, currentPlayer(pub.turn))}'s turn, not ${who}'s.`);
  const hp = s.private[player] as GameState['private'][string];
  const top = topOf(s);
  const card = cardById(cardId);
  if (!card || !deckHas(s, cardId)) return fail(prev, outOfDeckMessage(s, cardId));

  const known = hp.hand.find((c) => c.id === cardId);
  if (!known) {
    if (inDiscard(s, cardId)) return fail(prev, `${cardId} is already on the pile.`);
    const owner = knownOwner(s, cardId);
    if (owner) return fail(prev, `That's ${name(s, owner)}'s card, not ${who}'s.`);
    // Not identified: fine if this player still holds cards the app hasn't identified (it learns this one now).
    if (unknownOf(hp) <= 0) return fail(prev, `${cardId} isn't in ${who}'s hand.`);
  }
  if (!isPlayable(card, top, pub.pendingDraw)) {
    return fail(
      prev,
      pub.pendingDraw > 0 ? `${who} must play a 13 to stack, or draw ${pub.pendingDraw}.` : `${card.id} doesn't match ${top.id}.`,
    );
  }
  settleLastCard(s, player, rng);
  if (known) hp.hand.splice(hp.hand.indexOf(known), 1);
  else hp.unknown = unknownOf(hp) - 1;
  pub.discard.push(card);
  logLine(s, `${who} plays ${card.id}.`);

  const left = handCount(s, player);
  if (left === 0 && !isPhysical(s)) {
    const total = s.players.filter((p) => p.id !== player).reduce((sum, p) => sum + (s.private[p.id]?.hand ?? []).reduce((a, c) => a + cardPoints(c), 0), 0);
    pub.status = 'finished';
    pub.winner = player;
    pub.scores[player] = (pub.scores[player] ?? 0) + total;
    logLine(s, `${who} wins and scores ${total}!`);
    syncCounts(s);
    return { ok: true, state: s, message: `${who} wins!` };
  }
  if (left === 1) pub.lastCardPending = player;

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

  if (left === 0) {
    // Real cards: the app only counts, so the table confirms before anyone is declared the winner.
    pub.status = 'confirming';
    pub.pendingWin = player;
    pub.lastCardPending = null;
    syncCounts(s);
    logLine(s, `${who} is out? Confirm.`);
    return { ok: true, state: s, message: `${who} played their last card. Confirm they're out.` };
  }
  syncCounts(s);
  return { ok: true, state: s, message: `${who} plays ${card.id}.` };
}

/** First player (in seat order) who still has cards to identify and hasn't finished or skipped. */
export function nextScanner(state: GameState): PlayerId | null {
  for (const id of state.public.turn.order) {
    if (unknownOf(state.private[id]) > 0 && !state.public.scanDone.includes(id)) return id;
  }
  return null;
}

function tapToAction(state: GameState, card: Card): Action {
  const pub = state.public;
  switch (pub.status) {
    case 'setup': {
      const scanner = state.table.mode === 'physical' && state.table.knowledge === 'scanned' ? nextScanner(state) : null;
      return scanner ? { type: 'scan', player: scanner, cardId: card.id } : { type: 'flip', cardId: card.id };
    }
    case 'scanning':
      return { type: 'scan', player: (pub.scanning as { player: PlayerId }).player, cardId: card.id };
    case 'scoring':
      return { type: 'score', cardId: card.id };
    default:
      return { type: 'play', player: currentPlayer(pub.turn), cardId: card.id };
  }
}

export const matchingGame: Cartridge = {
  id: 'matching',
  name: MATCHING_NAME,
  description: 'Match the top card by number or shape. First to empty their hand wins.',
  accent: '#d9480f', // bright and energetic
  feedbackStyle: 'playful',
  players: { kind: 'range', min: 2, max: 10 },
  planDeal,
  setup,
  reduce,
  tapToAction,
};
