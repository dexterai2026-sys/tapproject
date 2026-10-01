import type { Cartridge } from '../engine/types';

export type CueKind = 'success' | 'error' | 'turn' | 'win';
export type FeedbackStyle = Cartridge['feedbackStyle'];

export interface Tone {
  freq: number;
  ms: number;
  type: OscillatorType;
}

export interface Cue {
  tones: Tone[];
  vibrate: number | number[];
}

/**
 * The three core moments from the brief: a tap that registered, an error, and
 * game-level moments (turn start, win). Each game picks a style.
 */
export function cueFor(kind: CueKind, style: FeedbackStyle): Cue {
  const t = (freq: number, ms: number, type: OscillatorType): Tone => ({ freq, ms, type });
  if (style === 'dramatic') {
    switch (kind) {
      case 'success': return { tones: [t(392, 120, 'sine'), t(523, 170, 'sine')], vibrate: 40 };
      case 'error': return { tones: [t(147, 200, 'sawtooth'), t(110, 280, 'sawtooth')], vibrate: [90, 50, 90] };
      case 'turn': return { tones: [t(294, 160, 'sine')], vibrate: 20 };
      case 'win': return { tones: [t(220, 240, 'sine'), t(277, 240, 'sine'), t(330, 240, 'sine'), t(440, 480, 'sine')], vibrate: [120, 60, 120, 60, 240] };
    }
  }
  switch (kind) {
    case 'success': return { tones: [t(880, 70, 'sine'), t(1319, 100, 'sine')], vibrate: 30 };
    case 'error': return { tones: [t(220, 120, 'square'), t(165, 170, 'square')], vibrate: [60, 40, 60] };
    case 'turn': return { tones: [t(660, 90, 'triangle')], vibrate: 15 };
    case 'win': return { tones: [t(523, 110, 'triangle'), t(659, 110, 'triangle'), t(784, 110, 'triangle'), t(1047, 260, 'triangle')], vibrate: [80, 40, 80, 40, 160] };
  }
}

export interface AudioCtxLike {
  currentTime: number;
  destination: unknown;
  resume?(): Promise<void>;
  createOscillator(): { type: string; frequency: { value: number }; connect(n: unknown): void; start(t: number): void; stop(t: number): void };
  createGain(): { gain: { setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): void };
}

export interface FeedbackOptions {
  sound: boolean;
  style: FeedbackStyle;
  ctxFactory?: () => AudioCtxLike | null;
  vibrate?: (pattern: number | number[]) => void;
}

function defaultCtx(): AudioCtxLike | null {
  const g = globalThis as unknown as Record<string, (new () => AudioCtxLike) | undefined>;
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

/** Plays a cue's sound and vibration. Never throws: feedback is a nicety, not a dependency. */
export function createFeedback(o: FeedbackOptions) {
  let ctx: AudioCtxLike | null = null;
  const vibrate = o.vibrate ?? ((p) => navigator.vibrate?.(p));
  return (kind: CueKind): void => {
    const cue = cueFor(kind, o.style);
    try {
      vibrate(cue.vibrate);
    } catch {
      /* vibration unsupported */
    }
    if (!o.sound) return;
    try {
      ctx ??= (o.ctxFactory ?? defaultCtx)();
      if (!ctx) return;
      void ctx.resume?.();
      let at = ctx.currentTime;
      for (const tone of cue.tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = tone.type;
        osc.frequency.value = tone.freq;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.15, at + 0.01); // quiet and click-free
        gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.ms / 1000);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + tone.ms / 1000 + 0.02);
        at += tone.ms / 1000;
      }
    } catch {
      /* audio blocked or unsupported */
    }
  };
}
