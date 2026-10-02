import type { Settings } from '../settings';
import { synthesize } from './lazybird';

export interface SpeakerDeps {
  synth?: (text: string, ssml: boolean) => Promise<Blob>;
  playBlob?: (blob: Blob, signal: AbortSignal) => Promise<void>;
  fallback?: (text: string, signal: AbortSignal) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}

export interface SpeakOptions {
  ssml?: boolean;
  plain?: string; // text for the browser-voice fallback when `text` is SSML
}

const MAX_QUEUE = 3;

/** Speaks lines one at a time; never throws, never blocks the game. */
export class Speaker {
  enabled = true;
  private queue: { text: string; opts: SpeakOptions }[] = [];
  private running = false;
  private ctl = new AbortController();

  constructor(private deps: SpeakerDeps = {}) {}

  speak(text: string, opts: SpeakOptions = {}): void {
    if (!this.enabled || !text) return;
    this.queue.push({ text, opts });
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
        try {
          if (!this.deps.synth || !this.deps.playBlob) throw new Error('no cloud voice');
          const blob = await this.deps.synth(item.text, !!item.opts.ssml);
          if (signal.aborted) continue;
          await this.deps.playBlob(blob, signal);
        } catch {
          if (!signal.aborted) {
            try {
              await this.deps.fallback?.(item.opts.plain ?? item.text, signal);
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

export function playBlobInBrowser(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const done = (fn: () => void) => () => {
      URL.revokeObjectURL(url);
      fn();
    };
    audio.onended = done(resolve);
    audio.onerror = done(() => reject(new Error('audio error')));
    signal.addEventListener('abort', done(() => { audio.pause(); resolve(); }), { once: true });
    audio.play().catch(done(() => reject(new Error('playback blocked'))));
  });
}

const SPEAK_TIMEOUT_MS = 20_000; // some browsers never fire `end`; don't wedge the queue (or keep the mic muted) forever

export function browserSpeak(text: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const timer = setTimeout(() => { speechSynthesis.cancel(); resolve(); }, SPEAK_TIMEOUT_MS);
    const done = () => { clearTimeout(timer); resolve(); };
    u.onend = done;
    u.onerror = done;
    signal.addEventListener('abort', () => { speechSynthesis.cancel(); done(); }, { once: true });
    speechSynthesis.speak(u);
  });
}

/** Wire a Speaker to the user's settings: Lazybird when keyed, browser voice otherwise. */
export function createSpeaker(s: Settings, onBusyChange?: (busy: boolean) => void): Speaker {
  const cloud = s.lazybirdKey && s.voiceId;
  const speaker = new Speaker({
    synth: cloud ? (text, ssml) => synthesize(text, s.voiceId, { apiKey: s.lazybirdKey, ssml }) : undefined,
    playBlob: playBlobInBrowser,
    fallback: browserSpeak,
    onBusyChange,
  });
  speaker.enabled = s.speak;
  return speaker;
}
