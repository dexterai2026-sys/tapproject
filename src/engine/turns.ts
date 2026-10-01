import type { PlayerId, TurnState } from './types';

export function createTurn(order: PlayerId[], start = 0): TurnState {
  return { order: [...order], index: start, direction: 1 };
}

export function currentPlayer(turn: TurnState): PlayerId {
  return turn.order[turn.index] as PlayerId;
}

/** Move `steps` seats in the current direction. */
export function advance(turn: TurnState, steps = 1): TurnState {
  const n = turn.order.length;
  const index = (((turn.index + turn.direction * steps) % n) + n) % n;
  return { ...turn, index };
}

export function reverse(turn: TurnState): TurnState {
  return { ...turn, direction: turn.direction === 1 ? -1 : 1 };
}

/** The player who would be skipped is passed over: move two seats. */
export function skip(turn: TurnState): TurnState {
  return advance(turn, 2);
}
