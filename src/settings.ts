export type CommentaryMode = 'off' | 'canned' | 'live';
export type MicMode = 'off' | 'push' | 'wake';
export type VoiceMode = 'hybrid' | 'lazybird' | 'browser';

export type TextSize = 'S' | 'M' | 'L' | 'XL';

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
  textSize: TextSize;
  highContrast: boolean;
  sound: boolean; // audio cues (vibration is separate and always on where supported)
  showTiming: boolean; // latency panel on the game screen
  voiceMode: VoiceMode; // hybrid = quick lines on-device, personality via Lazybird
  browserVoice: string; // voiceURI of the on-device voice, '' = best English voice
  browserRate: number; // on-device speech speed, 1 = normal
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
  textSize: 'M',
  highContrast: false,
  sound: true,
  showTiming: true,
  voiceMode: 'hybrid',
  browserVoice: '',
  browserRate: 1.05,
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
