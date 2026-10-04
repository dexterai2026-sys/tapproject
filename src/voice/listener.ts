import { stripWakeWord } from './command';

interface RecResult { isFinal: boolean; 0: { transcript: string } }
interface RecEvent { resultIndex: number; results: ArrayLike<RecResult> }
export interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onaudiostart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

export type ListenMode = 'push' | 'wake';

export interface ListenerOptions {
  mode: ListenMode;
  wakeWord: string;
  onUtterance: (text: string) => void;
  onError?: (message: string) => void;
  /** Called when listening starts or stops (drives the "Listening…" indicator). */
  onListening?: (on: boolean) => void;
  /** Raw recognizer milestones, for latency tracing. Observation only. */
  onTiming?: (event: 'audioStart' | 'speechStart' | 'speechEnd' | 'interim') => void;
  /** A final transcript was heard but not acted on (no wake word, or muted). */
  onDiscard?: () => void;
  /** Called once when repeated failures make the listener stop trying. */
  onGiveUp?: () => void;
  factory?: () => RecognitionLike;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
}

export const MAX_FAILURES = 5;
export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 30_000;
export const RESUME_TAIL_MS = 350; // after the app stops talking, wait this long before the mic reopens
const QUICK_END_MS = 1000; // a session that dies this fast with no result counts as a failure

/** Delay before the nth consecutive restart (n starts at 1): 0.5s, 1s, 2s … capped at 30s. */
export function backoffDelay(failures: number): number {
  return failures <= 0 ? 0 : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - 1));
}

/**
 * One listen-then-parse pipeline for both triggers. Wake-word mode listens
 * continuously and only forwards speech that follows the wake word;
 * push-to-talk listens while the button is held and forwards everything.
 * Wake mode restarts itself with exponential backoff and gives up after
 * repeated failures instead of hammering the speech service.
 */
export class VoiceListener {
  private rec: RecognitionLike | null = null;
  private active = false;
  private failures = 0;
  private timer: unknown = null;
  private startedAt = 0;
  private gotResult = false;
  private errored = false;
  muted = false; // safety net: transcripts heard while the app speaks are dropped
  private paused = false;

  constructor(private o: ListenerOptions) {}

  static isSupported(scope: object = globalThis): boolean {
    return 'SpeechRecognition' in scope || 'webkitSpeechRecognition' in scope;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Start (or retry after giving up). A manual start always resets the failure count. */
  start(): void {
    this.cancelTimer();
    this.failures = 0;
    this.begin();
  }

  /**
   * Really close the mic while the app speaks. An open mic switches phones to call-style audio, which
   * ducks or cuts the app's own playback, so dropping transcripts (`muted`) is not enough. Wake mode only.
   */
  pause(): void {
    if (!this.active || this.o.mode !== 'wake' || this.paused) return;
    this.paused = true;
    this.cancelTimer();
    try {
      (this.rec?.abort ?? this.rec?.stop)?.call(this.rec);
    } catch {
      /* already stopped */
    }
  }

  /** Reopen the mic after a short tail so the end of the app's own voice isn't heard. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.cancelTimer();
    const rec = this.rec;
    const go = () => {
      this.timer = null;
      if (!this.active || this.paused || this.rec !== rec || !rec) return;
      this.startedAt = (this.o.now ?? Date.now)();
      this.gotResult = false;
      this.errored = false;
      try {
        rec.start();
      } catch {
        /* still shutting down: its end event restarts it */
      }
    };
    this.timer = (this.o.schedule ?? ((fn, ms) => setTimeout(fn, ms)))(go, RESUME_TAIL_MS);
  }

  stop(): void {
    this.paused = false;
    this.active = false;
    this.cancelTimer();
    this.rec?.stop();
    this.rec = null;
    this.o.onListening?.(false);
  }

  private begin(): void {
    if (this.active && this.rec) return;
    this.active = true;
    const rec = (this.o.factory ?? defaultFactory)();
    rec.continuous = this.o.mode === 'wake';
    rec.interimResults = true; // partial results give us a start-of-recognition timestamp when Chrome sends no speechend
    rec.lang = 'en-US';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i] as RecResult;
        if (r.isFinal) {
          this.gotResult = true;
          this.failures = 0;
          this.handle(r[0].transcript);
        } else {
          this.o.onTiming?.('interim');
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // normal, not a failure
      this.errored = true;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false; // permission problems won't fix themselves
        this.o.onError?.(`Microphone: ${e.error}`);
        return;
      }
      this.failures++;
      this.o.onError?.(`Microphone: ${e.error}`);
    };
    rec.onaudiostart = () => this.o.onTiming?.('audioStart');
    rec.onspeechstart = () => this.o.onTiming?.('speechStart');
    rec.onspeechend = () => this.o.onTiming?.('speechEnd');
    rec.onend = () => this.onEnd(rec);
    this.rec = rec;
    this.startedAt = (this.o.now ?? Date.now)();
    this.gotResult = false;
    this.errored = false;
    try {
      rec.start();
      this.o.onListening?.(true);
    } catch (err) {
      this.active = false;
      this.o.onError?.((err as Error).message);
    }
  }

  private onEnd(rec: RecognitionLike): void {
    if (rec !== this.rec) return;
    if (this.paused) return; // we closed it on purpose; resume() reopens it, and this is not a failure
    if (!this.active || this.o.mode !== 'wake') {
      this.active = false;
      this.o.onListening?.(false);
      return;
    }
    const quick = (this.o.now ?? Date.now)() - this.startedAt < QUICK_END_MS;
    if (!this.errored && !this.gotResult && quick) this.failures++;
    if (this.failures >= MAX_FAILURES) {
      this.active = false;
      this.rec = null;
      this.o.onListening?.(false);
      this.o.onError?.('Voice is unavailable right now (offline?). Tap to retry.');
      this.o.onGiveUp?.();
      return;
    }
    const delay = backoffDelay(this.failures);
    const restart = () => {
      this.timer = null;
      if (!this.active || this.rec !== rec) return;
      this.startedAt = (this.o.now ?? Date.now)();
      this.gotResult = false;
      this.errored = false;
      try {
        rec.start();
      } catch {
        /* already restarting */
      }
    };
    if (delay === 0) restart();
    else this.timer = (this.o.schedule ?? ((fn, ms) => setTimeout(fn, ms)))(restart, delay);
  }

  private cancelTimer(): void {
    if (this.timer != null) (this.o.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private handle(transcript: string): void {
    const text = this.muted ? null : this.o.mode === 'wake' ? stripWakeWord(transcript, this.o.wakeWord) : transcript.trim();
    if (text) this.o.onUtterance(text);
    else this.o.onDiscard?.();
  }
}

function defaultFactory(): RecognitionLike {
  const g = globalThis as unknown as Record<string, (new () => RecognitionLike) | undefined>;
  const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  if (!Ctor) throw new Error('Speech recognition is not supported in this browser (use Chrome).');
  return new Ctor();
}
