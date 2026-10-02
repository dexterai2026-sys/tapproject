import type { ResolvedVia } from './command';

export interface HeardEntry {
  text: string; // what the recognizer produced (may be personal speech: kept on screen only unless the user opts in)
  via: ResolvedVia;
  command: string; // resolved command type, or 'unknown'
  modelMs?: number;
}

export const HEARD_CAP = 20;

export function addHeard(list: HeardEntry[], entry: HeardEntry): HeardEntry[] {
  return [...list, entry].slice(-HEARD_CAP);
}

export function countHeard(list: HeardEntry[]): Record<ResolvedVia, number> {
  const out: Record<ResolvedVia, number> = { grammar: 0, model: 0, none: 0 };
  for (const e of list) out[e.via]++;
  return out;
}
