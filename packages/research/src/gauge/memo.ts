/**
 * The optional 60s memo per (ticker, context-hash) (§7) — avoids recompute
 * storms on panel refresh — and the log-only daily counter of readouts by
 * surface and state (observability, nothing persisted).
 */

import type { GaugeContext, GaugeReadout, GaugeSurface } from "./types.js";

export function contextHash(context: GaugeContext | null | undefined): string {
  if (!context) return "standalone";
  return JSON.stringify({
    d: context.expected_direction ?? null,
    e: context.event_ts ?? "",
    s: context.source,
    p: context.pricing_status ?? null,
    n: context.sessions_since_event ?? null,
    t: Boolean(context.thesis_is_scheduled_event),
  });
}

export function memoKey(ticker: string, context: GaugeContext | null | undefined): string {
  return `${ticker.trim().toUpperCase()}|${contextHash(context)}`;
}

export class GaugeMemo {
  private readonly entries = new Map<string, { at: number; readout: GaugeReadout }>();

  constructor(private ttlMs: number) {}

  setTtl(ms: number): void {
    this.ttlMs = ms;
  }

  get(key: string, nowMs: number): GaugeReadout | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (nowMs - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.readout;
  }

  set(key: string, readout: GaugeReadout, nowMs: number): void {
    this.entries.set(key, { at: nowMs, readout });
    // Bounded: drop anything expired when the map grows past a few hundred keys.
    if (this.entries.size > 512) {
      for (const [k, v] of this.entries) if (nowMs - v.at > this.ttlMs) this.entries.delete(k);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export type GaugeDailyCounter = {
  day: string;
  total: number;
  by_surface: Record<string, number>;
  by_state: Record<string, number>;
  memo_hits: number;
};

export function emptyCounter(day: string): GaugeDailyCounter {
  return { day, total: 0, by_surface: {}, by_state: {}, memo_hits: 0 };
}

/** In-memory daily tally; the host logs it on day rollover and exposes it on status. */
export class GaugeCounters {
  private counter: GaugeDailyCounter;

  constructor(day: string) {
    this.counter = emptyCounter(day);
  }

  /** Returns the closed-out counter when the day rolled over (for the log line), else null. */
  record(day: string, surface: GaugeSurface, readout: GaugeReadout | null, memoHit: boolean): GaugeDailyCounter | null {
    let closed: GaugeDailyCounter | null = null;
    if (day !== this.counter.day) {
      closed = this.counter;
      this.counter = emptyCounter(day);
    }
    const c = this.counter;
    c.total += 1;
    c.by_surface[surface] = (c.by_surface[surface] ?? 0) + 1;
    const state = readout ? (readout.tracked ? readout.summary.overall ?? "untracked" : "untracked") : "error";
    c.by_state[state] = (c.by_state[state] ?? 0) + 1;
    if (memoHit) c.memo_hits += 1;
    return closed;
  }

  snapshot(): GaugeDailyCounter {
    return structuredClone(this.counter);
  }
}
