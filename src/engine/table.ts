import { ALL_CARD_IDS } from './deckConfig';
import { STANDARD_DECK, cardById } from './deck';
import type { Card, DealMode, GameState, Knowledge, PlayerId, PrivateState, TableConfig } from './types';

/**
 * The table model, shared by every game. A hand is "cards the app has identified" plus a count of
 * cards it hasn't (`unknown`). With the app dealing, nothing is unknown. With real cards, the app
 * starts knowing only counts and learns identities when cards are tapped (when played, or when a
 * player scans them). Everything below works on that one representation.
 */

export function defaultTable(handSize: number, deck: string[] = ALL_CARD_IDS, mode: DealMode = 'virtual', knowledge: Knowledge = 'counts'): TableConfig {
  return { mode, knowledge, deck: [...deck], handSize };
}

export const unknownOf = (p: PrivateState | undefined): number => p?.unknown ?? 0;

export function handCount(s: GameState, id: PlayerId): number {
  const p = s.private[id];
  return (p?.hand.length ?? 0) + unknownOf(p);
}

export const totalInHands = (s: GameState): number => s.players.reduce((n, p) => n + handCount(s, p.id), 0);

export const deckHas = (s: GameState, cardId: string): boolean => s.table.deck.includes(cardId);

export function deckCards(table: Pick<TableConfig, 'deck'>): Card[] {
  return table.deck.map((id) => cardById(id)).filter((c): c is Card => !!c);
}

export const inDiscard = (s: GameState, cardId: string): boolean => s.public.discard.some((c) => c.id === cardId);

/** Which player's hand a card is known to be in, if the app has identified it. */
export function knownOwner(s: GameState, cardId: string): PlayerId | null {
  for (const p of s.players) if (s.private[p.id]?.hand.some((c) => c.id === cardId)) return p.id;
  return null;
}

/** True when the app knows every card this player holds (so it can check what they could play). */
export const fullyKnown = (s: GameState, id: PlayerId): boolean => unknownOf(s.private[id]) === 0;

/**
 * Refresh the public counts. With real cards the draw pile is never seen, so its size is derived:
 * cards in play, minus what is in hands, minus what is on the discard pile.
 */
export function syncCounts(s: GameState): void {
  for (const p of s.players) s.public.handCounts[p.id] = handCount(s, p.id);
  s.public.drawPileCount = s.table.mode === 'virtual' ? s.hidden.drawPile.length : Math.max(0, s.table.deck.length - totalInHands(s) - s.public.discard.length);
}

export interface DrawResult {
  drawn: number;
  reshuffled: boolean;
  note: string;
}

/**
 * Real cards: the player picks up `n` cards from a pile the app can't see. If the pile runs short,
 * the table reshuffles the discard pile (keeping the top card) and carries on, exactly as they would
 * physically. Returns how many were actually available.
 */
export function physicalDraw(s: GameState, player: PlayerId, n: number): DrawResult {
  syncCounts(s);
  const pile = s.public.drawPileCount;
  const spare = Math.max(0, s.public.discard.length - 1);
  const drawn = Math.min(n, pile + spare);
  const reshuffled = n > pile && spare > 0;
  if (reshuffled) s.public.discard = [s.public.discard[s.public.discard.length - 1] as Card]; // history before the reshuffle is gone
  const p = s.private[player] as PrivateState;
  p.unknown = unknownOf(p) + drawn;
  const note =
    drawn < n
      ? `Only ${drawn} card${drawn === 1 ? '' : 's'} left in the whole game.`
      : reshuffled
        ? 'The pile ran out: reshuffle the discard pile, keeping the top card.'
        : '';
  syncCounts(s);
  return { drawn, reshuffled, note };
}

/** Identify a card in a player's hand (turn one of their unidentified cards into a known one). Returns an error or null. */
export function scanInto(s: GameState, player: PlayerId, cardId: string, nameOf: (id: PlayerId) => string): string | null {
  const card = cardById(cardId);
  if (!card || !deckHas(s, cardId)) return "That card isn't in this game's deck.";
  if (inDiscard(s, cardId)) return `${card.id} is already on the pile.`;
  const owner = knownOwner(s, cardId);
  if (owner) return owner === player ? `${card.id} is already scanned.` : `${card.id} is in ${nameOf(owner)}'s hand.`;
  const p = s.private[player] as PrivateState;
  if (unknownOf(p) <= 0) return `${nameOf(player)} has no unscanned cards left.`;
  p.hand.push(card);
  p.unknown = unknownOf(p) - 1;
  return null;
}

/** Sum of card values still held by `players` that the app has identified. */
export function knownPoints(s: GameState, players: PlayerId[], points: (c: Card) => number): { total: number; ids: string[] } {
  let total = 0;
  const ids: string[] = [];
  for (const id of players) {
    for (const c of s.private[id]?.hand ?? []) {
      total += points(c);
      ids.push(c.id);
    }
  }
  return { total, ids };
}

export const allCards = (): Card[] => STANDARD_DECK;
