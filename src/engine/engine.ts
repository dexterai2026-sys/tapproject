import type { Action, ActionResult, Cartridge, GameState, Player, PlayerId, PlayerView, Rng, TableConfig } from './types';
import { cardById } from './deck';

export function validatePlayerCount(cartridge: Cartridge, count: number): string | null {
  const p = cartridge.players;
  if (p.kind === 'fixed') return count === p.count ? null : `${cartridge.name} needs exactly ${p.count} players`;
  return count >= p.min && count <= p.max ? null : `${cartridge.name} needs ${p.min}-${p.max} players`;
}

export function startGame(cartridge: Cartridge, players: Player[], rng: Rng, table?: TableConfig): GameState {
  const err = validatePlayerCount(cartridge, players.length);
  if (err) throw new Error(err);
  return cartridge.setup(players, rng, table);
}

export function applyAction(cartridge: Cartridge, state: GameState, action: Action, rng: Rng): ActionResult {
  return cartridge.reduce(state, action, rng);
}

/** Project state down to what one player's device may see (never the draw pile or other hands). */
export function viewFor(state: GameState, player: PlayerId): PlayerView {
  return { public: state.public, private: state.private[player] ?? { hand: [] } };
}

/** Handle a card tap: resolve to an action and apply it. */
export function handleTap(cartridge: Cartridge, state: GameState, cardId: string, rng: Rng): ActionResult {
  const card = cardById(cardId);
  if (!card) return { ok: false, state, message: 'Unknown card' };
  return applyAction(cartridge, state, cartridge.tapToAction(state, card), rng);
}
