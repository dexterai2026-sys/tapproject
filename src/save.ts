import type { GameState, Player } from './engine/types';

export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): Store | null {
  try {
    return localStorage;
  } catch {
    return null; // storage blocked or unavailable: features degrade to this page only
  }
}

function read<T>(key: string, store: Store | null): T | null {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown, store: Store | null): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or blocked: ignore */
  }
}

// ---- Pause / resume -------------------------------------------------------

export interface SavedGame {
  cartridgeId: string;
  players: Player[];
  realNfc: boolean;
  state: GameState;
  savedAt: number;
}

const GAME_KEY = 'tap.savedGame.v1';

export function saveGame(g: Omit<SavedGame, 'savedAt'>, store: Store | null = defaultStore(), now = Date.now()): void {
  write(GAME_KEY, { ...g, savedAt: now }, store);
}

export function loadGame(store: Store | null = defaultStore()): SavedGame | null {
  const g = read<SavedGame>(GAME_KEY, store);
  // Basic shape check so a stale or corrupt save can never crash the app.
  return g && g.state?.public?.turn && Array.isArray(g.players) && g.cartridgeId ? g : null;
}

export function clearGame(store: Store | null = defaultStore()): void {
  try {
    store?.removeItem(GAME_KEY);
  } catch {
    /* ignore */
  }
}

// ---- Local player profiles ------------------------------------------------

const NAMES_KEY = 'tap.playerNames.v1';

export function loadNames(store: Store | null = defaultStore()): string[] {
  const n = read<unknown>(NAMES_KEY, store);
  return Array.isArray(n) ? n.filter((x): x is string => typeof x === 'string') : [];
}

export function saveNames(names: string[], store: Store | null = defaultStore()): void {
  write(NAMES_KEY, names, store);
}

/** Trim, fall back to "Player N", cap length, and make names unique ("Sam", "Sam 2"). */
export function cleanNames(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((r, i) => {
    const base = r.trim().slice(0, 16) || `Player ${i + 1}`;
    const key = base.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? base : `${base} ${count}`;
  });
}

// ---- Game-night tally -----------------------------------------------------

export interface Tally {
  games: number;
  wins: Record<string, number>;
}

const TALLY_KEY = 'tap.nightTally.v1';

export function loadTally(store: Store | null = defaultStore()): Tally {
  return read<Tally>(TALLY_KEY, store) ?? { games: 0, wins: {} };
}

export function recordWin(tally: Tally, winner: string): Tally {
  return { games: tally.games + 1, wins: { ...tally.wins, [winner]: (tally.wins[winner] ?? 0) + 1 } };
}

export function saveTally(t: Tally, store: Store | null = defaultStore()): void {
  write(TALLY_KEY, t, store);
}

export function resetTally(store: Store | null = defaultStore()): void {
  try {
    store?.removeItem(TALLY_KEY);
  } catch {
    /* ignore */
  }
}

// ---- Onboarding flag ------------------------------------------------------

const ONBOARD_KEY = 'tap.onboarded.v1';

export const isOnboarded = (store: Store | null = defaultStore()): boolean => read<boolean>(ONBOARD_KEY, store) === true;
export const setOnboarded = (done: boolean, store: Store | null = defaultStore()): void => write(ONBOARD_KEY, done, store);
