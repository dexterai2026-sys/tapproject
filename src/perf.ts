/**
 * Latency tracing for the voice pipeline. Observation only: marks are
 * timestamps on one clock (performance.now), kept in memory, never uploaded.
 */

export interface Mark {
  name: string;
  t: number;
}

export type MetaValue = string | number | boolean;

export interface Trace {
  id: number;
  label: string; // 'voice' | 'tap'
  startedAt: number; // epoch ms, for humans
  marks: Mark[];
  meta: Record<string, MetaValue>;
}

/** What other modules get to record into, without knowing about the tracer. */
export interface TraceRef {
  mark(name: string, t?: number): void;
  markOnce(name: string, t?: number): void;
  meta(key: string, value: MetaValue): void;
}

export interface Stage {
  key: string;
  label: string;
  ms: number;
}

/** Ordered pipeline stages: each is the gap between two marks, shown only when both exist. */
const STAGES: { key: string; label: string; from: string; to: string }[] = [
  { key: 'micWarmup', label: 'Mic warm-up', from: 'pressed', to: 'audioStart' },
  { key: 'recognizerFinalize', label: 'Recognizer finalize', from: 'speechEnd', to: 'final' },
  { key: 'parse', label: 'Parse command', from: 'final', to: 'parsed' },
  { key: 'action', label: 'Game action', from: 'parsed', to: 'acted' },
  { key: 'commentary', label: 'Commentary text', from: 'acted', to: 'textReady' },
  { key: 'queueWait', label: 'Speech queue wait', from: 'queued', to: 'synthStart' },
  { key: 'voiceFirstByte', label: 'Lazybird first byte', from: 'synthStart', to: 'synthFirstByte' },
  { key: 'voiceDownload', label: 'Lazybird download', from: 'synthFirstByte', to: 'synthDone' },
  { key: 'playbackStart', label: 'Playback start', from: 'synthDone', to: 'playStart' },
  { key: 'browserVoiceStart', label: 'Browser voice start', from: 'fallbackStart', to: 'playStart' },
];

export const STAGE_LABELS: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

const markAt = (trace: Trace, name: string): number | undefined => trace.marks.find((m) => m.name === name)?.t;

/** First mark that exists, in priority order. Used to pick "the moment the user finished asking". */
function firstOf(trace: Trace, names: string[]): number | undefined {
  for (const n of names) {
    const t = markAt(trace, n);
    if (t !== undefined) return t;
  }
  return undefined;
}

export function stagesOf(trace: Trace): Stage[] {
  const out: Stage[] = [];
  for (const s of STAGES) {
    const a = markAt(trace, s.from);
    const b = markAt(trace, s.to);
    if (a !== undefined && b !== undefined && b >= a) out.push({ key: s.key, label: s.label, ms: Math.round(b - a) });
  }
  return out;
}

export interface Headline {
  toScreenMs?: number; // end of speech -> first screen update
  toFirstSoundMs?: number; // end of speech -> something audible
  playbackMs?: number; // how long the spoken line lasted
}

export function headlineOf(trace: Trace): Headline {
  const asked = firstOf(trace, ['speechEnd', 'final', 'input']);
  const screen = markAt(trace, 'screenUpdated');
  const sound = firstOf(trace, ['playStart']);
  const end = markAt(trace, 'playEnd');
  const h: Headline = {};
  if (asked !== undefined && screen !== undefined) h.toScreenMs = Math.round(screen - asked);
  if (asked !== undefined && sound !== undefined) h.toFirstSoundMs = Math.round(sound - asked);
  if (sound !== undefined && end !== undefined) h.playbackMs = Math.round(end - sound);
  return h;
}

export function slowest(stages: Stage[]): Stage | undefined {
  return stages.reduce<Stage | undefined>((best, s) => (!best || s.ms > best.ms ? s : best), undefined);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

export interface StageSummary {
  key: string;
  label: string;
  n: number;
  median: number;
  p90: number;
}

/** Median and p90 per stage (and for the two headline numbers) across traces. */
export function summarize(traces: Trace[]): { stages: StageSummary[]; toScreen?: StageSummary; toFirstSound?: StageSummary } {
  const byKey = new Map<string, number[]>();
  const screen: number[] = [];
  const sound: number[] = [];
  for (const t of traces) {
    for (const s of stagesOf(t)) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s.ms]);
    const h = headlineOf(t);
    if (h.toScreenMs !== undefined) screen.push(h.toScreenMs);
    if (h.toFirstSoundMs !== undefined) sound.push(h.toFirstSoundMs);
  }
  const mk = (key: string, label: string, v: number[]): StageSummary => ({ key, label, n: v.length, median: percentile(v, 50), p90: percentile(v, 90) });
  return {
    stages: STAGES.filter((s) => byKey.has(s.key)).map((s) => mk(s.key, s.label, byKey.get(s.key) as number[])),
    toScreen: screen.length ? mk('toScreen', 'Speech end → screen', screen) : undefined,
    toFirstSound: sound.length ? mk('toFirstSound', 'Speech end → first sound', sound) : undefined,
  };
}

const CAP = 50;

export class Tracer {
  private traces: Trace[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = () => performance.now(), private wall: () => number = Date.now) {}

  start(label: string): number {
    const trace: Trace = { id: this.nextId++, label, startedAt: this.wall(), marks: [], meta: {} };
    this.traces.push(trace);
    // Cap per label so a burst of taps can never push the voice traces out.
    const same = this.traces.filter((t) => t.label === label);
    if (same.length > CAP) this.traces.splice(this.traces.indexOf(same[0] as Trace), 1);
    this.changed();
    return trace.id;
  }

  get(id: number): Trace | undefined {
    return this.traces.find((t) => t.id === id);
  }

  mark(id: number, name: string, t = this.now()): void {
    this.get(id)?.marks.push({ name, t });
    this.changed();
  }

  markOnce(id: number, name: string, t = this.now()): void {
    const tr = this.get(id);
    if (tr && !tr.marks.some((m) => m.name === name)) this.mark(id, name, t);
  }

  setMeta(id: number, key: string, value: MetaValue): void {
    const tr = this.get(id);
    if (tr) tr.meta[key] = value;
    this.changed();
  }

  /** A handle other modules can record into without importing the tracer. */
  ref(id: number): TraceRef {
    return {
      mark: (name, t) => this.mark(id, name, t),
      markOnce: (name, t) => this.markOnce(id, name, t),
      meta: (k, v) => this.setMeta(id, k, v),
    };
  }

  all(): Trace[] {
    return [...this.traces];
  }

  last(): Trace | undefined {
    return this.traces[this.traces.length - 1];
  }

  /** The most recent trace that produced anything measurable, optionally of one label. */
  lastMeasured(label?: string): Trace | undefined {
    for (let i = this.traces.length - 1; i >= 0; i--) {
      const t = this.traces[i] as Trace;
      if (label && t.label !== label) continue;
      if (stagesOf(t).length || Object.keys(headlineOf(t)).length) return t;
    }
    return undefined;
  }

  clear(): void {
    this.traces = [];
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const l of [...this.listeners]) l();
  }
}

export const tracer = new Tracer();

export interface ExportContext {
  userAgent: string;
  mic: string;
  commentary: string;
  voice: 'lazybird' | 'browser';
  speak: boolean;
}

/** Shareable results. Contains timings and settings labels only: no keys, no transcripts. */
export function exportResults(traces: Trace[], ctx: ExportContext) {
  return {
    app: 'tap-cards',
    exportedAt: new Date().toISOString(),
    context: ctx,
    summary: summarize(traces),
    traces: traces.map((t) => ({
      label: t.label,
      startedAt: new Date(t.startedAt).toISOString(),
      meta: t.meta,
      headline: headlineOf(t),
      stages: Object.fromEntries(stagesOf(t).map((s) => [s.key, s.ms])),
    })),
  };
}
