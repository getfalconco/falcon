/**
 * Anomaly detectors (§5). Pure decision functions: they take state + measured
 * values and return whether to fire plus the mutated detector state. No I/O,
 * no message construction — the engine owns both.
 *
 * Two firing classes:
 *  - Snapshot (gap, volume, unexplained_move): at most once per trading day,
 *    unless the new value exceeds `escalationMultiple` × the last fired value.
 *  - Edge-triggered (silence, filing_overdue, drift, news_burst,
 *    insider_cluster): fire on the false→true transition; while true, re-fire
 *    only on escalation. On false, reset and re-arm.
 */

import { addTradingDays, calendarDaysBetween, isTradingDay, tradingDaysBetween } from "./calendar.js";
import type { TrackerConfig } from "./config.js";
import { medianFilingLag } from "./math.js";
import type {
  EdgeDetectorState,
  InsiderClusterDetectorState,
  SnapshotDetectorState,
} from "./types.js";

export type FireDecision = {
  fire: boolean;
  /** True when this fire is an escalation of an already-reported condition. */
  escalated: boolean;
};

/** §5 snapshot firing model. */
export function decideSnapshotFire(
  state: SnapshotDetectorState,
  todayYmd: string,
  value: number,
  escalationMultiple: number,
): FireDecision {
  const magnitude = Math.abs(value);
  if (state.lastFiredDay !== todayYmd) return { fire: true, escalated: false };
  const previous = state.lastFiredValue == null ? null : Math.abs(state.lastFiredValue);
  if (previous != null && previous > 0 && magnitude > escalationMultiple * previous) {
    return { fire: true, escalated: true };
  }
  return { fire: false, escalated: false };
}

export function applySnapshotFire(todayYmd: string, value: number): SnapshotDetectorState {
  return { lastFiredDay: todayYmd, lastFiredValue: value };
}

/** §5 edge-triggered firing model. */
export function decideEdgeFire(
  state: EdgeDetectorState,
  conditionTrue: boolean,
  value: number | null,
  escalationMultiple: number,
): FireDecision {
  if (!conditionTrue) return { fire: false, escalated: false };
  if (!state.active) return { fire: true, escalated: false };
  const previous = state.lastFiredValue == null ? null : Math.abs(state.lastFiredValue);
  const magnitude = value == null ? null : Math.abs(value);
  if (
    previous != null &&
    magnitude != null &&
    previous > 0 &&
    magnitude > escalationMultiple * previous
  ) {
    return { fire: true, escalated: true };
  }
  return { fire: false, escalated: false };
}

export function applyEdgeTransition(
  state: EdgeDetectorState,
  conditionTrue: boolean,
  fired: boolean,
  value: number | null,
  nowIso: string,
  todayYmd: string,
): EdgeDetectorState {
  if (!conditionTrue) {
    // Condition released — re-arm and record the day it went false
    // (hysteresis). `lastFiredValue` is deliberately preserved: it is the
    // record of what triggered the last fire, and `active: false` already
    // tells decideEdgeFire to treat the next trigger as a fresh transition.
    return {
      active: false,
      lastFiredAt: state.lastFiredAt,
      lastFiredValue: state.lastFiredValue,
      falseSinceDay: state.active || state.falseSinceDay == null ? todayYmd : state.falseSinceDay,
    };
  }
  return {
    active: true,
    lastFiredAt: fired ? nowIso : state.lastFiredAt,
    // A fire always records its triggering value — escalation compares against
    // it, so a null here would disable the 1.5x rule for the whole episode.
    lastFiredValue: fired ? value : state.lastFiredValue,
    falseSinceDay: state.falseSinceDay,
  };
}

// ---------------------------------------------------------------------------
// §5.1 Gap
// ---------------------------------------------------------------------------

export function gapTriggered(gapZ: number | null, config: TrackerConfig): boolean {
  return gapZ != null && Math.abs(gapZ) > config.thresholds.gapZ;
}

// ---------------------------------------------------------------------------
// §5.2 Volume anomaly
// ---------------------------------------------------------------------------

export function volumeTriggered(
  volumeRatio: number | null,
  partial: boolean,
  config: TrackerConfig,
): boolean {
  // Never evaluate a partial ratio — a mid-session ratio is not comparable
  // to a full-day baseline (§4 volume_ratio_partial).
  if (partial) return false;
  return volumeRatio != null && volumeRatio > config.thresholds.volumeRatio;
}

// ---------------------------------------------------------------------------
// §5.3 Silence
// ---------------------------------------------------------------------------

export type SilenceEvaluation = {
  conditionTrue: boolean;
  baselineRate: number | null;
  tradingDaysSilent: number;
};

/**
 * Baseline ≥ 1 article/day over the 30-trading-day window AND zero articles
 * for ≥ 3 consecutive trading days. Null baseline (insufficient history)
 * disables the detector (§3.11).
 */
export function evaluateSilence(
  newsCounts: Record<string, number>,
  todayYmd: string,
  config: TrackerConfig,
): SilenceEvaluation {
  const baselineRate = newsBaselineRate(newsCounts, todayYmd, config);
  if (baselineRate == null) {
    return { conditionTrue: false, baselineRate: null, tradingDaysSilent: 0 };
  }
  let silent = 0;
  let day = todayYmd;
  for (let i = 0; i < 60; i++) {
    if (!isTradingDay(day)) {
      day = addTradingDays(day, -1);
      continue;
    }
    if ((newsCounts[day] ?? 0) > 0) break;
    silent++;
    day = addTradingDays(day, -1);
  }
  const conditionTrue =
    baselineRate >= config.thresholds.silenceMinBaselinePerDay &&
    silent >= config.thresholds.silenceTradingDays;
  return { conditionTrue, baselineRate, tradingDaysSilent: silent };
}

/**
 * Trailing article rate per trading day (§1 news-rate baseline). Null when
 * the 30-trading-day window is not fully covered (§3.11).
 */
export function newsBaselineRate(
  newsCounts: Record<string, number>,
  todayYmd: string,
  config: TrackerConfig,
): number | null {
  const window = config.windows.newsBaselineTradingDays;
  let day = addTradingDays(todayYmd, -1);
  let total = 0;
  let covered = 0;
  for (let i = 0; i < window; i++) {
    if (!(day in newsCounts)) return null; // window not fully covered
    total += newsCounts[day];
    covered++;
    day = addTradingDays(day, -1);
  }
  if (covered < window) return null;
  return total / window;
}

// ---------------------------------------------------------------------------
// §5.4 Filing overdue
// ---------------------------------------------------------------------------

export type FilingOverdueEvaluation = {
  conditionTrue: boolean;
  expectedForm: string;
  expectedByDate: string | null;
  businessDaysOverdue: number;
  medianLagDays: number | null;
};

/**
 * Expected periodic filing exceeds the median historical lag (past 8 filings)
 * by more than 10 business days. Requires ≥ 4 lag observations (§3.11).
 */
export function evaluateFilingOverdue(
  filings: Array<{ form: string; filedAt: string; reportDate: string | null }>,
  todayYmd: string,
  config: TrackerConfig,
): FilingOverdueEvaluation {
  const periodic = filings
    .filter((f) => (f.form === "10-Q" || f.form === "10-K") && f.reportDate && f.filedAt)
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt));

  const empty: FilingOverdueEvaluation = {
    conditionTrue: false,
    expectedForm: "10-Q",
    expectedByDate: null,
    businessDaysOverdue: 0,
    medianLagDays: null,
  };
  if (periodic.length === 0) return empty;

  const history = periodic.slice(-config.thresholds.filingLagHistoryCount);
  const lags = history.map((f) => calendarDaysBetween(f.reportDate as string, f.filedAt));
  const medianLag = medianFilingLag(lags);
  if (medianLag == null) return empty;

  // Next period ends roughly one quarter after the last reported period end.
  const last = periodic[periodic.length - 1];
  const lastPeriodEnd = last.reportDate as string;
  const nextPeriodEnd = addQuarter(lastPeriodEnd);
  // Nothing is overdue until the period itself has ended.
  if (todayYmd <= nextPeriodEnd) {
    return { ...empty, medianLagDays: medianLag };
  }
  const expectedBy = addCalendarDaysYmd(nextPeriodEnd, Math.round(medianLag));
  const overdue = businessDaysBetween(expectedBy, todayYmd);
  // Three of every four periods are 10-Q; the fourth (fiscal year end) is 10-K.
  const expectedForm = expectedFormAfter(periodic);
  return {
    conditionTrue: overdue > config.thresholds.filingOverdueBusinessDays,
    expectedForm,
    expectedByDate: expectedBy,
    businessDaysOverdue: Math.max(0, overdue),
    medianLagDays: medianLag,
  };
}

function expectedFormAfter(
  periodic: Array<{ form: string; reportDate: string | null }>,
): string {
  const lastAnnual = [...periodic].reverse().find((f) => f.form === "10-K");
  if (!lastAnnual?.reportDate) return "10-Q";
  const quartersSinceAnnual = periodic.filter(
    (f) => (f.reportDate as string) > (lastAnnual.reportDate as string),
  ).length;
  return quartersSinceAnnual >= 3 ? "10-K" : "10-Q";
}

function addQuarter(ymdStr: string): string {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + 3, d, 12));
  return date.toISOString().slice(0, 10);
}

function addCalendarDaysYmd(ymdStr: string, n: number): string {
  const date = new Date(`${ymdStr}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** Business days in (from, to] — trading-day calendar (holidays excluded). */
export function businessDaysBetween(fromYmd: string, toYmd: string): number {
  return tradingDaysBetween(fromYmd, toYmd);
}

// ---------------------------------------------------------------------------
// §5.5 Unexplained move
// ---------------------------------------------------------------------------

export type UnexplainedEvaluation = {
  conditionTrue: boolean;
  measureUsed: "residual_zscore" | "move_zscore";
  value: number | null;
};

/**
 * |residual_zscore| > 2.0 AND no news since the previous regular-session close
 * AND not inside the earnings window. Low-R² fallback (r² < 0.15): evaluate
 * |move_zscore| instead and mark which measure was used.
 *
 * "No news" is measured as "no active news_burst" (see burstActive); raw
 * article counts still travel in the payload as context.
 */
export function evaluateUnexplainedMove(
  input: {
    residualZ: number | null;
    moveZ: number | null;
    r2: number | null;
    /**
     * Whether the ticker's news_burst detector is currently active. Replaces
     * the original "zero news_item since the previous close" gate: in a
     * news-saturated universe (~6 articles/ticker/day) that gate never opened
     * — |resid_z| > 2 occurred 4.4×/day while unexplained_move fired 0 times
     * in 4 days. A move is now "unexplained" when it is not accompanied by a
     * burst of coverage, not when coverage is literally absent.
     */
    burstActive: boolean;
    inEarningsWindow: boolean;
  },
  config: TrackerConfig,
): UnexplainedEvaluation {
  const lowR2 = input.r2 != null && input.r2 < config.thresholds.lowR2Fallback;
  const measureUsed: "residual_zscore" | "move_zscore" = lowR2
    ? "move_zscore"
    : "residual_zscore";
  const value = measureUsed === "move_zscore" ? input.moveZ : input.residualZ;
  const conditionTrue =
    value != null &&
    Math.abs(value) > config.thresholds.unexplainedZ &&
    !input.burstActive &&
    !input.inEarningsWindow;
  return { conditionTrue, measureUsed, value };
}

// ---------------------------------------------------------------------------
// §5.6 Drift
// ---------------------------------------------------------------------------

/**
 * |momentum_5d| / (vol30 × √5) above threshold AND no news_burst fired in the
 * last 5 trading days. Like unexplained_move, "quiet" means no burst rather
 * than literally zero articles — the latter never happens for active names.
 */
export function evaluateDrift(
  driftZ: number | null,
  burstInWindow: boolean,
  config: TrackerConfig,
): boolean {
  return driftZ != null && driftZ > config.thresholds.driftZ && !burstInWindow;
}

// ---------------------------------------------------------------------------
// §5.7 News burst
// ---------------------------------------------------------------------------

export type NewsBurstEvaluation = {
  conditionTrue: boolean;
  articlesLast24h: number;
  baselineRate: number | null;
  burstMultiple: number | null;
};

export function evaluateNewsBurst(
  articlesLast24h: number,
  baselineRate: number | null,
  config: TrackerConfig,
): NewsBurstEvaluation {
  if (baselineRate == null || baselineRate <= 0) {
    return { conditionTrue: false, articlesLast24h, baselineRate, burstMultiple: null };
  }
  const multiple = articlesLast24h / baselineRate;
  const conditionTrue =
    articlesLast24h >= config.thresholds.newsBurstMinArticles &&
    multiple > config.thresholds.newsBurstMultiple;
  return { conditionTrue, articlesLast24h, baselineRate, burstMultiple: multiple };
}

/**
 * §5 news-burst re-arm hysteresis: after the condition goes false it must stay
 * false for one full trading day before the detector may fire again.
 */
export function newsBurstRearmed(state: EdgeDetectorState, todayYmd: string): boolean {
  if (state.active) return true; // still inside a reported burst — escalation path
  if (state.falseSinceDay == null) return true; // never fired
  return tradingDaysBetween(state.falseSinceDay, todayYmd) >= 1;
}

// ---------------------------------------------------------------------------
// §5.8 Insider cluster
// ---------------------------------------------------------------------------

export type InsiderTxnLike = {
  insiderName: string;
  transactionCode: string;
  is10b51Plan: boolean;
  /** Trade execution date "YYYY-MM-DD"; null when the XML carried none. */
  transactionDate?: string | null;
  filedAt: string;
  direction: "buy" | "sell" | null;
  /** Notional in USD; null when the Form 4 did not yield one (§3.11). */
  value: number | null;
};

/**
 * The day a transaction is windowed and grouped on. A Form 4 may be filed up
 * to two business days after the trade, so the execution date is the anchor;
 * the filing date only stands in when the XML yielded no date.
 */
export function insiderTxnDay(txn: InsiderTxnLike): string {
  return txn.transactionDate ?? txn.filedAt.slice(0, 10);
}

/** Why a transaction inside the window was not counted toward the cluster. */
export type InsiderClusterExclusionReason =
  /** Part of a same-day, same-direction bulk filing whose median value is de minimis. */
  | "bulk_plan_event"
  /** Notional below the per-transaction minimum. */
  | "below_min_notional"
  /** Notional not computable — never read as zero, and never counted (§3.11). */
  | "value_unknown";

export type InsiderClusterExclusion = {
  insiderName: string;
  filedAt: string;
  direction: "buy" | "sell";
  value: number | null;
  reason: InsiderClusterExclusionReason;
};

export type InsiderClusterEvaluation = {
  conditionTrue: boolean;
  direction: "buy" | "sell" | null;
  insiders: string[];
  transactions: InsiderTxnLike[];
  /** Auditable record of everything the noise filters dropped. */
  excluded: InsiderClusterExclusion[];
};

function directionOf(txn: InsiderTxnLike): "buy" | "sell" {
  return txn.transactionCode.toUpperCase() === "P" ? "buy" : "sell";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * ≥ 3 distinct insiders, same direction, within 10 business days, counting
 * only open-market codes P and S — excluding F, M, A and any 10b5-1 plan.
 *
 * Two further noise filters, both configuration:
 *
 *  - **Per-transaction minimum notional.** A de minimis purchase is not a
 *    conviction signal. A transaction whose value is below the floor does not
 *    count. A null value is "not computable", never zero — it cannot be shown
 *    to clear the floor, so it does not count either, and is reported so a
 *    parse gap is visible rather than silently shrinking a cluster.
 *
 *  - **Same-day bulk guard.** An employee or director share-plan settlement
 *    lands as one date carrying dozens of insiders in the same direction at
 *    trivial size. Past the insider-count threshold, a group whose median
 *    value is below the notional floor is classified as a plan event and
 *    dropped wholesale. Only that group is dropped, not the evaluation: a
 *    genuine cluster on surrounding dates must still be able to fire.
 */
export function evaluateInsiderCluster(
  txns: InsiderTxnLike[],
  todayYmd: string,
  config: TrackerConfig,
): InsiderClusterEvaluation {
  const windowStart = addTradingDays(todayYmd, -config.thresholds.insiderClusterWindowBusinessDays);
  const minNotional = config.thresholds.insiderClusterMinNotionalUsd;
  const bulkInsiderCount = config.thresholds.insiderClusterBulkInsiderCount;

  const eligible = txns.filter((t) => {
    if (t.is10b51Plan) return false;
    const code = t.transactionCode.toUpperCase();
    if (code !== "P" && code !== "S") return false;
    // Window on the execution day, not the filing day — a Monday trade filed
    // on Wednesday anchors the 10-business-day window to Monday.
    const day = insiderTxnDay(t);
    return day >= windowStart && day <= todayYmd;
  });

  const excluded: InsiderClusterExclusion[] = [];
  const exclude = (txn: InsiderTxnLike, reason: InsiderClusterExclusionReason): void => {
    excluded.push({
      insiderName: txn.insiderName,
      filedAt: txn.filedAt,
      direction: directionOf(txn),
      value: txn.value,
      reason,
    });
  };

  // Bulk guard first: the group qualifies as a plan event *because* its median
  // is de minimis, so it has to be judged before the per-transaction floor
  // removes the very transactions that establish that median.
  const groups = new Map<string, InsiderTxnLike[]>();
  for (const txn of eligible) {
    const key = `${directionOf(txn)}|${insiderTxnDay(txn)}`;
    const group = groups.get(key) ?? [];
    group.push(txn);
    groups.set(key, group);
  }
  const bulk = new Set<InsiderTxnLike>();
  for (const group of groups.values()) {
    const insiders = new Set(group.map((t) => t.insiderName));
    if (insiders.size <= bulkInsiderCount) continue;
    const groupMedian = median(group.map((t) => t.value).filter((v): v is number => v != null));
    if (groupMedian === null || groupMedian >= minNotional) continue;
    for (const txn of group) {
      bulk.add(txn);
      exclude(txn, "bulk_plan_event");
    }
  }

  const counted: InsiderTxnLike[] = [];
  for (const txn of eligible) {
    if (bulk.has(txn)) continue;
    if (txn.value == null) {
      exclude(txn, "value_unknown");
      continue;
    }
    if (txn.value < minNotional) {
      exclude(txn, "below_min_notional");
      continue;
    }
    counted.push(txn);
  }

  for (const direction of ["buy", "sell"] as const) {
    const code = direction === "buy" ? "P" : "S";
    const matching = counted.filter((t) => t.transactionCode.toUpperCase() === code);
    const insiders = [...new Set(matching.map((t) => t.insiderName))];
    if (insiders.length >= config.thresholds.insiderClusterMinInsiders) {
      return { conditionTrue: true, direction, insiders, transactions: matching, excluded };
    }
  }
  return { conditionTrue: false, direction: null, insiders: [], transactions: [], excluded };
}

/** §5.8 re-fire rule: only when a new insider joins the cluster. */
export function insiderClusterHasNewMember(
  state: InsiderClusterDetectorState,
  insiders: string[],
): boolean {
  const known = new Set(state.lastClusterInsiders);
  return insiders.some((name) => !known.has(name));
}
