/**
 * Point-in-time quant series (§3) — the history Tracker never kept.
 *
 * Tracker persists ONE latest `QuantContext` per ticker, overwritten every
 * close, so nothing on disk answers "what did this ticker look like on
 * 2023-04-11?". This module rebuilds that answer for every session from the
 * daily bars.
 *
 * It does NOT reimplement the statistics. Screen's `buildSeriesView` is already
 * the point-in-time implementation — it takes an explicit scan session and cuts
 * the bars at it (`completedBars`, the documented no-lookahead rule) — so each
 * snapshot here is literally that function evaluated at one session. That is
 * what makes the equivalence test in series.test.ts a tautology rather than a
 * hopeful comparison of two parallel implementations, and it is why a change to
 * Screen's math can never silently desynchronise the backtester from the panel.
 *
 * Cost: one pass per session over windowed statistics. The inputs are aligned
 * once up front rather than re-derived per session — `completedBars` and
 * `alignBars` are idempotent on already-clean input, so slicing the aligned
 * arrays gives byte-identical results to slicing the raw ones.
 */

import { buildSeriesView } from "../screen/series.js";
import type { ScreenWindows } from "../screen/config.js";
import { alignBars } from "../tracker/quant.js";
import type { DailyBar } from "../tracker/types.js";
import { completedBars } from "../screen/series.js";
import type { QuantSeries, QuantSnapshot, SeriesGap } from "./types.js";

export type BuildQuantSeriesInput = {
  ticker: string;
  bars: DailyBar[];
  benchBars: DailyBar[];
  windows: ScreenWindows;
  /** Only emit snapshots for sessions ≥ this date (the warm-up cut). */
  from?: string;
  /** Only emit snapshots for sessions ≤ this date. */
  to?: string;
};

/**
 * Every session's derived state, oldest first. Sessions the ticker did not
 * trade are absent, never forward-filled (§6): a halted or not-yet-listed name
 * has no close, and inventing one would manufacture a return.
 */
export function buildQuantSeries(input: BuildQuantSeriesInput): QuantSeries {
  const own = completedBars(input.bars, input.to ?? "9999-12-31");
  const bench = completedBars(input.benchBars, input.to ?? "9999-12-31");
  const aligned = alignBars(own, bench);
  const n = aligned.ticker.length;

  const snapshots: QuantSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const session = aligned.ticker[i].d;
    if (input.from && session < input.from) continue;
    const view = buildSeriesView({
      ticker: input.ticker,
      bars: aligned.ticker.slice(0, i + 1),
      benchBars: aligned.bench.slice(0, i + 1),
      session,
      // Only the newest session view is read here; the scalars are unaffected
      // by this window, so asking for one keeps the inner loop minimal.
      windows: { ...input.windows, sessions: 1 },
    });
    const latest = view.sessions[view.sessions.length - 1];
    if (!latest || latest.d !== session) continue;
    snapshots.push({
      d: session,
      open: aligned.ticker[i].o,
      close: latest.close,
      volume: latest.volume,
      ret: latest.ret,
      bench_ret: latest.bench_ret,
      volume_ratio: latest.volume_ratio,
      residual_move: latest.residual_move,
      residual_z: latest.residual_z,
      beta: view.beta,
      r2: view.r2,
      daily_vol: view.daily_vol,
      vol_regime: view.vol_regime,
      momentum_5d: view.momentum_5d,
      momentum_20d: view.momentum_20d,
      range_10s: view.range_10s,
      pct_from_52w_high: view.pct_from_52w_high,
      pct_from_52w_low: view.pct_from_52w_low,
      history_sessions: view.history_sessions,
    });
  }
  return { ticker: input.ticker, snapshots };
}

/** Snapshot as of a session, or null when the ticker did not trade it. */
export function snapshotAt(series: QuantSeries, session: string): QuantSnapshot | null {
  // Series are short enough (≈1,250) that a scan beats carrying an index.
  for (let i = series.snapshots.length - 1; i >= 0; i--) {
    const snap = series.snapshots[i];
    if (snap.d === session) return snap;
    if (snap.d < session) return null;
  }
  return null;
}

/** The most recent snapshot at or before `session` — for "last known state". */
export function snapshotAsOf(series: QuantSeries, session: string): QuantSnapshot | null {
  for (let i = series.snapshots.length - 1; i >= 0; i--) {
    if (series.snapshots[i].d <= session) return series.snapshots[i];
  }
  return null;
}

/**
 * Sessions the benchmark traded but the ticker did not, within the ticker's own
 * covered span. Leading absence (the name had not listed yet) is not a gap —
 * only holes strictly inside the series are, since those are the ones that
 * corrupt a lookback window.
 */
export function detectGaps(
  series: QuantSeries,
  calendarSessions: readonly string[],
  minGapSessions = 1,
): SeriesGap[] {
  if (series.snapshots.length === 0) return [];
  const have = new Set(series.snapshots.map((s) => s.d));
  const first = series.snapshots[0].d;
  const last = series.snapshots[series.snapshots.length - 1].d;

  const gaps: SeriesGap[] = [];
  let runStart: string | null = null;
  let runEnd: string | null = null;
  let runLen = 0;
  for (const session of calendarSessions) {
    if (session < first || session > last) continue;
    if (have.has(session)) {
      if (runStart && runLen >= minGapSessions) gaps.push({ from: runStart, to: runEnd!, sessions: runLen });
      runStart = null;
      runEnd = null;
      runLen = 0;
      continue;
    }
    if (!runStart) runStart = session;
    runEnd = session;
    runLen++;
  }
  if (runStart && runLen >= minGapSessions) gaps.push({ from: runStart, to: runEnd!, sessions: runLen });
  return gaps;
}
