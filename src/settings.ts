export type CommentaryMode = 'off' | 'canned' | 'live';
export type MicMode = 'off' | 'push' | 'wake';

export interface Settings {
  openrouterKey: string;
  lazybirdKey: string;
  fastModel: string; // cheap/fast: parsing spoken commands
  premiumModel: string; // richer: live trash talk and narration
  voiceId: string;
  speak: boolean; // read lines aloud (captions always show)
  commentary: CommentaryMode;
  liveCap: number; // max live AI lines per game session
  mic: MicMode;
  wakeWord: string;
}

export const DEFAULT_SETTINGS: Settings = {
  openrouterKey: '',
  lazybirdKey: '',
  fastModel: 'anthropic/claude-haiku-4.5',
  premiumModel: 'anthropic/claude-sonnet-4.5',
  voiceId: '',
  speak: true,
  commentary: 'canned',
  liveCap: 20,
  mic: 'off',
  wakeWord: 'hey deck',
};

const KEY = 'tap.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this page only */
  }
}
