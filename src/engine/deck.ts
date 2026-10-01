import type { Card, Rng, Suit } from './types';

export const SUITS: Suit[] = ['circle', 'triangle', 'square', 'star'];

/** The fixed physical card universe every customer owns: 4 suits x 13 numbers. */
export const STANDARD_DECK: Card[] = SUITS.flatMap((suit) =>
  Array.from({ length: 13 }, (_, i) => ({ id: `${suit}-${i + 1}`, number: i + 1, suit })),
);

const BY_ID = new Map(STANDARD_DECK.map((c) => [c.id, c]));

export function cardById(id: string): Card | undefined {
  return BY_ID.get(id);
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/**
 * Card-identity mapping layer: chip ID -> card ID. The chip stores nothing but
 * its factory ID; what a card *means* lives in the app (and per-game cartridge).
 */
export type ChipMap = Record<string, string>;

export const SIMULATED_PREFIX = 'SIM-';

export function simulatedChipId(cardId: string): string {
  return SIMULATED_PREFIX + cardId;
}

export function simulatedChipMap(): ChipMap {
  return Object.fromEntries(STANDARD_DECK.map((c) => [simulatedChipId(c.id), c.id]));
}

export function resolveChip(map: ChipMap, chipId: string): Card | undefined {
  const cardId = map[chipId];
  return cardId ? cardById(cardId) : undefined;
}

/** Bind a chip to a card, removing any previous binding of either. */
export function registerChip(map: ChipMap, chipId: string, cardId: string): ChipMap {
  const next: ChipMap = {};
  for (const [chip, card] of Object.entries(map)) {
    if (chip !== chipId && card !== cardId) next[chip] = card;
  }
  next[chipId] = cardId;
  return next;
}
