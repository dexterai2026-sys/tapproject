import type { ChipMap } from './engine/deck';

const KEY = 'tap.chipMap.v1';

export function loadChipMap(): ChipMap {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ChipMap) : {};
  } catch {
    return {};
  }
}

export function saveChipMap(map: ChipMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable: registration lasts for this session only */
  }
}
