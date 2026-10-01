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

/** Visible to every device. */
export interface PublicState {
  status: 'playing' | 'finished';
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
  hand: Card[];
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
}

/** What a single player's device is allowed to see. */
export interface PlayerView {
  public: PublicState;
  private: PrivateState;
}

export type Action =
  | { type: 'play'; player: PlayerId; cardId: string }
  | { type: 'draw'; player: PlayerId }
  | { type: 'callLast'; player: PlayerId };

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
  players: PlayerCount;
  setup(players: Player[], rng: Rng): GameState;
  reduce(state: GameState, action: Action, rng: Rng): ActionResult;
  /** Translate "this card was tapped" into the action it means right now. */
  tapToAction(state: GameState, card: Card): Action;
}
