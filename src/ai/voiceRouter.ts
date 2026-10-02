import type { VoiceMode } from '../settings';

/** instant = functional lines that must be fast; flavor = personality that can arrive late or not at all. */
export type Tier = 'instant' | 'flavor';

/** browser = on-device speech now; cloud-block = Lazybird, plays in order; cloud-late = Lazybird, plays whenever ready if still relevant. */
export type Route = 'browser' | 'cloud-block' | 'cloud-late';

/** Only reactions are flavor. Answers, confirmations, errors and "your turn" are instant. */
export function tierFor(kind?: string): Tier {
  return kind === 'reaction' ? 'flavor' : 'instant';
}

export function routeFor(mode: VoiceMode, tier: Tier, hasCloud: boolean): Route {
  if (mode === 'browser' || !hasCloud) return 'browser';
  if (mode === 'lazybird') return 'cloud-block';
  return tier === 'instant' ? 'browser' : 'cloud-late'; // hybrid
}

export interface VoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
}

const NICE = /enhanced|premium|natural|neural|siri/i;

/**
 * Choose the on-device voice: the user's pick if still installed, else the best English one
 * (prefer local, then "enhanced/natural" names, which are usually the higher-quality voices).
 */
export function pickBrowserVoice<T extends VoiceLike>(voices: T[], preferredURI: string, lang = 'en'): T | undefined {
  const saved = preferredURI ? voices.find((v) => v.voiceURI === preferredURI) : undefined;
  if (saved) return saved;
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const score = (v: VoiceLike) => (v.localService ? 2 : 0) + (NICE.test(v.name) ? 1 : 0) + (v.lang.toLowerCase() === 'en-us' ? 0.5 : 0);
  return [...english].sort((a, b) => score(b) - score(a))[0];
}
