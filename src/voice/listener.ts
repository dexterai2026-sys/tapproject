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
  start(): void;
  stop(): void;
}

export type ListenMode = 'push' | 'wake';

export interface ListenerOptions {
  mode: ListenMode;
  wakeWord: string;
  onUtterance: (text: string) => void;
  onError?: (message: string) => void;
  factory?: () => RecognitionLike;
}

/**
 * One listen-then-parse pipeline for both triggers. Wake-word mode listens
 * continuously and only forwards speech that follows the wake word;
 * push-to-talk listens while the button is held and forwards everything.
 */
export class VoiceListener {
  private rec: RecognitionLike | null = null;
  private active = false;
  muted = false; // set while the app itself is speaking, to avoid hearing itself

  constructor(private o: ListenerOptions) {}

  static isSupported(scope: object = globalThis): boolean {
    return 'SpeechRecognition' in scope || 'webkitSpeechRecognition' in scope;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const rec = (this.o.factory ?? defaultFactory)();
    rec.continuous = this.o.mode === 'wake';
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i] as RecResult;
        if (r.isFinal) this.handle(r[0].transcript);
      }
    };
    rec.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.o.onError?.(`Microphone: ${e.error}`);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.active = false;
    };
    rec.onend = () => {
      if (this.active && this.o.mode === 'wake') {
        try { rec.start(); } catch { /* already restarting */ }
      } else this.active = false;
    };
    this.rec = rec;
    try { rec.start(); } catch (err) { this.active = false; this.o.onError?.((err as Error).message); }
  }

  stop(): void {
    this.active = false;
    this.rec?.stop();
    this.rec = null;
  }

  private handle(transcript: string): void {
    if (this.muted) return;
    const text = this.o.mode === 'wake' ? stripWakeWord(transcript, this.o.wakeWord) : transcript.trim();
    if (text) this.o.onUtterance(text);
  }
}

function defaultFactory(): RecognitionLike {
  const g = globalThis as unknown as Record<string, (new () => RecognitionLike) | undefined>;
  const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  if (!Ctor) throw new Error('Speech recognition is not supported in this browser (use Chrome).');
  return new Ctor();
}
