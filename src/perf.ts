/**
 * Latency tracing for the voice pipeline. Observation only: marks are
 * timestamps on one clock (performance.now), kept in memory, never uploaded.
 */

export interface Mark {
  name: string;
  t: number;
}

export type MetaValue = string | number | boolean;

/** One spoken line. A single interaction can speak several (reaction, confirmation, answer). */
export interface LineTrace {
  index: number;
  kind: string;
  marks: Mark[];
  meta: Record<string, MetaValue>;
}

export interface Trace {
  id: number;
  label: string; // 'voice' | 'tap'
  startedAt: number; // epoch ms, for humans
  marks: Mark[];
  meta: Record<string, MetaValue>;
  lines: LineTrace[];
}

/** What other modules get to record into, without knowing about the tracer. */
export interface TraceRef {
  mark(name: string, t?: number): void;
  markOnce(name: string, t?: number): void;
  meta(key: string, value: MetaValue): void;
  /** Start recording a spoken line. A ref that is already a line returns itself. */
  line(kind: string): TraceRef;
}

export interface Stage {
  key: string;
  label: string;
  ms: number;
}

interface StageSpec {
  key: string;
  label: string;
  from: string;
  to: string;
}

/** Interaction-level stages: from the press to the moment the reply text exists. */
const PARENT_STAGES: StageSpec[] = [
  { key: 'micWarmup', label: 'Mic warm-up', from: 'pressed', to: 'audioStart' },
  { key: 'recognizerFinalize', label: 'Recognizer finalize', from: 'speechEnd', to: 'final' },
  { key: 'parse', label: 'Parse command', from: 'final', to: 'parsed' },
  { key: 'action', label: 'Game action', from: 'parsed', to: 'acted' },
  { key: 'commentary', label: 'Commentary text', from: 'acted', to: 'textReady' },
];

/** Per-spoken-line stages: from the line being queued to it being audible. */
const LINE_STAGES: StageSpec[] = [
  { key: 'queueWait', label: 'Speech queue wait', from: 'queued', to: 'synthStart' },
  { key: 'voiceFirstByte', label: 'Lazybird first byte', from: 'synthStart', to: 'synthFirstByte' },
  { key: 'voiceDownload', label: 'Lazybird download', from: 'synthFirstByte', to: 'synthDone' },
  { key: 'playbackStart', label: 'Playback start', from: 'synthDone', to: 'playStart' },
  { key: 'browserVoiceStart', label: 'Browser voice start', from: 'fallbackStart', to: 'playStart' },
];

export const STAGE_LABELS: Record<string, string> = Object.fromEntries([...PARENT_STAGES, ...LINE_STAGES].map((s) => [s.key, s.label]));

const markAt = (marks: Mark[], name: string): number | undefined => marks.find((m) => m.name === name)?.t;

/** First mark that exists, in priority order. Used to pick "the moment the user finished asking". */
function firstOf(marks: Mark[], names: string[]): number | undefined {
  for (const n of names) {
    const t = markAt(marks, n);
    if (t !== undefined) return t;
  }
  return undefined;
}

function computeStages(marks: Mark[], specs: StageSpec[], keySuffix = '', labelSuffix = ''): Stage[] {
  const out: Stage[] = [];
  for (const s of specs) {
    const a = markAt(marks, s.from);
    const b = markAt(marks, s.to);
    if (a !== undefined && b !== undefined && b >= a) out.push({ key: s.key + keySuffix, label: s.label + labelSuffix, ms: Math.round(b - a) });
  }
  return out;
}

const askedAt = (trace: Trace): number | undefined => firstOf(trace.marks, ['speechEnd', 'final', 'input']);

export interface LineInfo {
  index: number;
  kind: string;
  chars?: number;
  voicePath?: string;
  audioBytes?: number;
  stages: Stage[];
  soundAtMs?: number; // end of speech -> this line audible
  lastedMs?: number; // how long it played
  gapMs?: number; // previous line ended -> this line started
  outputLatencyMs?: number; // device latency Chrome reports for the audio output, when available
}

const num = (v: MetaValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);

/** Per-line breakdown, in the order the lines were spoken. */
export function lineInfoOf(trace: Trace): LineInfo[] {
  const asked = askedAt(trace);
  let prevEnd: number | undefined;
  return trace.lines.map((l, i) => {
    const play = markAt(l.marks, 'playStart');
    const end = markAt(l.marks, 'playEnd');
    const info: LineInfo = {
      index: i,
      kind: l.kind,
      chars: num(l.meta.textChars),
      voicePath: typeof l.meta.voicePath === 'string' ? l.meta.voicePath : undefined,
      audioBytes: num(l.meta.audioBytes),
      stages: computeStages(l.marks, LINE_STAGES, i === 0 ? '' : `@${i + 1}`, i === 0 ? '' : ` (line ${i + 1})`),
      outputLatencyMs: num(l.meta.outputLatencyMs),
    };
    if (asked !== undefined && play !== undefined) info.soundAtMs = Math.round(play - asked);
    if (play !== undefined && end !== undefined) info.lastedMs = Math.round(end - play);
    if (prevEnd !== undefined && play !== undefined) info.gapMs = Math.round(play - prevEnd);
    if (end !== undefined) prevEnd = end;
    return info;
  });
}

export function stagesOf(trace: Trace): Stage[] {
  return [...computeStages(trace.marks, PARENT_STAGES), ...lineInfoOf(trace).flatMap((l) => l.stages)];
}

export interface Headline {
  toScreenMs?: number; // end of speech -> first screen update
  toFirstSoundMs?: number; // end of speech -> first audible line (browser's "playing" event)
  outputLatencyMs?: number; // reported device output latency for that first line
  toEarMs?: number; // toFirstSoundMs + outputLatencyMs: an estimate of when it reaches the ear
  playbackMs?: number; // how long the first line lasted
  allLinesDoneMs?: number; // end of speech -> the last line finished
}

export function headlineOf(trace: Trace): Headline {
  const asked = askedAt(trace);
  const screen = markAt(trace.marks, 'screenUpdated');
  const lines = lineInfoOf(trace);
  const h: Headline = {};
  if (asked !== undefined && screen !== undefined) h.toScreenMs = Math.round(screen - asked);
  const audible = lines.filter((l) => l.soundAtMs !== undefined);
  if (audible.length) {
    const first = audible.reduce((a, b) => ((b.soundAtMs as number) < (a.soundAtMs as number) ? b : a));
    h.toFirstSoundMs = first.soundAtMs;
    if (first.lastedMs !== undefined) h.playbackMs = first.lastedMs;
    if (first.outputLatencyMs !== undefined) {
      h.outputLatencyMs = first.outputLatencyMs;
      h.toEarMs = (first.soundAtMs as number) + first.outputLatencyMs;
    }
  }
  // Only once every line has finished: reporting it while a line is still pending would understate it.
  const ends = trace.lines.map((l) => markAt(l.marks, 'playEnd'));
  if (asked !== undefined && ends.length && ends.every((t) => t !== undefined)) h.allLinesDoneMs = Math.round(Math.max(...(ends as number[])) - asked);
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

/** Median and p90 per stage (and for the headline numbers) across traces. */
export function summarize(traces: Trace[]): {
  stages: StageSummary[];
  toScreen?: StageSummary;
  toFirstSound?: StageSummary;
  toEar?: StageSummary;
  allLinesDone?: StageSummary;
} {
  const values = new Map<string, number[]>();
  const labels = new Map<string, string>(); // insertion order = first-seen order
  const push = (map: Map<string, number[]>, key: string, v: number | undefined) => {
    if (v !== undefined) map.set(key, [...(map.get(key) ?? []), v]);
  };
  const head = new Map<string, number[]>();
  for (const t of traces) {
    for (const s of stagesOf(t)) {
      labels.set(s.key, s.label);
      push(values, s.key, s.ms);
    }
    const h = headlineOf(t);
    push(head, 'toScreen', h.toScreenMs);
    push(head, 'toFirstSound', h.toFirstSoundMs);
    push(head, 'toEar', h.toEarMs);
    push(head, 'allLinesDone', h.allLinesDoneMs);
  }
  const mk = (key: string, label: string, v: number[]): StageSummary => ({ key, label, n: v.length, median: percentile(v, 50), p90: percentile(v, 90) });
  const one = (key: string, label: string) => (head.has(key) ? mk(key, label, head.get(key) as number[]) : undefined);
  return {
    stages: [...labels.keys()].map((k) => mk(k, labels.get(k) as string, values.get(k) as number[])),
    toScreen: one('toScreen', 'Speech end → screen'),
    toFirstSound: one('toFirstSound', 'Speech end → first sound'),
    toEar: one('toEar', 'Speech end → ear (incl. output latency)'),
    allLinesDone: one('allLinesDone', 'Speech end → all lines done'),
  };
}

const CAP = 50;

export class Tracer {
  private traces: Trace[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = () => performance.now(), private wall: () => number = Date.now) {}

  start(label: string): number {
    const trace: Trace = { id: this.nextId++, label, startedAt: this.wall(), marks: [], meta: {}, lines: [] };
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

  private target(id: number, line?: number): { marks: Mark[]; meta: Record<string, MetaValue> } | undefined {
    const tr = this.get(id);
    return line === undefined ? tr : tr?.lines[line];
  }

  mark(id: number, name: string, t = this.now(), line?: number): void {
    this.target(id, line)?.marks.push({ name, t });
    this.changed();
  }

  markOnce(id: number, name: string, t = this.now(), line?: number): void {
    const tg = this.target(id, line);
    if (tg && !tg.marks.some((m) => m.name === name)) this.mark(id, name, t, line);
  }

  setMeta(id: number, key: string, value: MetaValue, line?: number): void {
    const tg = this.target(id, line);
    if (tg) tg.meta[key] = value;
    this.changed();
  }

  /** Begin a spoken line on a trace; returns its index. */
  addLine(id: number, kind: string): number {
    const tr = this.get(id);
    if (!tr) return -1;
    tr.lines.push({ index: tr.lines.length, kind, marks: [], meta: {} });
    this.changed();
    return tr.lines.length - 1;
  }

  /** A handle other modules can record into without importing the tracer. */
  ref(id: number, line?: number): TraceRef {
    const self: TraceRef = {
      mark: (name, t) => this.mark(id, name, t, line),
      markOnce: (name, t) => this.markOnce(id, name, t, line),
      meta: (k, v) => this.setMeta(id, k, v, line),
      line: (kind) => (line === undefined ? this.ref(id, this.addLine(id, kind)) : self),
    };
    return self;
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
  outputLatency?: string; // how the output latency was obtained, e.g. "outputLatency" or "none"
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
      lines: lineInfoOf(t).map((l) => ({
        index: l.index + 1,
        kind: l.kind,
        chars: l.chars,
        voicePath: l.voicePath,
        audioBytes: l.audioBytes,
        soundAtMs: l.soundAtMs,
        lastedMs: l.lastedMs,
        gapMs: l.gapMs,
        outputLatencyMs: l.outputLatencyMs,
        stages: Object.fromEntries(l.stages.map((s) => [s.key, s.ms])),
      })),
    })),
  };
}
