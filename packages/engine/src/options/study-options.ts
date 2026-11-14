/**
 * Options hypotheses 4-7 (vault note `Falcon/Engine/Options Signals.md`):
 * the pure parts of the study run by scripts/options-study.ts. Design and
 * pass bars: data/preregistration/options-v1.json; method and results:
 * docs/options-study.md.
 *
 *   - OSI symbols to option definitions (the cbbo-1m records carry the OSI
 *     symbol, so the snapshot needs no `definition` pull).
 *   - Yahoo daily bars aligned to the NYSE calendar (split and dividend
 *     adjusted opens and closes for abnormal returns; unadjusted close and
 *     share volume for price gates and O/S).
 *   - Panel features: the level and the change versus the name's own
 *     trailing mean, tercile sorts per date, long-short spreads per date
 *     (Fama-MacBeth), pooled signed observations for the two-way test,
 *     per-name time-series correlations.
 *   - Implied move versus ripple history (H7).
 *   - Summaries: n, dates, mean, median, t, p, hit rate, by year,
 *     first 2/3 vs last 1/3 of dates, Benjamini-Hochberg.
 *
 * Pure: no fs, no network, no clock.
 */

import type { OptionDefinition } from "./client.ts";
import { clusteredMeanTest, mean, median, sd, tOneSidedP, tTwoSidedP, twoWayMeanTest } from "../study/stats.ts";
import type { PriceSeries } from "../study/abnormal.ts";

// ---------------------------------------------------------------------------
// OSI symbols

export type OsiParts = { root: string; expiration: string; right: "C" | "P"; strike: number };

/**
 * An OCC option symbol, root padded to 6 ("KLAC  261120C00150000"), or the
 * compact form without padding. Null when it does not parse.
 */
export function parseOsi(symbol: string): OsiParts | null {
  const m = /^([A-Z0-9.]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol.trim());
  if (!m) return null;
  const yy = Number(m[2]);
  const mm = Number(m[3]);
  const dd = Number(m[4]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const strike = Number(m[6]) / 1000;
  if (!(strike > 0)) return null;
  return { root: m[1]!, expiration: `${2000 + yy}-${m[3]}-${m[4]}`, right: m[5] as "C" | "P", strike };
}

/**
 * Definitions from the snapshot records themselves: one per instrument id
 * whose OSI root is the ticker (adjusted contracts, e.g. "KLAC1", are left
 * out: their deliverable is not 100 shares). Multiplier 100.
 */
export function definitionsFromRecords(records: ReadonlyArray<Record<string, unknown>>, ticker: string): OptionDefinition[] {
  const out = new Map<number, OptionDefinition>();
  const root = osiRoot(ticker);
  for (const r of records) {
    const sym = String(r.symbol ?? "");
    const hd = (r.hd as Record<string, unknown> | undefined) ?? r;
    const id = Number(hd.instrument_id);
    if (!Number.isFinite(id) || out.has(id)) continue;
    const p = parseOsi(sym);
    if (!p || p.root !== root) continue;
    out.set(id, {
      instrumentId: id,
      rawSymbol: sym,
      underlying: ticker,
      right: p.right,
      strike: p.strike,
      expirationMs: Date.parse(`${p.expiration}T00:00:00Z`),
      expiration: p.expiration,
      multiplier: 100,
    });
  }
  return [...out.values()];
}

/** OSI root of a ticker (class shares use no dot in OSI roots, e.g. BRK.B -> BRKB). */
export function osiRoot(ticker: string): string {
  return ticker.replace(/[.-]/g, "");
}

/** Records grouped by OSI root (one multi-parent request split per name). */
export function recordsByRoot(records: ReadonlyArray<Record<string, unknown>>): Map<string, Array<Record<string, unknown>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const r of records) {
    const p = parseOsi(String(r.symbol ?? ""));
    if (!p) continue;
    const l = out.get(p.root);
    if (l) l.push(r);
    else out.set(p.root, [r]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Yahoo bars aligned to sessions

export type YahooBars = {
  d: string[];
  /** Opens and closes as printed (split adjusted by Yahoo, not dividend adjusted). */
  o: number[];
  c: number[];
  /** Adjusted close (splits and dividends). */
  a: number[];
  /** Share volume (split adjusted by Yahoo). */
  v: number[];
  splits: Array<{ date: string; ratio: number }>;
};

export type AlignedSeries = PriceSeries & {
  /** Unadjusted close (as traded that day). */
  rawClose: Float64Array;
  /** Unadjusted share volume. */
  rawVolume: Float64Array;
  /** Dollar volume (unadjusted close x unadjusted shares). */
  dollarVolume: Float64Array;
  first: number;
  last: number;
};

/**
 * Bars on the session grid. Opens get the close's adjustment factor
 * (adjusted close / close), so open-to-close and close-to-close returns are
 * total returns. Yahoo's split-adjusted price and volume are turned back into
 * the day's own figures with the splits after that day. Pure.
 */
export function alignBars(y: YahooBars, sessions: readonly string[]): AlignedSeries {
  const n = sessions.length;
  const index = new Map(sessions.map((d, i) => [d, i]));
  const open = new Float64Array(n).fill(NaN);
  const close = new Float64Array(n).fill(NaN);
  const rawClose = new Float64Array(n).fill(NaN);
  const rawVolume = new Float64Array(n).fill(NaN);
  const dollarVolume = new Float64Array(n).fill(NaN);
  const splits = [...y.splits].sort((a, b) => (a.date < b.date ? -1 : 1));
  let first = -1;
  let last = -1;
  for (let k = 0; k < y.d.length; k++) {
    const i = index.get(y.d[k]!);
    if (i === undefined) continue;
    const c = y.c[k]!;
    const a = y.a[k]!;
    if (!(c > 0) || !(a > 0) || !(y.o[k]! > 0)) continue;
    const f = a / c;
    open[i] = y.o[k]! * f;
    close[i] = a;
    let ratio = 1;
    for (const s of splits) if (s.date > y.d[k]!) ratio *= s.ratio;
    rawClose[i] = c * ratio;
    rawVolume[i] = (y.v[k] ?? 0) / ratio;
    dollarVolume[i] = rawClose[i]! * rawVolume[i]!;
    if (first < 0) first = i;
    last = i;
  }
  return { open, close, rawClose, rawVolume, dollarVolume, first, last };
}

/** Median of the finite values in [i - n, i - 1] (null with fewer than n / 2). Pure. */
export function trailingMedian(xs: ArrayLike<number>, i: number, n: number): number | null {
  const vals: number[] = [];
  for (let k = Math.max(0, i - n); k < i; k++) if (Number.isFinite(xs[k]!)) vals.push(xs[k]!);
  return vals.length >= n / 2 ? median(vals) : null;
}

// ---------------------------------------------------------------------------
// Snapshot dates

/** The last NYSE session of each month in [from, to] (sessions sorted). Pure. */
export function monthEndSessions(sessions: readonly string[], fromMonth: string, toMonth: string): string[] {
  const last = new Map<string, string>();
  for (const d of sessions) {
    const m = d.slice(0, 7);
    if (m < fromMonth || m > toMonth) continue;
    last.set(m, d);
  }
  return [...last.values()].sort();
}

// ---------------------------------------------------------------------------
// Panel: features, changes, sorts

export type PanelRow = {
  date: string;
  ticker: string;
  /** Feature values by name (null when not computable). */
  x: Record<string, number | null>;
  /** Outcomes by name, e.g. car5, car20 (percent), null when unmeasured. */
  y: Record<string, number | null>;
};

/**
 * Change versus the name's own trailing mean: x_t - mean(x over the name's
 * previous `window` snapshots), needing at least `minPrior` of them. Rows
 * are matched by ticker and ordered by date; a row with a null level gets
 * null. With `log`, the change is ln(x_t / mean) (positive values only).
 * Returns a map keyed `${date}|${ticker}`. Pure.
 */
export function trailingChange(rows: readonly PanelRow[], feature: string, window = 6, minPrior = 3, log = false): Map<string, number | null> {
  const byName = new Map<string, PanelRow[]>();
  for (const r of rows) {
    const l = byName.get(r.ticker);
    if (l) l.push(r);
    else byName.set(r.ticker, [r]);
  }
  const out = new Map<string, number | null>();
  for (const [t, list] of byName) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 0; i < list.length; i++) {
      const cur = list[i]!.x[feature];
      const prior: number[] = [];
      for (let k = Math.max(0, i - window); k < i; k++) {
        const v = list[k]!.x[feature];
        if (v !== null && v !== undefined && Number.isFinite(v)) prior.push(v);
      }
      let v: number | null = null;
      if (cur !== null && cur !== undefined && Number.isFinite(cur) && prior.length >= minPrior) {
        const m = mean(prior);
        if (log) v = cur > 0 && m > 0 ? Math.log(cur / m) : null;
        else v = cur - m;
      }
      out.set(`${list[i]!.date}|${t}`, v);
    }
  }
  return out;
}

/**
 * Terciles of one date's values: 1 = lowest third, 3 = highest. Ranks by
 * value (ties broken by ticker, so the sort is deterministic); tercile =
 * floor(3 rank / n) + 1. Pure.
 */
export function terciles(items: ReadonlyArray<{ ticker: string; value: number }>): Map<string, 1 | 2 | 3> {
  const s = [...items].filter((i) => Number.isFinite(i.value)).sort((a, b) => a.value - b.value || (a.ticker < b.ticker ? -1 : 1));
  const out = new Map<string, 1 | 2 | 3>();
  const n = s.length;
  s.forEach((it, rank) => out.set(it.ticker, (Math.floor((3 * rank) / n) + 1) as 1 | 2 | 3));
  return out;
}

export type SortSpec = {
  /** Feature values per row key `${date}|${ticker}`. */
  feature: (row: PanelRow) => number | null;
  /** Outcome per row (percent). */
  outcome: (row: PanelRow) => number | null;
  /** +1: the high tercile is predicted to do better (long high, short low); -1: the low tercile (long low, short high). */
  sign: 1 | -1;
  /** Dates with fewer names than this (feature and outcome both known) are skipped (default 9). */
  minNames?: number;
};

export type DateSpread = {
  date: string;
  names: number;
  longN: number;
  shortN: number;
  longMean: number;
  shortMean: number;
  /** longMean - shortMean, percent. */
  spread: number;
};

export type SignedObs = { date: string; firm: string; value: number; tercile: 1 | 2 | 3 };

/**
 * Tercile sort per date and the long-short spread of the outcome. Also the
 * pooled signed observations (side x outcome, legs only) for the two-way
 * clustered test, and every name's tercile. Pure.
 */
export function sortSpreads(rows: readonly PanelRow[], spec: SortSpec): { dates: DateSpread[]; signed: SignedObs[] } {
  const minNames = spec.minNames ?? 9;
  const byDate = new Map<string, Array<{ row: PanelRow; x: number; y: number }>>();
  for (const row of rows) {
    const x = spec.feature(row);
    const y = spec.outcome(row);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const l = byDate.get(row.date);
    const it = { row, x, y };
    if (l) l.push(it);
    else byDate.set(row.date, [it]);
  }
  const dates: DateSpread[] = [];
  const signed: SignedObs[] = [];
  for (const [date, list] of [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < minNames) continue;
    const t = terciles(list.map((i) => ({ ticker: i.row.ticker, value: i.x })));
    const longT = spec.sign === 1 ? 3 : 1;
    const shortT = spec.sign === 1 ? 1 : 3;
    const longY: number[] = [];
    const shortY: number[] = [];
    for (const i of list) {
      const k = t.get(i.row.ticker)!;
      if (k === longT) {
        longY.push(i.y);
        signed.push({ date, firm: i.row.ticker, value: i.y, tercile: k });
      } else if (k === shortT) {
        shortY.push(i.y);
        signed.push({ date, firm: i.row.ticker, value: -i.y, tercile: k });
      }
    }
    if (!longY.length || !shortY.length) continue;
    const lm = mean(longY);
    const sm = mean(shortY);
    dates.push({ date, names: list.length, longN: longY.length, shortN: shortY.length, longMean: lm, shortMean: sm, spread: lm - sm });
  }
  return { dates, signed };
}

// ---------------------------------------------------------------------------
// Summaries

export type SeriesTest = {
  n: number;
  mean: number;
  median: number;
  sd: number;
  t: number;
  df: number;
  /** One-sided p for mean > 0. */
  pOne: number;
  pTwo: number;
  /** Share of values above zero. */
  hit: number;
};

/** t-test of a mean over independent values (here: one value per date, i.e. clustered by date). Null with fewer than 3. Pure. */
export function seriesTest(xs: readonly number[]): SeriesTest | null {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 3) return null;
  const m = mean(v);
  const s = sd(v);
  const se = s / Math.sqrt(v.length);
  const t = se > 0 ? m / se : m > 0 ? Infinity : m < 0 ? -Infinity : 0;
  const df = v.length - 1;
  return { n: v.length, mean: m, median: median(v), sd: s, t, df, pOne: tOneSidedP(t, df), pTwo: tTwoSidedP(t, df), hit: v.filter((x) => x > 0).length / v.length };
}

export type SpreadSummary = {
  dates: number;
  /** Names-dates in the legs. */
  legObs: number;
  /** All name-dates sorted. */
  sortedObs: number;
  /** Mean per-date long-short spread (percent per period) and its test over dates (Fama-MacBeth). */
  fm: SeriesTest | null;
  /** Net of costs: spread - costPct per period. */
  netMean: number | null;
  costPct: number;
  /** Mean of the long leg and of the short leg (percent). */
  longMean: number | null;
  shortMean: number | null;
  /** Pooled side x outcome over leg observations: clustered by date and two-way (firm x month). */
  pooled: { n: number; mean: number; tDate: number; pDateOne: number; tTwoWay: number; pTwoWayOne: number; firms: number; months: number } | null;
  byYear: Array<{ year: string; dates: number; mean: number; t: number | null }>;
  /** First 2/3 and last 1/3 of dates. */
  split: { early: SeriesTest | null; late: SeriesTest | null; cut: string | null };
  /** The last `recentDates` dates. */
  recent: { from: string | null; dates: number; mean: number | null };
};

/** Summary of a sort (see SpreadSummary). `costPct` is the round-trip cost of both legs per period (default 0.40 = 10 bp a side). Pure. */
export function summarizeSort(res: { dates: DateSpread[]; signed: SignedObs[] }, opts: { costPct?: number; recentDates?: number } = {}): SpreadSummary {
  const costPct = opts.costPct ?? 0.4;
  const spreads = res.dates.map((d) => d.spread);
  const fm = seriesTest(spreads);
  let pooled: SpreadSummary["pooled"] = null;
  if (res.signed.length >= 3) {
    const ys = res.signed.map((s) => s.value);
    const byDate = clusteredMeanTest(ys, res.signed.map((s) => s.date));
    const tw = twoWayMeanTest(ys, res.signed.map((s) => s.firm), res.signed.map((s) => s.date.slice(0, 7)));
    pooled = {
      n: ys.length,
      mean: byDate.mean,
      tDate: byDate.t,
      pDateOne: tOneSidedP(byDate.t, byDate.df),
      tTwoWay: tw.t,
      pTwoWayOne: tOneSidedP(tw.t, tw.df),
      firms: tw.clustersA,
      months: tw.clustersB,
    };
  }
  const years = new Map<string, number[]>();
  for (const d of res.dates) {
    const y = d.date.slice(0, 4);
    const l = years.get(y);
    if (l) l.push(d.spread);
    else years.set(y, [d.spread]);
  }
  const byYear = [...years].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([year, xs]) => ({ year, dates: xs.length, mean: mean(xs), t: seriesTest(xs)?.t ?? null }));
  const cutIdx = Math.ceil((res.dates.length * 2) / 3);
  const split = {
    early: seriesTest(spreads.slice(0, cutIdx)),
    late: seriesTest(spreads.slice(cutIdx)),
    cut: res.dates[cutIdx]?.date ?? null,
  };
  const k = opts.recentDates ?? 12;
  const rec = res.dates.slice(-k);
  return {
    dates: res.dates.length,
    legObs: res.signed.length,
    sortedObs: res.dates.reduce((s, d) => s + d.names, 0),
    fm,
    netMean: fm ? fm.mean - costPct : null,
    costPct,
    longMean: res.dates.length ? mean(res.dates.map((d) => d.longMean)) : null,
    shortMean: res.dates.length ? mean(res.dates.map((d) => d.shortMean)) : null,
    pooled,
    byYear,
    split,
    recent: { from: rec[0]?.date ?? null, dates: rec.length, mean: rec.length ? mean(rec.map((d) => d.spread)) : null },
  };
}

/**
 * Per-name time-series check: for each name with at least `minObs` rows,
 * the Spearman correlation between the feature and the outcome, signed so
 * that positive = the predicted direction. Returns each name's value and a
 * t-test of their mean across names. Pure.
 */
export function perNameCorrelations(
  rows: readonly PanelRow[],
  feature: (r: PanelRow) => number | null,
  outcome: (r: PanelRow) => number | null,
  sign: 1 | -1,
  minObs = 24,
): { names: Array<{ ticker: string; n: number; rho: number }>; test: SeriesTest | null; positiveShare: number | null } {
  const by = new Map<string, Array<[number, number]>>();
  for (const r of rows) {
    const x = feature(r);
    const y = outcome(r);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const l = by.get(r.ticker);
    if (l) l.push([x, y]);
    else by.set(r.ticker, [[x, y]]);
  }
  const names: Array<{ ticker: string; n: number; rho: number }> = [];
  for (const [ticker, pairs] of [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (pairs.length < minObs) continue;
    const rho = spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    if (rho !== null) names.push({ ticker, n: pairs.length, rho: sign * rho });
  }
  const rhos = names.map((n) => n.rho);
  return { names, test: seriesTest(rhos), positiveShare: rhos.length ? rhos.filter((r) => r > 0).length / rhos.length : null };
}

/** Average ranks (1-based), ties averaged. Pure. */
export function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = r;
    i = j + 1;
  }
  return out;
}

export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 3 || y.length !== n) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export function spearman(x: readonly number[], y: readonly number[]): number | null {
  return pearson(ranks(x), ranks(y));
}

/** Benjamini-Hochberg adjusted p-values (same order as input). Pure. */
export function benjaminiHochberg(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const adj = new Array<number>(m);
  let min = 1;
  for (let k = m - 1; k >= 0; k--) {
    const [p, i] = order[k]!;
    min = Math.min(min, (p * m) / (k + 1));
    adj[i] = Math.min(1, min);
  }
  return adj;
}

// ---------------------------------------------------------------------------
// H7: implied move vs ripple history

/**
 * Expected absolute abnormal move over L sessions implied by the options:
 * the idiosyncratic part of the ATM implied variance, sqrt(max(IV^2 -
 * beta^2 VIX^2, 0)), times sqrt(L / 252) times sqrt(2 / pi) (the mean
 * absolute value of a normal). With `vix` null, the total implied move (no
 * market part removed). Fractions in, percent out. Pure.
 */
export function impliedAbsMovePct(atmIv: number, L: number, beta: number | null = null, vix: number | null = null): number {
  let v = atmIv * atmIv;
  if (beta !== null && vix !== null) v = Math.max(v - beta * beta * vix * vix, 0);
  return Math.sqrt(v) * Math.sqrt(L / 252) * Math.sqrt(2 / Math.PI) * 100;
}

export type H7Pair = {
  date: string;
  event: string;
  hit: string;
  /** Historical mean |CAR_L| of the hit after similar past events (percent). */
  historyPct: number;
  historyN: number;
  /** Options' expected |abnormal move| over L (percent). */
  impliedPct: number;
  /** Realized |CAR_L| (percent). */
  realizedPct: number;
};

export type H7Summary = {
  pairs: number;
  dates: number;
  /** Pairs with history above implied (gap > 0). */
  gapPositive: number;
  /** Among gap > 0: share with realized > implied, and the clustered test of (1{realized > implied} - 0.5). */
  exceedShare: number | null;
  exceedTest: { mean: number; t: number; df: number; pOne: number; clusters: number } | null;
  /** Among gap <= 0, the same share (a contrast). */
  exceedShareGapNeg: number | null;
  /** All pairs: share where realized <= implied ("priced in": options covered the move). */
  pricedInShare: number | null;
  /** All pairs: share with gap <= 0 (options price at least what history says). */
  optionsAtLeastHistoryShare: number | null;
  /** Slope of (realized - implied) on gap, and its date-clustered t (pooled OLS, cluster-robust). */
  slope: { beta: number; t: number; df: number; pTwo: number } | null;
  /** Spearman of gap with (realized - implied). */
  rho: number | null;
  meanImplied: number | null;
  meanHistory: number | null;
  meanRealized: number | null;
  medianRatioRealizedToImplied: number | null;
  /**
   * Exploratory (not pre-registered): R = a + bI I + bH H, clustered by date.
   * The gap tests above share I on both sides (a noisy I alone makes the gap
   * "predict" R - I); bH asks whether history adds information beyond the options.
   */
  partial: { bI: number; tI: number; bH: number; tH: number; df: number } | null;
};

/** H7 tests over (event, hit) pairs. Pure. */
export function summarizeH7(pairs: readonly H7Pair[]): H7Summary {
  const pos = pairs.filter((p) => p.historyPct - p.impliedPct > 0);
  const neg = pairs.filter((p) => p.historyPct - p.impliedPct <= 0);
  const exceed = (l: readonly H7Pair[]) => (l.length ? l.filter((p) => p.realizedPct > p.impliedPct).length / l.length : null);
  let exceedTest: H7Summary["exceedTest"] = null;
  if (pos.length >= 3) {
    const ys = pos.map((p) => (p.realizedPct > p.impliedPct ? 0.5 : -0.5));
    const t = clusteredMeanTest(ys, pos.map((p) => p.date));
    exceedTest = { mean: t.mean, t: t.t, df: t.df, pOne: tOneSidedP(t.t, t.df), clusters: t.clusters };
  }
  const gaps = pairs.map((p) => p.historyPct - p.impliedPct);
  const diffs = pairs.map((p) => p.realizedPct - p.impliedPct);
  return {
    pairs: pairs.length,
    dates: new Set(pairs.map((p) => p.date)).size,
    gapPositive: pos.length,
    exceedShare: exceed(pos),
    exceedTest,
    exceedShareGapNeg: exceed(neg),
    pricedInShare: pairs.length ? pairs.filter((p) => p.realizedPct <= p.impliedPct).length / pairs.length : null,
    optionsAtLeastHistoryShare: pairs.length ? neg.length / pairs.length : null,
    slope: clusteredSlope(gaps, diffs, pairs.map((p) => p.date)),
    rho: pairs.length >= 3 ? spearman(gaps, diffs) : null,
    meanImplied: pairs.length ? mean(pairs.map((p) => p.impliedPct)) : null,
    meanHistory: pairs.length ? mean(pairs.map((p) => p.historyPct)) : null,
    meanRealized: pairs.length ? mean(pairs.map((p) => p.realizedPct)) : null,
    medianRatioRealizedToImplied: pairs.length ? median(pairs.filter((p) => p.impliedPct > 0).map((p) => p.realizedPct / p.impliedPct)) : null,
    partial: (() => {
      const r = clusteredOls([pairs.map((p) => p.impliedPct), pairs.map((p) => p.historyPct)], pairs.map((p) => p.realizedPct), pairs.map((p) => p.date));
      return r ? { bI: r.beta[1]!, tI: r.t[1]!, bH: r.beta[2]!, tH: r.t[2]!, df: r.df } : null;
    })(),
  };
}

/**
 * OLS slope of y on x with a cluster-robust (CR1) standard error, clusters
 * by key; df = clusters - 1. Null with fewer than 3 clusters or no spread
 * in x. Pure.
 */
export function clusteredSlope(x: readonly number[], y: readonly number[], keys: readonly string[]): { beta: number; t: number; df: number; pTwo: number } | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i]! - mx) ** 2;
    sxy += (x[i]! - mx) * (y[i]! - my);
  }
  if (!(sxx > 0)) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const score = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const e = y[i]! - alpha - beta * x[i]!;
    score.set(keys[i]!, (score.get(keys[i]!) ?? 0) + (x[i]! - mx) * e);
  }
  const G = score.size;
  if (G < 3) return null;
  let meat = 0;
  for (const s of score.values()) meat += s * s;
  const corr = (G / (G - 1)) * ((n - 1) / (n - 2));
  const se = Math.sqrt((corr * meat) / (sxx * sxx));
  const t = se > 0 ? beta / se : 0;
  return { beta, t, df: G - 1, pTwo: tTwoSidedP(t, G - 1) };
}

/**
 * OLS of y on a constant and the columns of `xs` with cluster-robust (CR1)
 * standard errors; df = clusters - 1. Returns [constant, ...slopes]. Null
 * when singular or with fewer than 3 clusters. Pure.
 */
export function clusteredOls(xs: ReadonlyArray<readonly number[]>, y: readonly number[], keys: readonly string[]): { beta: number[]; t: number[]; df: number } | null {
  const n = y.length;
  const k = xs.length + 1;
  if (n <= k) return null;
  const row = (i: number) => [1, ...xs.map((c) => c[i]!)];
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const r = row(i);
    for (let a = 0; a < k; a++) {
      xty[a]! += r[a]! * y[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b]! += r[a]! * r[b]!;
    }
  }
  const inv = invert(xtx);
  if (!inv) return null;
  const beta = inv.map((r) => r.reduce((s, v, j) => s + v * xty[j]!, 0));
  const scores = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const r = row(i);
    const e = y[i]! - r.reduce((s, v, j) => s + v * beta[j]!, 0);
    const sc = scores.get(keys[i]!) ?? new Array<number>(k).fill(0);
    for (let a = 0; a < k; a++) sc[a]! += r[a]! * e;
    scores.set(keys[i]!, sc);
  }
  const G = scores.size;
  if (G < 3) return null;
  const meat = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (const sc of scores.values()) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a]![b]! += sc[a]! * sc[b]!;
  const corr = (G / (G - 1)) * ((n - 1) / (n - k));
  const t = beta.map((b, a) => {
    let v = 0;
    for (let p = 0; p < k; p++) for (let q = 0; q < k; q++) v += inv[a]![p]! * meat[p]![q]! * inv[q]![a]!;
    const se = Math.sqrt(corr * v);
    return se > 0 ? b / se : 0;
  });
  return { beta, t, df: G - 1 };
}

/** Gauss-Jordan inverse of a small matrix; null when singular. */
function invert(m: number[][]): number[][] | null {
  const k = m.length;
  const a = m.map((r, i) => [...r, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-12) return null;
    [a[c], a[p]] = [a[p]!, a[c]!];
    const d = a[c]![c]!;
    for (let j = 0; j < 2 * k; j++) a[c]![j]! /= d;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = a[r]![c]!;
      if (f !== 0) for (let j = 0; j < 2 * k; j++) a[r]![j]! -= f * a[c]![j]!;
    }
  }
  return a.map((r) => r.slice(k));
}

/** The first session at or after `fromIndex` whose 15:45 New York snapshot is after `publicMs` (index into sessions). Pure. */
export function snapshotIndexAfter(sessions: readonly string[], publicMs: number, snapshotMs: (d: string) => number): number | null {
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snapshotMs(sessions[mid]!) > publicMs) hi = mid;
    else lo = mid + 1;
  }
  return lo < sessions.length ? lo : null;
}
