/**
 * Output latency: the delay between the browser handing audio to the platform
 * and sound coming out of the device (large over Bluetooth). Chrome exposes it
 * through the Web Audio clock where supported; we read it, never guess it.
 */

export interface LatencyCtxLike {
  currentTime: number;
  baseLatency?: number;
  outputLatency?: number;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
  resume?: () => Promise<void>;
}

export interface LatencyReading {
  outputMs?: number;
  baseMs?: number;
  /** 'outputLatency' = the browser reported it; 'timestamp' = derived from the output clock; 'none' = unavailable. */
  source: 'outputLatency' | 'timestamp' | 'none';
}

const MAX_PLAUSIBLE_S = 2; // anything larger is a stale or broken clock reading, not a real device delay

export function readLatency(ctx: LatencyCtxLike | null): LatencyReading {
  if (!ctx) return { source: 'none' };
  const baseMs = typeof ctx.baseLatency === 'number' && ctx.baseLatency > 0 ? Math.round(ctx.baseLatency * 1000) : undefined;
  if (typeof ctx.outputLatency === 'number' && ctx.outputLatency > 0 && ctx.outputLatency < MAX_PLAUSIBLE_S) {
    return { outputMs: Math.round(ctx.outputLatency * 1000), baseMs, source: 'outputLatency' };
  }
  try {
    const ts = ctx.getOutputTimestamp?.();
    if (ts && typeof ts.contextTime === 'number' && ts.contextTime > 0) {
      const lat = ctx.currentTime - ts.contextTime; // how far the written audio is ahead of what's coming out
      if (Number.isFinite(lat) && lat > 0 && lat < MAX_PLAUSIBLE_S) return { outputMs: Math.round(lat * 1000), baseMs, source: 'timestamp' };
    }
  } catch {
    /* not supported */
  }
  return { baseMs, source: 'none' };
}

export interface LatencyProbe {
  /** Call from a user gesture so the context is allowed to run. */
  prime(): void;
  read(): LatencyReading;
  close(): void;
}

function defaultCtx(): LatencyCtxLike | null {
  const g = globalThis as unknown as Record<string, (new () => LatencyCtxLike) | undefined>;
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

export function createLatencyProbe(factory: () => LatencyCtxLike | null = defaultCtx): LatencyProbe {
  let ctx: LatencyCtxLike | null = null;
  return {
    prime() {
      try {
        ctx ??= factory();
        void ctx?.resume?.();
      } catch {
        ctx = null;
      }
    },
    read: () => readLatency(ctx),
    close() {
      try {
        (ctx as unknown as { close?: () => void } | null)?.close?.();
      } catch {
        /* ignore */
      }
      ctx = null;
    },
  };
}
