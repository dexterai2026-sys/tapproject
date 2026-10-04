import { STANDARD_DECK } from './deck';
import type { Suit } from './types';

export const ALL_CARD_IDS: string[] = STANDARD_DECK.map((c) => c.id);
const ORDER = new Map(ALL_CARD_IDS.map((id, i) => [id, i]));

/** Keep only real card ids, once each, in canonical order. */
export function sanitizeDeck(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => ORDER.has(id)))].sort((a, b) => (ORDER.get(a) as number) - (ORDER.get(b) as number));
}

/**
 * "I want N cards": drop the highest numbers first (and the last shape within a number), so 40 is
 * numbers 1-10 in every shape, the way short decks are usually made. The player can still tweak
 * the exact cards afterwards; this is only the starting point.
 */
export function deckForCount(n: number): string[] {
  const keep = Math.max(0, Math.min(ALL_CARD_IDS.length, Math.floor(n)));
  const removeFirst = [...STANDARD_DECK].sort((a, b) => b.number - a.number || shapeRank(b.suit) - shapeRank(a.suit));
  const removed = new Set(removeFirst.slice(0, ALL_CARD_IDS.length - keep).map((c) => c.id));
  return ALL_CARD_IDS.filter((id) => !removed.has(id));
}

const SHAPES: Suit[] = ['circle', 'triangle', 'square', 'star'];
const shapeRank = (s: Suit) => SHAPES.indexOf(s);

export function deckFromExcluded(excluded: readonly string[]): string[] {
  const out = new Set(excluded);
  return ALL_CARD_IDS.filter((id) => !out.has(id));
}

export function excludedFromDeck(deck: readonly string[]): string[] {
  const have = new Set(deck);
  return ALL_CARD_IDS.filter((id) => !have.has(id));
}

/** One line a person can read: "40 cards: numbers 1-10 in all 4 shapes", or which cards are missing. */
export function describeDeck(deck: readonly string[]): string {
  const ids = sanitizeDeck(deck);
  if (ids.length === ALL_CARD_IDS.length) return 'All 52 cards';
  if (ids.length === 0) return 'No cards';
  const byNumber = new Map<number, number>();
  for (const id of ids) {
    const n = STANDARD_DECK[ORDER.get(id) as number]?.number as number;
    byNumber.set(n, (byNumber.get(n) ?? 0) + 1);
  }
  const nums = [...byNumber.keys()].sort((a, b) => a - b);
  const uniform = nums.every((n) => byNumber.get(n) === SHAPES.length);
  const contiguous = nums.every((n, i) => i === 0 || n === (nums[i - 1] as number) + 1);
  if (uniform && contiguous) return `${ids.length} cards: numbers ${nums[0]}-${nums[nums.length - 1]} in all ${SHAPES.length} shapes`;
  const missing = excludedFromDeck(ids);
  // A short deck with a lost card or two: say what range it covers, then what is missing inside it.
  if (contiguous && !(nums[0] === 1 && nums[nums.length - 1] === 13)) {
    const lo = nums[0] as number;
    const hi = nums[nums.length - 1] as number;
    const inRange = missing.filter((id) => {
      const n = STANDARD_DECK[ORDER.get(id) as number]?.number as number;
      return n >= lo && n <= hi;
    });
    if (inRange.length > 0 && inRange.length <= 6) return `${ids.length} cards: numbers ${lo}-${hi}, missing ${inRange.join(', ')}`;
  }
  const shown = missing.slice(0, 6).join(', ');
  return missing.length <= 12 ? `${ids.length} cards (missing ${shown}${missing.length > 6 ? ', …' : ''})` : `${ids.length} cards`;
}
