import type { Settings } from '../settings';
import { synthesize, type SynthTiming } from './lazybird';
import type { TraceRef } from '../perf';

export interface SpeakerDeps {
  synth?: (text: string, ssml: boolean, onTiming?: (t: SynthTiming) => void) => Promise<Blob>;
  /** `onStart` fires when audio is actually audible, not when it was requested. */
  playBlob?: (blob: Blob, signal: AbortSignal, onStart?: () => void) => Promise<void>;
  fallback?: (text: string, signal: AbortSignal, onStart?: () => void) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  /** Called the moment a line becomes audible, so callers can sample output latency. */
  onAudible?: (line?: TraceRef) => void;
}

export interface SpeakOptions {
  ssml?: boolean;
  plain?: string; // text for the browser-voice fallback when `text` is SSML
  trace?: TraceRef; // the interaction's trace; each spoken line records into its own sub-trace
  kind?: string; // what the line is: 'reaction' | 'confirmation' | 'answer'
}

const MAX_QUEUE = 3;

/** Speaks lines one at a time; never throws, never blocks the game. */
export class Speaker {
  enabled = true;
  private queue: { text: string; opts: SpeakOptions; line?: TraceRef }[] = [];
  private running = false;
  private ctl = new AbortController();

  constructor(private deps: SpeakerDeps = {}) {}

  speak(text: string, opts: SpeakOptions = {}): void {
    if (!this.enabled || !text) return;
    const line = opts.trace?.line(opts.kind ?? 'line'); // this line's own timings (an interaction can speak several)
    line?.mark('queued');
    line?.meta('textChars', text.length);
    this.queue.push({ text, opts, line });
    while (this.queue.length > MAX_QUEUE) this.queue.shift(); // stale commentary is worthless
    void this.run();
  }

  stop(): void {
    this.queue = [];
    this.ctl.abort();
    this.ctl = new AbortController();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.deps.onBusyChange?.(true);
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        const signal = this.ctl.signal;
        const tr = item.line;
        const audible = () => {
          tr?.markOnce('playStart');
          this.deps.onAudible?.(tr);
        };
        try {
          if (!this.deps.synth || !this.deps.playBlob) throw new Error('no cloud voice');
          tr?.mark('synthStart');
          const blob = await this.deps.synth(item.text, !!item.opts.ssml, (t) => {
            tr?.mark('synthFirstByte', t.firstByteAt);
            tr?.mark('synthDone', t.doneAt);
            tr?.meta('audioBytes', t.bytes);
          });
          tr?.markOnce('synthDone'); // synth deps that don't report timing still end here
          if (signal.aborted) continue;
          tr?.meta('voicePath', 'lazybird');
          await this.deps.playBlob(blob, signal, audible);
          tr?.markOnce('playEnd');
        } catch {
          if (!signal.aborted) {
            try {
              tr?.meta('voicePath', this.deps.synth ? 'browser-after-lazybird-failed' : 'browser');
              tr?.mark('fallbackStart');
              await this.deps.fallback?.(item.opts.plain ?? item.text, signal, audible);
              tr?.markOnce('playEnd');
            } catch {
              /* silent: captions still show the line */
            }
          }
        }
      }
    } finally {
      this.running = false;
      this.deps.onBusyChange?.(false);
    }
  }
}

export function playBlobInBrowser(blob: Blob, signal: AbortSignal, onStart?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const done = (fn: () => void) => () => {
      URL.revokeObjectURL(url);
      fn();
    };
    audio.onplaying = () => onStart?.();
    audio.onended = done(resolve);
    audio.onerror = done(() => reject(new Error('audio error')));
    signal.addEventListener('abort', done(() => { audio.pause(); resolve(); }), { once: true });
    audio.play().catch(done(() => reject(new Error('playback blocked'))));
  });
}

const SPEAK_TIMEOUT_MS = 20_000; // some browsers never fire `end`; don't wedge the queue (or keep the mic muted) forever

export function browserSpeak(text: string, signal: AbortSignal, onStart?: () => void): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const timer = setTimeout(() => { speechSynthesis.cancel(); resolve(); }, SPEAK_TIMEOUT_MS);
    const done = () => { clearTimeout(timer); resolve(); };
    u.onstart = () => onStart?.();
    u.onend = done;
    u.onerror = done;
    signal.addEventListener('abort', () => { speechSynthesis.cancel(); done(); }, { once: true });
    speechSynthesis.speak(u);
  });
}

/** Wire a Speaker to the user's settings: Lazybird when keyed, browser voice otherwise. */
export function createSpeaker(s: Settings, onBusyChange?: (busy: boolean) => void, onAudible?: (line?: TraceRef) => void): Speaker {
  const cloud = s.lazybirdKey && s.voiceId;
  const speaker = new Speaker({
    synth: cloud ? (text, ssml, onTiming) => synthesize(text, s.voiceId, { apiKey: s.lazybirdKey, ssml, onTiming }) : undefined,
    playBlob: playBlobInBrowser,
    fallback: browserSpeak,
    onBusyChange,
    onAudible,
  });
  speaker.enabled = s.speak;
  return speaker;
}
