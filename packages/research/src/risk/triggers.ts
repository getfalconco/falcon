/**
 * §5 recompute triggers, kept pure so they can be tested without a clock:
 *
 *   - position / cash change          → debounced (60s)
 *   - Tracker close-run for a held name (quantAsOf / lastCloseComputedFor moved)
 *   - band change on an open incident of a held ticker
 *   - a held ticker's scheduled earnings entering / leaving the horizon
 *   - manual
 *
 * The host samples a `RiskTriggerKeys` fingerprint every poll; a change in any
 * key maps to a trigger reason. The scheduler batches reasons per recompute.
 */

import type { RiskLiveInput, RiskPriorityBand, RiskTriggerReason } from "./types.js";

export type RiskTriggerKeys = {
  /** Fingerprint of held tickers + close-run day per ticker. */
  close: string;
  /** Highest open-incident band per held ticker. */
  bands: string;
  /** Held tickers inside the earnings horizon. */
  horizon: string;
};

export type TriggerKeyInputs = {
  held: string[];
  /** Close-run marker per held ticker (quantAsOf / lastCloseComputedFor); null when unknown. */
  closeDay: Record<string, string | null>;
  live: Pick<RiskLiveInput, "open_incidents" | "earnings">;
  horizonSessions: number;
};

const BAND_RANK: Record<RiskPriorityBand, number> = { P0: 3, P1: 2, P2: 1, P3: 0 };

export function computeTriggerKeys(input: TriggerKeyInputs): RiskTriggerKeys {
  const held = [...new Set(input.held.map((t) => t.toUpperCase()))].sort();
  const close = held.map((t) => `${t}:${input.closeDay[t] ?? "-"}`).join(",");
  const best = new Map<string, RiskPriorityBand>();
  for (const inc of input.live.open_incidents) {
    const t = inc.ticker.toUpperCase();
    if (!held.includes(t)) continue;
    const cur = best.get(t);
    if (!cur || BAND_RANK[inc.band] > BAND_RANK[cur]) best.set(t, inc.band);
  }
  const bands = held.map((t) => `${t}:${best.get(t) ?? "-"}`).join(",");
  const inHorizon = new Set<string>();
  for (const e of input.live.earnings) {
    const t = e.ticker.toUpperCase();
    if (!held.includes(t)) continue;
    if (e.sessions_until >= 0 && e.sessions_until <= input.horizonSessions) inHorizon.add(t);
  }
  const horizon = [...inHorizon].sort().join(",");
  return { close, bands, horizon };
}

/** Reasons implied by a key change (empty when nothing moved). */
export function diffTriggerKeys(prev: RiskTriggerKeys | null, next: RiskTriggerKeys): RiskTriggerReason[] {
  if (!prev) return [];
  const reasons: RiskTriggerReason[] = [];
  if (prev.close !== next.close) reasons.push("close_run");
  if (prev.bands !== next.bands) reasons.push("band_change");
  if (prev.horizon !== next.horizon) reasons.push("horizon_change");
  return reasons;
}

export type SchedulerTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type RiskSchedulerOptions = {
  debounceMs: number;
  /** Runs a recompute with the batched reasons. Returns when done. */
  recompute: (reasons: RiskTriggerReason[]) => Promise<void> | void;
  timers?: SchedulerTimers;
};

/**
 * Batches trigger reasons into recomputes: account changes are debounced,
 * key changes and manual requests run at once, and a recompute already in
 * flight absorbs reasons that arrive while it runs (one follow-up, not many).
 */
export class RiskRecomputeScheduler {
  private debounceHandle: unknown = null;
  private pending = new Set<RiskTriggerReason>();
  private running: Promise<void> | null = null;
  private keys: RiskTriggerKeys | null = null;
  private readonly timers: SchedulerTimers;

  constructor(private readonly options: RiskSchedulerOptions) {
    this.timers = options.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
  }

  get lastKeys(): RiskTriggerKeys | null {
    return this.keys;
  }

  /** Seed the fingerprint without triggering (after a startup recompute). */
  prime(keys: RiskTriggerKeys): void {
    this.keys = keys;
  }

  /** A position or cash change: coalesced into one recompute after the debounce. */
  accountChanged(): void {
    if (this.debounceHandle != null) this.timers.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = null;
      this.request(["position_change"]);
    }, this.options.debounceMs);
  }

  /** Compare a freshly sampled fingerprint; recompute when it moved. */
  observe(keys: RiskTriggerKeys): RiskTriggerReason[] {
    const reasons = diffTriggerKeys(this.keys, keys);
    this.keys = keys;
    if (reasons.length > 0) this.request(reasons);
    return reasons;
  }

  /** Run now with the given reasons (manual / startup), batching with anything pending. */
  request(reasons: RiskTriggerReason[]): Promise<void> {
    for (const r of reasons) this.pending.add(r);
    if (this.running) return this.running;
    this.running = this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const reasons = [...this.pending];
        this.pending.clear();
        await this.options.recompute(reasons);
      }
    } finally {
      this.running = null;
    }
  }

  dispose(): void {
    if (this.debounceHandle != null) this.timers.clearTimeout(this.debounceHandle);
    this.debounceHandle = null;
  }
}
