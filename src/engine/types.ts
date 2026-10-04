export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
}

/** Four shape-distinct suits (colorblind-safe: told apart by shape, not color). */
export type Suit = 'circle' | 'triangle' | 'square' | 'star';

export interface Card {
  id: string; // "<suit>-<number>", e.g. "star-7"
  number: number; // 1-13
  suit: Suit;
}

export interface TurnState {
  order: PlayerId[];
  index: number;
  direction: 1 | -1;
}

/** Who deals: the app (it knows every hand) or the players with real cards (it only sees taps). */
export type DealMode = 'virtual' | 'physical';

/**
 * How much the app tries to learn about hands in physical play.
 *  - counts: only how many cards each player holds (derived from taps and declared draws)
 *  - scanned: players also tap the cards they are dealt and draw, so identities are known too
 * Either way every card that is played is tapped, so the pile is always known.
 */
export type Knowledge = 'counts' | 'scanned';

/** The table this game is played on: which cards are in play, who deals, how much is tracked. */
export interface TableConfig {
  mode: DealMode;
  knowledge: Knowledge;
  deck: string[]; // ids of the cards in play (a subset of the 52 the customer owns)
  handSize: number;
}

export type GameStatus =
  | 'setup' // physical only: cards are being dealt / scanned, waiting for the first card to be flipped
  | 'playing'
  | 'scanning' // physical + scanned: a player is tapping the cards they just drew
  | 'confirming' // physical: someone's count hit zero, the table confirms they're out
  | 'scoring' // physical: tapping leftover cards to score the round
  | 'finished';

/** Visible to every device. */
export interface PublicState {
  status: GameStatus;
  scanDone: PlayerId[]; // setup: players who finished (or skipped) scanning their hand
  scanning: { player: PlayerId; remaining: number } | null;
  pendingWin: PlayerId | null;
  scoredCards: string[]; // leftover cards already counted this round
  reshuffles?: number; // how many times the discard pile has been restocked into the draw pile (absent in older saves)
  turn: TurnState;
  discard: Card[]; // last element is the top card
  drawPileCount: number;
  handCounts: Record<PlayerId, number>;
  pendingDraw: number; // stacked draw-two penalty owed by the current player
  lastCardPending: PlayerId | null; // player on one card who has not called it yet
  scores: Record<PlayerId, number>;
  winner: PlayerId | null;
  log: string[];
}

/** Visible only to its owning player. */
export interface PrivateState {
  hand: Card[]; // cards whose identity the app knows
  unknown?: number; // cards held but not identified (physical play): hand size = hand.length + unknown
}

/** Engine-only: never projected to any player. */
export interface HiddenState {
  drawPile: Card[];
}

export interface GameState {
  cartridgeId: string;
  players: Player[];
  public: PublicState;
  private: Record<PlayerId, PrivateState>;
  hidden: HiddenState;
  table: TableConfig;
}

/** What a single player's device is allowed to see. */
export interface PlayerView {
  public: PublicState;
  private: PrivateState;
}

export type Action =
  | { type: 'play'; player: PlayerId; cardId: string }
  | { type: 'draw'; player: PlayerId }
  | { type: 'callLast'; player: PlayerId }
  // physical table
  | { type: 'flip'; cardId: string } // the first card turned over to start the pile
  | { type: 'scan'; player: PlayerId; cardId: string } // identify a card a player holds
  | { type: 'skipScan'; player: PlayerId } // stop scanning for this player: the rest stay unidentified
  | { type: 'confirm'; ok: boolean } // the table confirms (or denies) that the player whose count hit zero is out
  | { type: 'score'; cardId: string } // a leftover card, counted toward the winner's score
  | { type: 'finishScoring' }
  | { type: 'adjust'; player: PlayerId; delta: number } // correct a player's card count
  | { type: 'addCard'; cardId: string }; // put a card that was left out back into this game's deck

export type ActionResult =
  | { ok: true; state: GameState; message: string }
  | { ok: false; state: GameState; message: string };

export type Rng = () => number;

export type PlayerCount =
  | { kind: 'fixed'; count: number }
  | { kind: 'range'; min: number; max: number };

/**
 * A compiled game: rules, win conditions and card meaning baked in as plain
 * functions. Running one never requires a live AI call.
 */
export interface Cartridge {
  id: string;
  name: string;
  description: string;
  /** Per-game look and feel inside one visual language. */
  accent: string;
  feedbackStyle: 'playful' | 'dramatic';
  players: PlayerCount;
  /** What the deal looks like for this many players and cards, or why it can't work. */
  planDeal(playerCount: number, deckSize: number): { handSize: number; pile: number } | { error: string };
  setup(players: Player[], rng: Rng, table?: TableConfig): GameState;
  reduce(state: GameState, action: Action, rng: Rng): ActionResult;
  /** Translate "this card was tapped" into the action it means right now. */
  tapToAction(state: GameState, card: Card): Action;
}
