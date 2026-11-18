/**
 * The scoreboard: Falcon's forecasts against the options market's, head to
 * head, on the same names, horizons and closes ("Falcon mı piyasa mı daha
 * isabetli?"). One matchup per Falcon forecast at its creation (a
 * ripple_forecasts row or a Sightings hit), or per earnings release.
 *
 * What each side forecasts
 *   - Falcon: a direction (up / down / unclear), a horizon in sessions, an
 *     evidence label (Measured / Documented / Watch) and, when it has one, an
 *     expected size: the record's mean |move - benchmark| after similar events
 *     (abnormal units), or for Documented hits the family's own estimate.
 *     Earnings matchups: the company's trailing mean |reaction| over its
 *     earlier releases (the /events "typical earnings move"), no direction.
 *   - The market: an expected absolute move, direction-neutral by construction.
 *       forecast matchups: the ATM implied volatility interpolated in total
 *         variance to the horizon's last session from the stored term
 *         structure, x sqrt(L / 252) x sqrt(2 / pi) (the expected |move| of a
 *         normal); "beyond the market" takes beta^2 VIX^2 out of the variance
 *         first (the units of Falcon's abnormal record).
 *       earnings matchups: the pre-earnings ATM straddle from options_daily
 *         metrics.earnings_straddle (15:45 New York snapshot of the session
 *         before the reaction day, first expiry covering the reaction):
 *         (call_mid + put_mid) / spot at the strike nearest spot. Raw units.
 *
 * What is scored (per matchup, then summarized with intervals)
 *   - Direction: hit when sign(realized abnormal move) = Falcon's sign, against
 *     a coin (the market's options price no direction) and against "always
 *     the majority sign" of the same sample.
 *   - Size: |realized| against Falcon's expected size and the market's implied
 *     move in the same units (absolute errors, paired difference, share of
 *     matchups where Falcon was closer), and realized / implied (above 1: the
 *     market under-priced the move on Falcon's events).
 *   - Calibration by evidence label and confidence.
 *   - P&L proxies, in units of the implied move (no costs, no spreads):
 *       directional: sign x realized / implied (a stock-vs-ETF position sized
 *         to the implied move);
 *       straddle: (|realized| - implied) / implied, taken long when Falcon's
 *         expected size is above the market's and short when below (who is
 *         right about size, as a trade).
 *   - Means get 95% intervals clustered by the base session (names measured
 *     over the same closes share market shocks); rates get Wilson intervals.
 *     Under MIN_SAMPLE the summary says the number is too small to read.
 *
 * Pure: no fs, no network, no clock.
 */

import { addDays, nyseSessions, sessionCloseMs } from "./abnormal.ts";
import { clusteredMeanVariance, mean, median, normalCdf, tTwoSidedP } from "./stats.ts";

export const SCOREBOARD_VERSION = "scoreboard-v1";

/** Below these counts a figure is shown with a "too few to read" warning. */
export const MIN_SAMPLE = { direction: 30, magnitude: 30, group: 20 } as const;

const SQRT_2_PI = Math.sqrt(2 / Math.PI);

/* ------------------------------------------------------------------ the market's side */

/** ATM IV of one expiry: calendar days from the snapshot session, IV a fraction. */
export type TermPoint = { expiration: string; days: number; iv: number };

/** The L-th NYSE session after `date` (the horizon's last session when it starts at the next open). */
export function horizonExit(date: string, L: number): string | null {
  if (!(Number.isInteger(L) && L >= 1)) return null;
  const s = nyseSessions(addDays(date, 1), addDays(date, Math.ceil(L * 1.6) + 12));
  return s[L - 1] ?? null;
}

/** Calendar days between two YYYY-MM-DD dates. */
export function calendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type InterpolatedIv = {
  iv: number;
  /** "interp": between two expiries; "front" / "back": flat beyond the first / last one. */
  method: "interp" | "front" | "back" | "exact";
  lo: TermPoint | null;
  hi: TermPoint | null;
};

/**
 * ATM IV at `days` calendar days, linear in total variance (iv^2 x days)
 * between the bracketing expiries; flat IV before the first and after the last.
 * Null without a usable point. Pure.
 */
export function interpolateIv(term: readonly TermPoint[], days: number): InterpolatedIv | null {
  const pts = term.filter((p) => Number.isFinite(p.iv) && p.iv > 0 && Number.isFinite(p.days) && p.days > 0).sort((a, b) => a.days - b.days);
  if (!pts.length || !(days > 0)) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (days <= first.days) return { iv: first.iv, method: days === first.days ? "exact" : "front", lo: null, hi: first };
  if (days >= last.days) return { iv: last.iv, method: days === last.days ? "exact" : "back", lo: last, hi: null };
  for (let i = 1; i < pts.length; i++) {
    const hi = pts[i]!;
    if (hi.days < days) continue;
    const lo = pts[i - 1]!;
    if (hi.days === days) return { iv: hi.iv, method: "exact", lo: hi, hi };
    const wLo = lo.iv * lo.iv * lo.days;
    const wHi = hi.iv * hi.iv * hi.days;
    const w = wLo + ((wHi - wLo) * (days - lo.days)) / (hi.days - lo.days);
    // Total variance must not fall with time (calendar arbitrage); a falling pair is read flat at the far IV.
    return { iv: w > 0 ? Math.sqrt(w / days) : hi.iv, method: "interp", lo, hi };
  }
  return { iv: last.iv, method: "back", lo: last, hi: null };
}

/** Expected |move| in percent over L sessions for an annualized IV (fraction): iv x sqrt(L/252) x sqrt(2/pi) x 100. */
export function expectedAbsMovePct(iv: number, L: number): number {
  return iv * Math.sqrt(L / 252) * SQRT_2_PI * 100;
}

export type MarketMove = {
  sessions: number;
  exitDate: string;
  targetDays: number;
  iv: number;
  method: InterpolatedIv["method"];
  /** Expected absolute move, percent. */
  rawPct: number;
  /** Beyond the market (beta^2 VIX^2 taken out of the variance), percent; null without beta / VIX or when nothing is left. */
  adjPct: number | null;
};

/** The market's expected |move| over L sessions after the snapshot session `date`, interpolated in the term structure. Pure. */
export function interpolatedImpliedMove(t: { date: string; term: readonly TermPoint[]; beta?: number | null; vix?: number | null }, L: number): MarketMove | null {
  const exit = horizonExit(t.date, L);
  if (!exit) return null;
  const targetDays = calendarDays(t.date, exit);
  const p = interpolateIv(t.term, targetDays);
  if (!p) return null;
  const beta = t.beta ?? null;
  const vix = t.vix ?? null;
  let adjPct: number | null = null;
  if (beta !== null && vix !== null && Number.isFinite(beta) && Number.isFinite(vix)) {
    const v = p.iv * p.iv - beta * beta * vix * vix;
    adjPct = v > 0 ? expectedAbsMovePct(Math.sqrt(v), L) : null;
  }
  return { sessions: L, exitDate: exit, targetDays, iv: p.iv, method: p.method, rawPct: expectedAbsMovePct(p.iv, L), adjPct };
}

/** options_daily.metrics.earnings_straddle (written by the daily job; fractions, as_of an ISO instant). */
export type EarningsStraddle = {
  implied_move: number;
  expiry: string;
  strike: number;
  call_mid: number;
  put_mid: number;
  spot: number;
  as_of: string;
  dte: number;
};

/**
 * The straddle's implied move in percent, checked: positive mids and spot,
 * the implied move equal to (call + put) / spot within 1% of itself, the
 * expiry on or after the reaction day. Null when it fails any check. Pure.
 */
export function straddleMovePct(s: EarningsStraddle | null | undefined, reactionDay: string): number | null {
  if (!s) return null;
  const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (!ok(s.implied_move) || !ok(s.spot) || !ok(s.call_mid) || !ok(s.put_mid)) return null;
  if (typeof s.expiry !== "string" || s.expiry < reactionDay) return null;
  const fromMids = (s.call_mid + s.put_mid) / s.spot;
  if (Math.abs(fromMids - s.implied_move) > 0.01 * s.implied_move + 1e-9) return null;
  return s.implied_move * 100;
}

/* ------------------------------------------------------------------ realized */

/** close(exit) / close(base) - 1 in percent; null when a close is missing or not positive. Pure. */
export function movePct(closes: ReadonlyMap<string, number>, base: string, exit: string): number | null {
  const a = closes.get(base);
  const b = closes.get(exit);
  if (!(typeof a === "number" && a > 0 && typeof b === "number" && b > 0)) return null;
  return (b / a - 1) * 100;
}

/** Stock move minus the benchmark's over the same closes (percent), as historical_events does. */
export function abnormalPct(stock: number | null, bench: number | null): number | null {
  return stock === null || bench === null ? null : stock - bench;
}

/* ------------------------------------------------------------------ matchups */

export type Tier = "measured" | "documented" | "watch";

/** One matchup: the forecast, the market's number at creation, and the outcome once matured. Percent units. */
export type Matchup = {
  kind: "forecast" | "earnings";
  /** Unique per matchup: "rf:<ripple_forecasts.id>", "card:<card id>:<ticker>", "earn:<ticker>:<event date>". */
  key: string;
  ticker: string;
  createdAt: string;
  /** Cluster of the event (several hits share one); defaults to key. */
  eventId?: string | null;
  horizonSessions: number;
  /** Session whose close the moves are measured from (the snapshot session); exit = horizonSessions sessions later. */
  baseDate: string;
  exitDate: string;
  falconSign: -1 | 0 | 1;
  /** Falcon's expected |move| in the comparison units (`units`), percent; null when Falcon gives no size. */
  falconAbsPct: number | null;
  /** Falcon's expected signed move (abnormal), when it has one. */
  falconSignedPct?: number | null;
  falconSource?: "record" | "documented" | "trailing_reactions" | null;
  tier?: Tier | null;
  confidence?: "low" | "medium" | "high" | null;
  family?: string | null;
  published?: boolean | null;
  /** "card_block": the Sightings card's own options block (5 or 20 sessions) when the store has no row for the name. */
  marketMethod: "term_interp" | "earnings_straddle" | "card_block";
  /** The market's expected |move|, raw, percent. */
  marketRawPct: number | null;
  /** The market's expected |move| beyond the market (forecasts) or the straddle again (earnings), percent. */
  marketAdjPct: number | null;
  optionsAsOf?: string | null;
  /** NYSE sessions between the options snapshot and baseDate (0 = same session). */
  optionsLagSessions?: number | null;
  /** Comparison units of the size scores: "abnormal" (forecasts) or "raw" (earnings straddles). */
  units: "abnormal" | "raw";
  realizedRawPct: number | null;
  realizedAbnPct: number | null;
  benchmark?: string | null;
};

export type MatchupScore = {
  matured: boolean;
  /** Null when Falcon gave no direction or the outcome is 0 / unknown. */
  dirHit: boolean | null;
  /** |realized| in the comparison units. */
  realizedAbs: number | null;
  /** The market's number in the comparison units. */
  marketPct: number | null;
  falconErr: number | null;
  marketErr: number | null;
  /** |realized raw| / market raw implied. */
  ratio: number | null;
  /** Directional P&L in implied-move units. */
  pnlDir: number | null;
  /** Long straddle return on premium (|realized raw| - implied) / implied. */
  straddle: number | null;
  /** The straddle taken on Falcon's side of size (+1 long when Falcon expects more than the market, -1 short). */
  pnlVol: number | null;
};

const fin = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** The scores of one matchup. Pure. */
export function scoreMatchup(m: Matchup): MatchupScore {
  const realizedDir = m.units === "abnormal" ? m.realizedAbnPct : (m.realizedAbnPct ?? m.realizedRawPct);
  const realizedSize = m.units === "abnormal" ? m.realizedAbnPct : m.realizedRawPct;
  const marketPct = m.units === "abnormal" ? m.marketAdjPct : m.marketRawPct;
  const matured = fin(m.realizedRawPct) || fin(m.realizedAbnPct);
  const realizedAbs = fin(realizedSize) ? Math.abs(realizedSize) : null;
  const dirHit = m.falconSign !== 0 && fin(realizedDir) && realizedDir !== 0 ? Math.sign(realizedDir) === m.falconSign : null;
  const falconErr = realizedAbs !== null && fin(m.falconAbsPct) ? Math.abs(realizedAbs - m.falconAbsPct) : null;
  const marketErr = realizedAbs !== null && fin(marketPct) ? Math.abs(realizedAbs - marketPct) : null;
  const ratio = fin(m.realizedRawPct) && fin(m.marketRawPct) && m.marketRawPct > 0 ? Math.abs(m.realizedRawPct) / m.marketRawPct : null;
  // Directional: the forecast's units (abnormal, sized to the move beyond the market), raw when that is missing.
  let pnlDir: number | null = null;
  if (m.falconSign !== 0) {
    if (fin(realizedDir) && fin(marketPct) && marketPct > 0) pnlDir = (m.falconSign * realizedDir) / marketPct;
    else if (fin(m.realizedRawPct) && fin(m.marketRawPct) && m.marketRawPct > 0) pnlDir = (m.falconSign * m.realizedRawPct) / m.marketRawPct;
  }
  const straddle = ratio === null ? null : ratio - 1;
  const side = fin(m.falconAbsPct) && fin(marketPct) && m.falconAbsPct !== marketPct ? Math.sign(m.falconAbsPct - marketPct) : 0;
  const pnlVol = straddle !== null && side !== 0 ? side * straddle : null;
  return { matured, dirHit, realizedAbs, marketPct, falconErr, marketErr, ratio, pnlDir, straddle, pnlVol };
}

/* ------------------------------------------------------------------ intervals */

/** Wilson score interval (95% by default) for k of n. */
export function wilson(k: number, n: number, z = 1.959964): { lo: number; hi: number } | null {
  if (!(n > 0)) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/** Two-sided binomial p for k of n against p0 (normal approximation with continuity correction; exact sums for n <= 200). */
export function binomialP(k: number, n: number, p0 = 0.5): number {
  if (!(n > 0)) return 1;
  if (n <= 200) {
    const lp = (i: number) => lnChoose(n, i) + i * Math.log(p0) + (n - i) * Math.log(1 - p0);
    const pk = lp(k);
    let s = 0;
    for (let i = 0; i <= n; i++) {
      const li = lp(i);
      if (li <= pk + 1e-7) s += Math.exp(li);
    }
    return Math.min(1, s);
  }
  const mu = n * p0;
  const sdv = Math.sqrt(n * p0 * (1 - p0));
  const z = (Math.abs(k - mu) - 0.5) / sdv;
  return Math.min(1, 2 * (1 - normalCdf(Math.max(0, z))));
}

function lnChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}

/** Student t 97.5% quantile for df degrees of freedom (bisection on tTwoSidedP). */
export function t975(df: number): number {
  if (!Number.isFinite(df) || df > 1000) return 1.959964;
  if (df < 1) return NaN;
  let lo = 1.9;
  let hi = 20;
  while (tTwoSidedP(hi, df) > 0.05) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSidedP(mid, df) > 0.05) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type MeanCi = { n: number; mean: number; lo: number | null; hi: number | null; clusters: number; median: number };

/** Mean with a 95% interval clustered by `keys` (t on clusters - 1 df); no interval under 2 clusters. Null when empty. */
export function meanCi(ys: readonly number[], keys: readonly string[]): MeanCi | null {
  if (!ys.length) return null;
  const m = mean(ys);
  const { variance, clusters } = clusteredMeanVariance(ys, keys);
  const se = Math.sqrt(variance);
  const q = t975(clusters - 1);
  const ok = Number.isFinite(se) && Number.isFinite(q) && clusters >= 2;
  return { n: ys.length, mean: m, lo: ok ? m - q * se : null, hi: ok ? m + q * se : null, clusters, median: median(ys) };
}

/* ------------------------------------------------------------------ summary */

export type RateSummary = { n: number; k: number; rate: number | null; ci: { lo: number; hi: number } | null; p: number };

export type GroupSummary = {
  label: string;
  n: number;
  direction: RateSummary;
  falconMae: number | null;
  marketMae: number | null;
  ratioMedian: number | null;
};

export type ScoreboardSummary = {
  version: typeof SCOREBOARD_VERSION;
  total: number;
  withMarket: number;
  matured: number;
  pending: number;
  /** Matured matchups with a direction from Falcon. */
  direction: RateSummary & {
    /** Share of the same matchups whose realized move had the sample's majority sign: the "always that sign" baseline. */
    majorityBaseline: number | null;
    majoritySign: -1 | 1 | null;
  };
  magnitude: {
    n: number;
    falconMae: number | null;
    marketMae: number | null;
    /** Mean of falconErr - marketErr (negative: Falcon closer), clustered 95% interval. */
    diff: MeanCi | null;
    /** Share of matchups where Falcon's size was closer. */
    falconCloser: RateSummary;
  };
  ratio: MeanCi | null;
  /** Share of matured matchups where |realized| exceeded the implied move. */
  exceeded: RateSummary;
  pnl: { directional: MeanCi | null; straddle: MeanCi | null; falconSideStraddle: MeanCi | null };
  byTier: GroupSummary[];
  byConfidence: GroupSummary[];
  byKind: GroupSummary[];
  /** Next maturity among pending matchups (exit date), if any. */
  nextMaturity: string | null;
  warnings: string[];
};

function rate(flags: readonly boolean[], p0 = 0.5): RateSummary {
  const n = flags.length;
  const k = flags.filter(Boolean).length;
  return { n, k, rate: n ? k / n : null, ci: wilson(k, n), p: binomialP(k, n, p0) };
}

const maeOf = (xs: readonly (number | null)[]) => {
  const v = xs.filter(fin);
  return v.length ? mean(v) : null;
};

function group(label: string, ms: readonly Matchup[], ss: readonly MatchupScore[]): GroupSummary {
  const both = ss.filter((s) => s.falconErr !== null && s.marketErr !== null);
  const ratios = ss.map((s) => s.ratio).filter(fin);
  return {
    label,
    n: ms.length,
    direction: rate(ss.map((s) => s.dirHit).filter((x): x is boolean => x !== null)),
    falconMae: maeOf(both.map((s) => s.falconErr)),
    marketMae: maeOf(both.map((s) => s.marketErr)),
    ratioMedian: ratios.length ? median(ratios) : null,
  };
}

function groupsBy(ms: readonly Matchup[], ss: readonly MatchupScore[], keyOf: (m: Matchup) => string): GroupSummary[] {
  const idx = new Map<string, number[]>();
  ms.forEach((m, i) => {
    const k = keyOf(m);
    idx.set(k, [...(idx.get(k) ?? []), i]);
  });
  return [...idx.entries()]
    .map(([k, is]) => group(k, is.map((i) => ms[i]!), is.map((i) => ss[i]!)))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

/** The scoreboard over a set of matchups (matured or not). Pure. */
export function summarize(all: readonly Matchup[]): ScoreboardSummary {
  const withMarket = all.filter((m) => fin(m.marketRawPct) || fin(m.marketAdjPct));
  const scores = withMarket.map(scoreMatchup);
  const matIdx = scores.map((s, i) => (s.matured ? i : -1)).filter((i) => i >= 0);
  const ms = matIdx.map((i) => withMarket[i]!);
  const ss = matIdx.map((i) => scores[i]!);
  const keys = ms.map((m) => m.baseDate);
  const pending = withMarket.filter((_, i) => !scores[i]!.matured);

  const dirIdx = ss.map((s, i) => (s.dirHit === null ? -1 : i)).filter((i) => i >= 0);
  const dir = rate(dirIdx.map((i) => ss[i]!.dirHit!));
  const signs = dirIdx.map((i) => {
    const m = ms[i]!;
    const r = m.units === "abnormal" ? m.realizedAbnPct : (m.realizedAbnPct ?? m.realizedRawPct);
    return Math.sign(r ?? 0);
  });
  const ups = signs.filter((s) => s > 0).length;
  const majoritySign = signs.length ? (ups * 2 >= signs.length ? 1 : -1) : null;
  const majorityBaseline = signs.length ? signs.filter((s) => s === majoritySign).length / signs.length : null;

  const magIdx = ss.map((s, i) => (s.falconErr !== null && s.marketErr !== null ? i : -1)).filter((i) => i >= 0);
  const diffs = magIdx.map((i) => ss[i]!.falconErr! - ss[i]!.marketErr!);
  const pick = <T>(is: number[], f: (s: MatchupScore) => T) => is.map((i) => f(ss[i]!));
  const series = (f: (s: MatchupScore) => number | null) => {
    const is = ss.map((s, i) => (fin(f(s)) ? i : -1)).filter((i) => i >= 0);
    return meanCi(is.map((i) => f(ss[i]!)!), is.map((i) => keys[i]!));
  };
  const ratioIdx = ss.map((s, i) => (s.ratio !== null ? i : -1)).filter((i) => i >= 0);

  const warnings: string[] = [];
  if (!ms.length) warnings.push(pending.length ? `No matchup has matured yet: ${pending.length} waiting, the first on ${nextExit(pending)}.` : "No matchups yet.");
  if (dir.n > 0 && dir.n < MIN_SAMPLE.direction) warnings.push(`Direction rests on ${dir.n} matchups (fewer than ${MIN_SAMPLE.direction}): too few to read.`);
  if (magIdx.length > 0 && magIdx.length < MIN_SAMPLE.magnitude) warnings.push(`Size comparison rests on ${magIdx.length} matchups (fewer than ${MIN_SAMPLE.magnitude}): too few to read.`);
  const clusters = new Set(keys).size;
  if (ms.length >= 2 && clusters < 5) warnings.push(`All matured matchups come from ${clusters} base session${clusters === 1 ? "" : "s"}: one market week can drive every number.`);
  const stale = withMarket.filter((m) => (m.optionsLagSessions ?? 0) > 1).length;
  if (stale) warnings.push(`${stale} matchups use an options snapshot more than one session older than the forecast.`);

  return {
    version: SCOREBOARD_VERSION,
    total: all.length,
    withMarket: withMarket.length,
    matured: ms.length,
    pending: pending.length,
    direction: { ...dir, majorityBaseline, majoritySign: majoritySign as -1 | 1 | null },
    magnitude: {
      n: magIdx.length,
      falconMae: maeOf(pick(magIdx, (s) => s.falconErr)),
      marketMae: maeOf(pick(magIdx, (s) => s.marketErr)),
      diff: meanCi(diffs, magIdx.map((i) => keys[i]!)),
      falconCloser: rate(diffs.map((d) => d < 0)),
    },
    ratio: meanCi(pick(ratioIdx, (s) => s.ratio!), ratioIdx.map((i) => keys[i]!)),
    exceeded: rate(pick(ratioIdx, (s) => s.ratio! > 1)),
    pnl: { directional: series((s) => s.pnlDir), straddle: series((s) => s.straddle), falconSideStraddle: series((s) => s.pnlVol) },
    byTier: groupsBy(ms, ss, (m) => m.tier ?? "none"),
    byConfidence: groupsBy(ms, ss, (m) => m.confidence ?? "none"),
    byKind: groupsBy(ms, ss, (m) => m.kind),
    nextMaturity: pending.length ? nextExit(pending) : null,
    warnings,
  };
}

function nextExit(ms: readonly Matchup[]): string {
  return ms.map((m) => m.exitDate).sort()[0]!;
}

/* ------------------------------------------------------------------ builders */

/** Falcon's expected |move| (abnormal, percent) from a hit's record events: mean |move - benchmark|; null under `min` events. */
export function recordAbsPct(events: ReadonlyArray<{ movePct: number; benchmarkPct: number }> | null | undefined, min = 6): number | null {
  const d = (events ?? []).map((e) => e.movePct - e.benchmarkPct).filter(Number.isFinite);
  return d.length >= min ? mean(d.map(Math.abs)) : null;
}

/**
 * Falcon's earnings forecast for a release: the mean |reaction| over the
 * company's `max` most recent earlier releases (at least `min`), in the units
 * given (pass raw reactions to compare with the straddle). Only releases
 * strictly before `eventDate` count. Pure.
 */
export function trailingReactionAbsPct(past: ReadonlyArray<{ date: string; pct: number | null }>, eventDate: string, min = 4, max = 8): { pct: number; n: number } | null {
  const prior = past
    .filter((e) => e.date < eventDate && fin(e.pct))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, max);
  return prior.length >= min ? { pct: mean(prior.map((e) => Math.abs(e.pct!))), n: prior.length } : null;
}

/** NYSE sessions strictly after `from` up to and including `to` (0 when equal). */
export function sessionsBetween(from: string, to: string): number {
  if (to <= from) return 0;
  return nyseSessions(addDays(from, 1), to).length;
}

/* ------------------------------------------------------------------ building matchups from stored rows */

/** The NYSE session whose close is the last one completed at `ms` (a session's close counts from 16:00 / 13:00 New York). */
export function lastClosedSession(ms: number): string {
  let d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  for (let i = 0; i < 15; i++) {
    if (nyseSessions(d, d).length && sessionCloseMs(d) <= ms) return d;
    d = addDays(d, -1);
  }
  return d;
}

/** A ripple_forecasts row as read. */
export type ForecastRowIn = {
  id: number | string;
  created_at: string;
  event_id: string;
  card_id: string;
  ticker: string;
  tier: string;
  family: string | null;
  sign_pred: number;
  window_days: number;
  published: boolean;
  model_version?: string | null;
  covariates?: Record<string, unknown> | null;
};

/** What the forecast's Sightings hit adds (when its card is still stored). */
export type HitInfo = {
  history?: { avgMovePct?: number; windowDays?: number; sample?: number; events?: Array<{ movePct: number; benchmarkPct: number }> } | null;
  documentedBy?: { ownEstimate?: { meanAbnPct: number; windowDays: number; n: number } } | null;
  options?: {
    asOf?: string;
    impliedMove5?: { rawPct: number; marketAdjustedPct: number | null } | null;
    impliedMove20?: { rawPct: number; marketAdjustedPct: number | null } | null;
    atmIv?: number;
    spot?: number;
    skew?: number | null;
    matched?: { windowDays: number; historyPct: number; sample: number } | null;
  } | null;
};

/** One options_daily row's raw metrics (store.ts StoredRaw), with its session. */
export type StoredOptionsIn = {
  session: string;
  asOf: string;
  spot: number;
  iv: number;
  skew: number | null;
  beta: number | null;
  vix: number | null;
  term: Array<[string, number, number]>;
};

/** The realized side, when known: raw and benchmark moves over base -> exit, percent. */
export type OutcomeIn = { rawPct: number | null; benchPct: number | null; benchmark: string | null } | null;

const TIERS = new Set(["measured", "documented", "watch"]);
const CONF = new Set(["low", "medium", "high"]);

/**
 * A forecast's matchup. The market's number: the stored snapshot of the base
 * session or the latest before it (term structure shifted to the base date),
 * else the card's own block for a 5- or 20-session horizon, else none.
 * Falcon's size: the record's mean |abnormal| when the horizon matches the
 * record's window (or the card's matched history), else none. Pure.
 */
export function buildForecastMatchup(f: ForecastRowIn, hit: HitInfo | null, opt: StoredOptionsIn | null, outcome: OutcomeIn = null): Matchup {
  const L = Math.max(1, Math.min(63, Math.round(Number(f.window_days) || 20)));
  const base = lastClosedSession(Date.parse(f.created_at));
  const exit = horizonExit(base, L) ?? base;
  const cov = f.covariates ?? {};
  const confidence = typeof cov.confidence === "string" && CONF.has(cov.confidence) ? (cov.confidence as Matchup["confidence"]) : null;

  let falconAbsPct: number | null = null;
  let falconSignedPct: number | null = null;
  let falconSource: Matchup["falconSource"] = null;
  const h = hit?.history;
  if (h && h.windowDays === L) {
    falconAbsPct = recordAbsPct(h.events);
    falconSignedPct = fin(h.avgMovePct) ? h.avgMovePct : null;
    if (falconAbsPct !== null || falconSignedPct !== null) falconSource = "record";
  }
  if (falconAbsPct === null && hit?.options?.matched && hit.options.matched.windowDays === L && fin(hit.options.matched.historyPct)) {
    falconAbsPct = hit.options.matched.historyPct;
    falconSource = "record";
  }
  const own = hit?.documentedBy?.ownEstimate;
  if (falconSignedPct === null && own && own.windowDays === L && fin(own.meanAbnPct)) {
    falconSignedPct = own.meanAbnPct;
    falconSource = falconSource ?? "documented";
  }

  let marketMethod: Matchup["marketMethod"] = "term_interp";
  let marketRawPct: number | null = null;
  let marketAdjPct: number | null = null;
  let optionsAsOf: string | null = null;
  let lag: number | null = null;
  if (opt && opt.session <= base) {
    const shift = calendarDays(opt.session, base);
    const term = opt.term.map(([expiration, days, iv]) => ({ expiration, days: days - shift, iv })).filter((p) => p.days > 0);
    const mv = interpolatedImpliedMove({ date: base, term, beta: opt.beta, vix: opt.vix }, L);
    if (mv) {
      marketRawPct = mv.rawPct;
      marketAdjPct = mv.adjPct;
      optionsAsOf = opt.asOf;
      lag = sessionsBetween(opt.session, base);
    }
  }
  if (marketRawPct === null && hit?.options && (L === 5 || L === 20)) {
    const b = L === 5 ? hit.options.impliedMove5 : hit.options.impliedMove20;
    if (b && fin(b.rawPct)) {
      marketMethod = "card_block";
      marketRawPct = b.rawPct;
      marketAdjPct = fin(b.marketAdjustedPct) ? b.marketAdjustedPct : null;
      optionsAsOf = hit.options.asOf ?? null;
      lag = optionsAsOf ? sessionsBetween(lastClosedSession(Date.parse(optionsAsOf) + 30 * 60_000), base) : null;
    }
  }

  const rawPct = outcome?.rawPct ?? null;
  const benchPct = outcome?.benchPct ?? null;
  return {
    kind: "forecast",
    key: `rf:${f.id}`,
    ticker: f.ticker,
    createdAt: f.created_at,
    eventId: f.event_id,
    horizonSessions: L,
    baseDate: base,
    exitDate: exit,
    falconSign: (f.sign_pred > 0 ? 1 : f.sign_pred < 0 ? -1 : 0) as -1 | 0 | 1,
    falconAbsPct,
    falconSignedPct,
    falconSource,
    tier: TIERS.has(f.tier) ? (f.tier as Tier) : null,
    confidence,
    family: f.family,
    published: f.published,
    marketMethod,
    marketRawPct,
    marketAdjPct,
    optionsAsOf,
    optionsLagSessions: lag,
    units: "abnormal",
    realizedRawPct: rawPct,
    realizedAbnPct: abnormalPct(rawPct, benchPct),
    benchmark: outcome?.benchmark ?? null,
  };
}

/**
 * An earnings release's matchup: the straddle of the session before the
 * reaction day against Falcon's trailing mean |reaction| over `pastRaw` (in
 * the units given: raw by default; "abnormal" scores the size on the move
 * beyond the sector ETF, `pastRaw` then holding earlier abnormal reactions).
 * The straddle is both market columns either way. Null without a straddle. Pure.
 */
export function buildEarningsMatchup(
  e: { ticker: string; eventDate: string; createdAt?: string; realizedRawPct: number | null; realizedAbnPct: number | null; benchmark?: string | null; window: "d0" | "d0_d1"; units?: "raw" | "abnormal" },
  straddle: EarningsStraddle | null,
  pastRaw: ReadonlyArray<{ date: string; pct: number | null }>,
): Matchup | null {
  const mv = straddleMovePct(straddle, e.eventDate);
  if (mv === null) return null;
  let base = addDays(e.eventDate, -1);
  while (!nyseSessions(base, base).length) base = addDays(base, -1);
  const falcon = trailingReactionAbsPct(pastRaw, e.eventDate);
  return {
    kind: "earnings",
    key: `earn:${e.ticker}:${e.eventDate}`,
    ticker: e.ticker,
    createdAt: e.createdAt ?? straddle!.as_of,
    eventId: `earn:${e.ticker}:${e.eventDate}`,
    horizonSessions: e.window === "d0" ? 1 : 2,
    baseDate: base,
    exitDate: e.window === "d0" ? e.eventDate : (horizonExit(base, 2) ?? e.eventDate),
    falconSign: 0,
    falconAbsPct: falcon?.pct ?? null,
    falconSource: falcon ? "trailing_reactions" : null,
    marketMethod: "earnings_straddle",
    marketRawPct: mv,
    marketAdjPct: mv,
    optionsAsOf: straddle!.as_of,
    optionsLagSessions: 0,
    units: e.units ?? "raw",
    realizedRawPct: e.realizedRawPct,
    realizedAbnPct: e.realizedAbnPct,
    benchmark: e.benchmark ?? null,
  };
}

/**
 * One forecast per (event, ticker, horizon): the ledger adds a row when a later
 * run sees the same hit with another tier, sign or publish state. The first
 * row is Falcon's forecast (made before the later runs saw more prices); it is
 * marked published when any of its rows was. Order kept. Pure.
 */
export function firstForecasts<T extends ForecastRowIn>(rows: readonly T[]): T[] {
  const seen = new Map<string, T>();
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || Number(a.id) - Number(b.id));
  for (const r of sorted) {
    const k = `${r.event_id}|${r.ticker}|${r.window_days}`;
    const first = seen.get(k);
    if (!first) seen.set(k, { ...r });
    else if (r.published && !first.published) first.published = true;
  }
  return [...seen.values()];
}
