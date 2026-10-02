import type { Settings } from '../settings';
import { synthesize, type SynthTiming } from './lazybird';
import type { TraceRef } from '../perf';
import { AudioCache, cacheKey, createAudioCache } from './audioCache';
import { pickBrowserVoice, routeFor, tierFor, type Route } from './voiceRouter';

export interface SpeakerDeps {
  synth?: (text: string, ssml: boolean, onTiming?: (t: SynthTiming) => void) => Promise<Blob>;
  /** `onStart` fires when audio is actually audible, not when it was requested. */
  playBlob?: (blob: Blob, signal: AbortSignal, onStart?: () => void) => Promise<void>;
  fallback?: (text: string, signal: AbortSignal, onStart?: () => void) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  /** Called the moment a line becomes audible, so callers can sample output latency. */
  onAudible?: (line?: TraceRef) => void;
  /** Where a line of this kind should be spoken. Default: Lazybird if available, else on-device. */
  route?: (kind?: string) => Route;
  cache?: AudioCache | null;
  voiceId?: string; // part of the cache key
  now?: () => number;
}

export interface SpeakOptions {
  ssml?: boolean;
  plain?: string; // text for the browser-voice fallback when `text` is SSML
  trace?: TraceRef; // the interaction's trace; each spoken line records into its own sub-trace
  kind?: string; // what the line is: 'reaction' | 'turn' | 'confirmation' | 'answer'
}

const MAX_QUEUE = 3;
/** A flavor line that finishes synthesizing later than this is no longer worth saying. */
export const LATE_MAX_MS = 10_000;

interface Item {
  text: string;
  opts: SpeakOptions;
  line?: TraceRef;
  route: Route;
  epoch: number;
  queuedAt: number;
  audio?: Promise<Blob>;
}

/**
 * Speaks lines one at a time; never throws, never blocks the game.
 *
 * Lazybird audio is requested the moment a line is queued (so lines synthesize in
 * parallel and cached lines are instant), while playback stays sequential.
 * "Late" lines (flavor) never hold up the queue: they play as soon as their audio is
 * ready, but only if no newer interaction has started since they were queued.
 */
export class Speaker {
  enabled = true;
  private queue: Item[] = [];
  private running = false;
  private ctl = new AbortController();
  private epoch = 0;

  constructor(private deps: SpeakerDeps = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Call when a new interaction starts: flavor lines still synthesizing for older ones are dropped. */
  newInteraction(): void {
    this.epoch++;
  }

  speak(text: string, opts: SpeakOptions = {}): void {
    if (!this.enabled || !text) return;
    const line = opts.trace?.line(opts.kind ?? 'line'); // this line's own timings (an interaction can speak several)
    let route: Route = this.deps.route?.(opts.kind) ?? (this.deps.synth ? 'cloud-block' : 'browser');
    if (route !== 'browser' && !(this.deps.synth && this.deps.playBlob)) route = 'browser';
    line?.mark('queued');
    line?.meta('textChars', text.length);
    line?.meta('route', route);
    line?.meta('tier', tierFor(opts.kind));
    const item: Item = { text, opts, line, route, epoch: this.epoch, queuedAt: this.now() };
    if (route === 'browser') {
      line?.mark('ready');
      this.enqueue(item);
      return;
    }
    item.audio = this.fetchAudio(item);
    if (route === 'cloud-block') {
      item.audio.catch(() => {}); // failures are handled when the line's turn comes
      this.enqueue(item);
    } else {
      item.audio.then(
        (blob) => this.playLate(item, blob),
        () => item.line?.meta('skipped', 'lazybird-failed'), // flavor only: not worth a second, slower attempt
      );
    }
  }

  stop(): void {
    this.queue = [];
    this.epoch++; // anything still synthesizing is stale now
    this.ctl.abort();
    this.ctl = new AbortController();
  }

  private enqueue(item: Item, front = false): void {
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    while (this.queue.length > MAX_QUEUE) this.queue.shift(); // stale commentary is worthless
    void this.run();
  }

  private playLate(item: Item, blob: Blob): void {
    if (item.epoch !== this.epoch || this.now() - item.queuedAt > LATE_MAX_MS) {
      item.line?.meta('skipped', 'stale'); // still cached, so it costs nothing next time
      return;
    }
    this.enqueue({ ...item, audio: Promise.resolve(blob) }, true);
  }

  private async fetchAudio(item: Item): Promise<Blob> {
    const tr = item.line;
    const ssml = !!item.opts.ssml;
    const key = this.deps.cache ? cacheKey(this.deps.voiceId ?? '', item.text, ssml) : '';
    tr?.mark('synthStart');
    if (this.deps.cache) {
      const hit = await this.deps.cache.get(key);
      if (hit) {
        const t = performance.now();
        tr?.meta('cache', 'hit');
        tr?.mark('synthFirstByte', t);
        tr?.mark('synthDone', t);
        tr?.meta('audioBytes', hit.size);
        tr?.mark('ready');
        return hit;
      }
      tr?.meta('cache', 'miss');
    } else {
      tr?.meta('cache', 'off');
    }
    const blob = await (this.deps.synth as NonNullable<SpeakerDeps['synth']>)(item.text, ssml, (t) => {
      tr?.mark('synthFirstByte', t.firstByteAt);
      tr?.mark('synthDone', t.doneAt);
      tr?.meta('audioBytes', t.bytes);
    });
    tr?.markOnce('synthDone'); // synth deps that don't report timing still end here
    tr?.mark('ready');
    if (this.deps.cache) void this.deps.cache.put(key, blob);
    return blob;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.deps.onBusyChange?.(true);
    try {
      while (this.queue.length) {
        const item = this.queue.shift() as Item;
        const signal = this.ctl.signal;
        const tr = item.line;
        const audible = () => {
          tr?.markOnce('playStart');
          this.deps.onAudible?.(tr);
        };
        const speakOnDevice = async (why: string) => {
          tr?.meta('voicePath', why);
          tr?.mark('fallbackStart');
          await this.deps.fallback?.(item.opts.plain ?? item.text, signal, audible);
          tr?.markOnce('playEnd');
        };
        tr?.mark('dequeued');
        try {
          if (item.route === 'browser') {
            await speakOnDevice('browser');
            continue;
          }
          const blob = await (item.audio as Promise<Blob>);
          if (signal.aborted) continue;
          tr?.meta('voicePath', 'lazybird');
          tr?.mark('cloudPlayBegin');
          await (this.deps.playBlob as NonNullable<SpeakerDeps['playBlob']>)(blob, signal, audible);
          tr?.markOnce('playEnd');
        } catch {
          if (!signal.aborted) {
            try {
              await speakOnDevice(item.route === 'browser' ? 'browser' : 'browser-after-lazybird-failed');
            } catch {
              /* silent: captions still show the line */
            }
          }
        }
      }
    } finally {
      this.running = false;
      this.deps.onBusyChange?.(false);
      if (this.queue.length) void this.run(); // a late line may have arrived while we were finishing
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

export interface BrowserSpeakOptions {
  voiceURI?: string;
  rate?: number;
}

export function browserSpeak(text: string, signal: AbortSignal, onStart?: () => void, opts: BrowserSpeakOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') return resolve();
    const u = new SpeechSynthesisUtterance(text);
    let voice: SpeechSynthesisVoice | undefined;
    try {
      voice = pickBrowserVoice(speechSynthesis.getVoices(), opts.voiceURI ?? '');
    } catch {
      /* no voice list: speak with the browser's default voice */
    }
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    if (opts.rate && opts.rate > 0) u.rate = opts.rate;
    const timer = setTimeout(() => { speechSynthesis.cancel(); resolve(); }, SPEAK_TIMEOUT_MS);
    const done = () => { clearTimeout(timer); resolve(); };
    u.onstart = () => onStart?.();
    u.onend = done;
    u.onerror = done;
    signal.addEventListener('abort', () => { speechSynthesis.cancel(); done(); }, { once: true });
    speechSynthesis.speak(u);
  });
}

// A 1-sample silent WAV, used only to satisfy "audio must start from a user gesture" rules.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=';

/**
 * Call from a tap (the Start button). iOS Safari only allows speech and audio that
 * were started by a user gesture; doing a silent one here keeps later, asynchronous
 * speech (voice replies, Lazybird audio) allowed. Harmless elsewhere.
 */
export function unlockAudio(): void {
  try {
    if (typeof speechSynthesis !== 'undefined') {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch {
    /* unsupported */
  }
  try {
    const a = new Audio(SILENT_WAV);
    a.volume = 0;
    void a.play().catch(() => {});
  } catch {
    /* unsupported */
  }
}

/** Wire a Speaker to the user's settings: hybrid routing, Lazybird (cached) for flavor, the on-device voice for quick lines. */
export function createSpeaker(s: Settings, onBusyChange?: (busy: boolean) => void, onAudible?: (line?: TraceRef) => void): Speaker {
  const hasCloud = !!(s.lazybirdKey && s.voiceId);
  const speaker = new Speaker({
    synth: hasCloud ? (text, ssml, onTiming) => synthesize(text, s.voiceId, { apiKey: s.lazybirdKey, ssml, onTiming }) : undefined,
    playBlob: playBlobInBrowser,
    fallback: (text, signal, onStart) => browserSpeak(text, signal, onStart, { voiceURI: s.browserVoice, rate: s.browserRate }),
    onBusyChange,
    onAudible,
    route: (kind) => routeFor(s.voiceMode, tierFor(kind), hasCloud),
    cache: hasCloud ? createAudioCache() : null,
    voiceId: s.voiceId,
  });
  speaker.enabled = s.speak;
  return speaker;
}
