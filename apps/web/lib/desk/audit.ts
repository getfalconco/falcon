/**
 * The independent audit of a Desk strategy test (falcon_result.json written
 * by Claude's Python script). Pure: the route (lib/desk/audit-run.ts) gathers
 * the inputs and this file turns them into checks and the evidence label.
 *
 * Inputs, all produced outside the script's own numbers:
 *   - a code review of the final script for look-ahead (Claude Haiku, issues
 *     with line numbers);
 *   - re-runs of the script's `run()` in the same sandbox by a fixed harness
 *     (lib/desk/audit-harness.ts): costs x2, signal lag +1 day, and random-pick
 *     placebo versions;
 *   - the daily bars the test loaded (from the server's price cache), for
 *     fill prices against each day's high and low, entries against their
 *     signal dates, and the list held at equal weight (hindsight check 14).
 *
 * The label reuses the Strategy Lab's texts and rules (@falcon/backtest:
 * evidenceLabel, hindsightTexts, EVIDENCE_*), so the Desk and the Lab speak
 * the same way. Desk-only caps: no re-runs, a likely look-ahead, impossible
 * fills or no trading costs keep the label at Weak evidence at best.
 */

import {
  EVIDENCE_HEADING,
  EVIDENCE_SOURCE,
  EVIDENCE_SUBTITLE,
  EVIDENCE_TITLE,
  evidenceLabel,
  hacT,
  hindsightSignals,
  hindsightTexts,
  intentSaysTodaysList,
  percentileOf,
  type EvidenceLevel,
  type HindsightCap,
  type ListStats,
} from "@falcon/backtest";
import { TRADES_DEFINITION, benchmarkName, fmtPct, type RunResult, type RunTrade } from "./run-result";
import type { EventCheck } from "./event-spec";
import {
  OOS_GRADE_TEXT,
  dsrMethod,
  dsrPlain,
  fmtPts,
  gradeOf,
  headlineOf,
  multipleTesting,
  splitStats,
  wholeStats,
  type Headline,
  type HeadlineFigures,
  type HeadlinePart,
  type MultipleTesting,
  type PeriodStats,
  type SplitStats,
} from "./robustness";

/* ------------------------------------------------------------------ types */

export type ReviewIssue = { line: number | null; severity: "high" | "medium" | "low"; kind: string; issue: string };
export type CodeReview = { ok: true; issues: ReviewIssue[] } | { ok: false; error: string };

export type VariantStats = { cagr: number | null; active_pct: number | null; total_return: number | null; trades: number | null };

/** falcon_audit.json from the harness, checked. */
export type HarnessOutput = {
  error: string | null;
  defaults: { costs_bps: number | null; lag_days: number | null };
  /** Parameters run() takes (the harness skips variants it cannot express). */
  params: string[];
  costs_x2: (VariantStats & { costs_bps: number | null }) | null;
  lag_plus1: (VariantStats & { lag_days: number | null }) | null;
  base: VariantStats | null;
  /** The reported result file measured like the re-runs (the route may only have a cut copy of its curve). */
  reported: VariantStats | null;
  placebo: { seed: number; active_pct: number }[];
  placebo_wanted: number;
  errors: string[];
  elapsed_s: number | null;
  /** False while re-runs are still pending (they carry on in the next request); null from an older harness or on an error. */
  complete: boolean | null;
  /** Jobs not run yet: "costs_x2", "lag_plus1", "placebo:<seed>", "base". */
  pending: string[];
  /** Harness calls on this script so far, versions run by this call, the median seconds per version. */
  hops: number | null;
  ran: number | null;
  job_s: number | null;
};

export type DayBar = { date: string; open: number; high: number; low: number; close: number };

/** The list the test traded, from its load_prices calls. */
export type AuditUniverse = {
  /** Tradable tickers (the benchmark SPY left out unless it is the only one). */
  tickers: string[];
  /** A named Falcon list ("S&P 500 members as of ..."), null for typed tickers. */
  listName: string | null;
  /** The named list is today's membership by construction. */
  todaysPick: boolean;
  /** The sector ETFs are a fixed set, not a list chosen today. */
  fixedSet: boolean;
};

export type AuditCheckStatus = "pass" | "flag" | "info" | "skipped";
export type AuditCheck = { id: string; name: string; status: AuditCheckStatus; detail: string; items?: string[] };

export type DeskAudit = {
  version: 1;
  /** The benchmark every label, row and excess figure uses (the result's own, else the load_prices benchmark, else SPY). */
  benchmark?: string;
  /** The whole test measured like its parts (lib/desk/robustness.ts wholeStats). */
  whole?: PeriodStats | null;
  /** The numbers the panel's tiles show and the model quotes verbatim. */
  headline?: Headline;
  label: { level: EvidenceLevel; title: string; heading: string; subtitle: string; reasons: string[]; source: { label: string; url: string } };
  checks: AuditCheck[];
  /** Strategy vs the list held equally vs SPY (the market, whatever the benchmark), CAGR as decimals (check 14). */
  comparison: { strategy: number | null; list: number | null; spy: number | null; listName: string } | null;
  /** Versions tried and the deflated Sharpe correction (lib/desk/robustness.ts). */
  multiple?: MultipleTesting;
  /** In-sample vs out-of-sample, on the full curve. */
  split?: SplitStats | null;
  /** What the member should keep in mind next to the numbers. */
  caveats?: AuditCaveats;
};

export type AuditCaveats = {
  /** A list of today's members: how many had no prices yet at the test's start. */
  survivorship: { late: number; total: number; listName: string } | null;
  /** Where the prices came from. */
  dataSource: string | null;
};

/* ------------------------------------------------------------------ small helpers */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown): number | null => (isNum(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** "+12.3% a year" from a percent number. */
const pa = (pct: number | null) => (pct === null ? "n/a" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% a year`);

/** Annualized arithmetic mean of daily values, percent (x 252 x 100). */
export const annualPct = (daily: readonly number[]) => mean(daily) * 252 * 100;

/** CAGR (decimal) of a curve between two dates. */
export function curveCagr(first: number, last: number, from: string, to: string): number | null {
  const years = (dayMs(to) - dayMs(from)) / (365.25 * 86_400_000);
  if (!(first > 0) || !(last > 0) || !(years > 0)) return null;
  return (last / first) ** (1 / years) - 1;
}

/** Daily strategy and benchmark returns where both are known on two days in a row. */
export function pairedReturns(r: RunResult): { dates: string[]; strat: number[]; bench: number[] } {
  const s = r.series;
  const dates: string[] = [];
  const strat: number[] = [];
  const bench: number[] = [];
  for (let i = 1; i < s.dates.length; i++) {
    const e0 = s.equity[i - 1]!;
    const e1 = s.equity[i]!;
    const b0 = s.benchmark_equity[i - 1];
    const b1 = s.benchmark_equity[i];
    if (!(e0 > 0) || !isNum(e1) || !isNum(b0) || !(b0 > 0) || !isNum(b1)) continue;
    dates.push(s.dates[i]!);
    strat.push(e1 / e0 - 1);
    bench.push(b1 / b0 - 1);
  }
  return { dates, strat, bench };
}

/* ------------------------------------------------------------------ harness output */

function variant(v: unknown): VariantStats | null {
  const o = obj(v);
  if (!Object.keys(o).length || o.error) return null;
  const s: VariantStats = { cagr: num(o.cagr), active_pct: num(o.active_pct), total_return: num(o.total_return), trades: num(o.trades) };
  return s.active_pct === null && s.cagr === null ? null : s;
}

/** Reads falcon_audit.json (lenient on types). */
export function parseHarnessOutput(raw: unknown): HarnessOutput {
  const o = obj(raw);
  const v = obj(o.variants);
  const d = obj(o.defaults);
  const c2 = variant(v.costs_x2);
  const l1 = variant(v.lag_plus1);
  const placebo: HarnessOutput["placebo"] = [];
  for (const p of Array.isArray(o.placebo) ? o.placebo : []) {
    const a = num(obj(p).active_pct);
    if (a !== null) placebo.push({ seed: num(obj(p).seed) ?? placebo.length, active_pct: a });
  }
  return {
    error: typeof o.error === "string" && o.error ? o.error.slice(0, 400) : null,
    defaults: { costs_bps: num(d.costs_bps), lag_days: num(d.lag_days) },
    params: Array.isArray(o.params) ? o.params.filter((x): x is string => typeof x === "string").slice(0, 20) : [],
    costs_x2: c2 ? { ...c2, costs_bps: num(obj(v.costs_x2).costs_bps) } : null,
    lag_plus1: l1 ? { ...l1, lag_days: num(obj(v.lag_plus1).lag_days) } : null,
    base: variant(v.base),
    reported: variant(v.reported),
    placebo: placebo.slice(0, 100),
    placebo_wanted: num(o.placebo_wanted) ?? 0,
    errors: (Array.isArray(o.errors) ? o.errors : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 300)).slice(0, 5),
    elapsed_s: num(o.elapsed_s),
    complete: typeof o.complete === "boolean" ? o.complete : null,
    pending: (Array.isArray(o.pending) ? o.pending : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 40)).slice(0, 200),
    hops: num(o.hops),
    ran: num(o.ran),
    job_s: num(o.job_s),
  };
}

/* ------------------------------------------------------------------ code review */

/** Reads the reviewer's JSON reply ({"issues": [...]}); tolerant of prose or a code fence around it. */
export function parseReview(text: string, maxLine = Infinity): CodeReview {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "The code review did not return a verdict." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, error: "The code review returned an unreadable verdict." };
  }
  const issues: ReviewIssue[] = [];
  for (const x of Array.isArray(obj(parsed).issues) ? (obj(parsed).issues as unknown[]) : []) {
    const i = obj(x);
    const issue = typeof i.issue === "string" ? i.issue.trim().slice(0, 400) : "";
    if (!issue) continue;
    const sev = i.severity === "high" || i.severity === "medium" || i.severity === "low" ? i.severity : "medium";
    const line = num(i.line);
    issues.push({ line: line !== null && line >= 1 && line <= maxLine ? Math.round(line) : null, severity: sev, kind: typeof i.kind === "string" ? i.kind.slice(0, 40) : "other", issue });
  }
  return { ok: true, issues: issues.slice(0, 12) };
}

/* ------------------------------------------------------------------ deterministic checks on the result */

/** Relative slack for prices rounded in the CSV (4 decimals / 6 significant digits) and float noise. */
export const PRICE_TOLERANCE = 0.002;

type BarIndex = Map<string, Map<string, DayBar>>;
function indexBars(bars: Map<string, DayBar[]>): BarIndex {
  const out: BarIndex = new Map();
  bars.forEach((list, t) => out.set(t, new Map(list.map((b) => [b.date, b]))));
  return out;
}
const yahoo = (t: string) => t.toUpperCase().replace(".", "-");

/** Fills outside the day's low..high (with PRICE_TOLERANCE), and on days the stock did not trade. */
export function fillPriceCheck(trades: RunTrade[], bars: Map<string, DayBar[]>): { checked: number; outside: string[]; noBar: number } {
  const idx = indexBars(bars);
  let checked = 0;
  let noBar = 0;
  const outside: string[] = [];
  for (const t of trades) {
    if (t.price === null || !(t.price > 0)) continue;
    const b = idx.get(yahoo(t.ticker))?.get(t.date);
    if (!b) {
      if (idx.has(yahoo(t.ticker))) noBar++;
      continue;
    }
    checked++;
    if (t.price < b.low * (1 - PRICE_TOLERANCE) || t.price > b.high * (1 + PRICE_TOLERANCE)) {
      outside.push(`${t.date} ${t.side} ${t.ticker} at ${t.price.toFixed(2)}, the day's range was ${b.low.toFixed(2)}–${b.high.toFixed(2)}`);
    }
  }
  return { checked, outside, noBar };
}

/** Buys dated on or before the day whose data made their signal (needs `signal_date` on the trades). */
export function signalTimingCheck(trades: RunTrade[], bars: Map<string, DayBar[]> | null): { checked: number; before: string[]; sameDay: string[] } {
  const idx = bars ? indexBars(bars) : null;
  let checked = 0;
  const before: string[] = [];
  const sameDay: string[] = [];
  for (const t of trades) {
    if (t.side !== "buy" || !t.signal_date) continue;
    checked++;
    if (t.date < t.signal_date) before.push(`${t.ticker} bought ${t.date} on a signal dated ${t.signal_date}`);
    else if (t.date === t.signal_date) {
      const b = idx?.get(yahoo(t.ticker))?.get(t.date);
      const where = b && t.price !== null ? (Math.abs(t.price / b.close - 1) <= PRICE_TOLERANCE ? " at that day's close" : Math.abs(t.price / b.open - 1) <= PRICE_TOLERANCE ? " at that day's open, before the close that made the signal" : "") : "";
      sameDay.push(`${t.ticker} bought ${t.date}${where}, the same day as its signal`);
    }
  }
  return { checked, before, sameDay };
}

/** Trades dated outside the test period. */
export function periodCheck(r: RunResult): string[] {
  const out: string[] = [];
  for (const t of r.trades) {
    if (r.period.start && t.date < r.period.start) out.push(`${t.date} ${t.side} ${t.ticker} is before the test start (${r.period.start})`);
    else if (r.period.end && t.date > r.period.end) out.push(`${t.date} ${t.side} ${t.ticker} is after the test end (${r.period.end})`);
  }
  return out;
}

/** Closed round trips (TRADES_DEFINITION): counted on the full list by validateRunResult; else sells in the list, or half the rows when the list was cut. */
export function roundTrips(r: RunResult): number {
  if (typeof r.closed_trades === "number" && Number.isFinite(r.closed_trades)) return r.closed_trades;
  const sells = r.trades.filter((t) => t.side === "sell").length;
  if (r.trade_count > r.trades.length) return Math.max(sells, Math.round(r.trade_count / 2));
  return sells;
}

/** Most positions held at once, from the trade list (buys open, sells close). */
export function maxConcurrent(trades: RunTrade[]): number {
  const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
  const open = new Map<string, number>();
  let n = 0;
  let max = 0;
  for (const t of sorted) {
    const k = open.get(t.ticker) ?? 0;
    if (t.side === "buy") {
      if (k === 0) n++;
      open.set(t.ticker, k + 1);
    } else if (k > 0) {
      open.set(t.ticker, 0);
      n--;
    }
    max = Math.max(max, n);
  }
  return max;
}

/* ------------------------------------------------------------------ the list held equally (check 14) */

/**
 * The list held at equal weight (rebalanced daily, names join when they list)
 * against SPY and the strategy over the test's dates. Percent, as in tiers.ts.
 */
export function listStats(r: RunResult, bars: Map<string, DayBar[]>, tickers: string[], spyTicker = "SPY"): (ListStats & { days: number }) | null {
  const spy = bars.get(spyTicker);
  if (!spy?.length) return null;
  const start = r.period.start || r.series.dates[0] || "";
  const end = r.period.end || r.series.dates[r.series.dates.length - 1] || "";
  const days = spy.filter((b) => b.date >= start && b.date <= end).map((b) => b.date);
  if (days.length < 20) return null;
  const closes = tickers.map((t) => bars.get(yahoo(t))).filter((b): b is DayBar[] => !!b?.length).map((b) => new Map(b.map((x) => [x.date, x.close])));
  if (closes.length < 2) return null;
  const spyClose = new Map(spy.map((b) => [b.date, b.close]));
  const ew: number[] = [];
  const sp: number[] = [];
  const byDate = new Map<string, number>();
  for (let i = 1; i < days.length; i++) {
    const d0 = days[i - 1]!;
    const d1 = days[i]!;
    let sum = 0;
    let k = 0;
    for (const c of closes) {
      const a = c.get(d0);
      const b = c.get(d1);
      if (a && b && a > 0) {
        sum += b / a - 1;
        k++;
      }
    }
    const s0 = spyClose.get(d0)!;
    const s1 = spyClose.get(d1)!;
    if (!k) continue;
    ew.push(sum / k);
    sp.push(s1 / s0 - 1);
    byDate.set(d1, sum / k);
  }
  const grow = (xs: number[]) => xs.reduce((a, x) => a * (1 + x), 1);
  const toPct = (c: number | null) => (c === null ? null : c * 100);
  const listCagr = toPct(curveCagr(1, grow(ew), days[0]!, days[days.length - 1]!));
  const spyCagr = toPct(curveCagr(1, grow(sp), days[0]!, days[days.length - 1]!));
  // The strategy's daily returns on the same days, against the list.
  const p = pairedReturns(r);
  const edge: number[] = [];
  p.dates.forEach((d, i) => {
    const e = byDate.get(d);
    if (e !== undefined) edge.push(p.strat[i]! - e);
  });
  const s = r.series;
  const stratCagr = s.dates.length > 1 ? curveCagr(s.equity[0]!, s.equity[s.equity.length - 1]!, s.dates[0]!, s.dates[s.dates.length - 1]!) : r.metrics.cagr;
  return {
    listCagr,
    spyCagr,
    strategyCagr: toPct(stratCagr ?? r.metrics.cagr),
    excessPct: annualPct(ew.map((x, i) => x - sp[i]!)),
    edgePct: edge.length >= 20 ? annualPct(edge) : null,
    days: ew.length,
  };
}

/** Tickers whose first bar comes after the first day of the test (not listed yet at the start). */
export function lateListings(bars: Map<string, DayBar[]>, tickers: string[], start: string): string[] {
  const out: string[] = [];
  for (const t of tickers) {
    const b = bars.get(yahoo(t));
    if (b?.length && b[0]!.date > start) out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ the audit */

export type AuditInput = {
  result: RunResult;
  review: CodeReview | null;
  harness: HarnessOutput | null;
  /** Why the re-runs did not happen (no run(), out of time, sandbox error). */
  harnessError?: string | null;
  bars: Map<string, DayBar[]> | null;
  universe: AuditUniverse | null;
  /** The member's request, for the "today's list" wording (check 14). */
  intent: string;
  /** Strategy tests in this conversation, this one included (deflated Sharpe). */
  trials: number;
  today: string;
  /** The price source of the bars (getDailyBars), for the data note. */
  dataSource?: string | null;
  /** The benchmark load_prices was asked for, used when the result names none. */
  benchmarkHint?: string | null;
  /** The script is Falcon's event-backtest script, unedited (lib/desk/event-backtest-py.ts): no model-written code to review. */
  canonicalScript?: boolean;
  /** An event test from declared rules: whether its trades follow them (lib/desk/event-spec.ts checkEventTrades). */
  eventCheck?: EventCheck | null;
  /** An event test the model wrote its own script for (it loaded events but did not use event_backtest). */
  customEventScript?: boolean;
};

/** Placebo versions needed before the comparison counts. */
export const MIN_PLACEBOS = 10;

export function buildDeskAudit(input: AuditInput): DeskAudit {
  const { review, harness, bars } = input;
  // One benchmark for every label: the result's own name, else what load_prices was asked for, else SPY.
  const B = input.result.benchmark?.trim() || input.benchmarkHint?.trim() || benchmarkName(null);
  const r: RunResult = { ...input.result, benchmark: B };
  const checks: AuditCheck[] = [];
  /** Desk caps: reasons that keep the label at Weak evidence at best. */
  const caps: string[] = [];

  const p = pairedReturns(r);
  const active = p.strat.map((x, i) => x - p.bench[i]!);
  // The average excess return over the benchmark as tested (arithmetic, daily x 252): from the full result file when the harness measured it (the curve here may be cut).
  const A = harness?.reported?.active_pct ?? (active.length >= 20 ? annualPct(active) : null);
  // The period wins over the curve's dates: a long curve may have been cut to MAX_SERIES_POINTS.
  const years = r.period.start && r.period.end ? (dayMs(r.period.end) - dayMs(r.period.start)) / (365.25 * 86_400_000) : r.series.dates.length > 1 ? (dayMs(r.series.dates[r.series.dates.length - 1]!) - dayMs(r.series.dates[0]!)) / (365.25 * 86_400_000) : 0;

  // 1. Code review for look-ahead (an event test run by Falcon's helper has no model-written code: the helper is unit-tested).
  if (input.canonicalScript)
    checks.push({
      id: "review",
      name: "Code review for look-ahead",
      status: "pass",
      detail: "No model-written code: Falcon's event-backtest helper ran the declared rules. It is unit-tested for entry timing (pre-market and after-close releases), overlapping holds, missing prices, delisted stocks, costs and identical results run to run.",
    });
  else if (!review) checks.push({ id: "review", name: "Code review for look-ahead", status: "skipped", detail: "The script was not available to review." });
  else if (!review.ok) checks.push({ id: "review", name: "Code review for look-ahead", status: "skipped", detail: review.error });
  else {
    const serious = review.issues.filter((i) => i.severity === "high");
    const items = review.issues.map((i) => `${i.line ? `Line ${i.line}: ` : ""}${i.issue}${i.severity === "high" ? "" : ` (${i.severity})`}`);
    checks.push({
      id: "review",
      name: "Code review for look-ahead",
      status: serious.length ? "flag" : review.issues.length ? "info" : "pass",
      detail: serious.length
        ? `An independent review of the script found ${plural(serious.length, "likely look-ahead problem")}: the result may use information that was not known on the day of the trade.`
        : review.issues.length
          ? "An independent review found no clear look-ahead; it noted the points below."
          : "An independent review of the script found no use of future data and no same-bar fills.",
      items: items.length ? items : undefined,
    });
    if (serious.length) caps.push(`The code review found a likely look-ahead${serious[0]!.line ? ` (line ${serious[0]!.line})` : ""}: ${serious[0]!.issue.replace(/\.$/, "")}.`);
  }

  // 2. Fills inside the day's range (an event test's rules check already matched every fill to that day's open or close).
  if (!bars && input.eventCheck?.status === "pass")
    checks.push({ id: "fills", name: "Fill prices within the day's range", status: "pass", detail: "Every entry and exit price matches that day's open or close (checked with the trades against the declared rules), so every fill is within the day's range." });
  else if (!bars) checks.push({ id: "fills", name: "Fill prices within the day's range", status: "skipped", detail: "The daily bars could not be loaded for this check." });
  else {
    const f = fillPriceCheck(r.trades, bars);
    if (!f.checked) checks.push({ id: "fills", name: "Fill prices within the day's range", status: "skipped", detail: r.trades.length ? "No trade had a price on a day with a bar to compare." : "The result lists no trades." });
    else {
      checks.push({
        id: "fills",
        name: "Fill prices within the day's range",
        status: f.outside.length ? "flag" : "pass",
        detail: f.outside.length
          ? `${plural(f.outside.length, "trade")} of ${f.checked.toLocaleString("en-US")} filled at a price the stock never traded at that day.`
          : `All ${plural(f.checked, "trade")} with a price filled between that day's low and high.${f.noBar ? ` ${plural(f.noBar, "trade")} fell on days without a bar.` : ""}`,
        items: f.outside.length ? f.outside.slice(0, 8) : undefined,
      });
      if (f.outside.length) caps.push(`${plural(f.outside.length, "trade")} filled at prices outside that day's high and low, so the fills are not realistic.`);
    }
  }

  // 3. Entries after their signal, and trades inside the test period.
  {
    const s = signalTimingCheck(r.trades, bars);
    const outsidePeriod = periodCheck(r);
    if (!s.checked && !outsidePeriod.length) {
      checks.push({ id: "timing", name: "Entries after their signal", status: "skipped", detail: "The trades carry no signal dates (signal_date), so entry timing could not be checked from the result." });
    } else {
      const bad = [...s.before, ...s.sameDay, ...outsidePeriod];
      checks.push({
        id: "timing",
        name: "Entries after their signal",
        status: bad.length ? "flag" : "pass",
        detail: bad.length
          ? `${plural(bad.length, "trade")} ${bad.length === 1 ? "was" : "were"} placed before or on the day of the data that triggered ${bad.length === 1 ? "it" : "them"}, or outside the test period.`
          : `All ${plural(s.checked, "entry", "entries")} came on a later day than the data behind their signal.`,
        items: bad.length ? bad.slice(0, 8) : undefined,
      });
      if (s.before.length || s.sameDay.length) caps.push("Some entries trade on the same day as, or before, the data that triggered them, which uses information not available in time.");
    }
  }

  // 3b. The trades follow the declared rules (an event test from event_backtest), or the test came from a custom script.
  const ec = input.eventCheck;
  if (ec) {
    checks.push({ id: "rules", name: "Trades follow the declared rules", status: ec.status, detail: ec.detail, ...(ec.items.length ? { items: ec.items.slice(0, 8) } : {}) });
    if (ec.status === "flag") caps.push(`The trades do not match the declared rules (${ec.detail.replace(/^The trades do not match the declared rules: /, "").replace(/\.$/, "")}), so the numbers may not be the test that was asked for.`);
  } else if (input.customEventScript) {
    checks.push({
      id: "rules",
      name: "Event rules",
      status: "info",
      detail: "This event test came from a custom script written for this question, not from Falcon's event-backtest helper, so its trades were not checked against declared rules and another run of the same question can give different numbers.",
    });
  }

  // 4. Trading costs.
  const costs = r.assumptions.costs_bps;
  if (costs === null || !(costs > 0)) {
    checks.push({ id: "costs", name: "Trading costs included", status: "flag", detail: costs === null ? "The result does not say what trading costs it charged." : "The test charged no trading costs." });
    caps.push("The test assumed no trading costs, which flatters any strategy that trades.");
  } else checks.push({ id: "costs", name: "Trading costs included", status: "pass", detail: `${costs} bps per side charged on every trade.` });

  // 5. Sample size (tiers.ts check 6 wording).
  const n = roundTrips(r);
  const insufficient = n < 30 || years < 3;
  const insufficientText =
    years < 3
      ? `The test covers only ${r1(years)} years. Use at least 3 years to judge.`
      : `Only ${n} ${n === 1 ? "trade" : "trades"} in ${r1(years)} years. With fewer than 30, a good or bad result can easily be luck. A longer period, more tickers or a rule that triggers more often gives more trades.`;
  checks.push({ id: "sample", name: "Sample size", status: insufficient ? "flag" : "pass", detail: insufficient ? insufficientText : `${plural(n, "closed trade")} over ${r1(years)} years.` });

  // 6-8. Re-runs in the sandbox.
  const h = harness && !harness.error ? harness : null;
  const whyNot = harness?.error ?? input.harnessError ?? "The re-runs did not run.";
  let costsPass = true;
  let delayPass = true;
  let nullPct: number | null = null;
  /** A re-run still pending when the audit ended: it did not finish in time (never a silent skip). */
  const unfinished = (job: string) => !!h?.pending?.includes(job);
  const failedText = (what: string, job: string) =>
    unfinished(job) ? `The re-run ${what} did not finish in time${h?.job_s ? ` (about ${r1(h.job_s)} s a run)` : ""}, so this check is incomplete.` : `The re-run ${what} failed${h?.errors[0] ? `: ${h.errors[0]}` : "."}`;
  const x2 = h?.costs_x2?.active_pct ?? null;
  if (x2 === null || A === null) checks.push({ id: "costs_x2", name: "Doubled costs", status: "skipped", detail: A === null ? `The result has no daily curve against ${B} to compare.` : h ? failedText("with doubled costs", "costs_x2") : whyNot });
  else {
    costsPass = !(A > 0) || x2 > 0;
    checks.push({
      id: "costs_x2",
      name: "Doubled costs",
      status: costsPass ? "pass" : "flag",
      detail: `With costs doubled${h?.costs_x2?.costs_bps !== null && h?.costs_x2?.costs_bps !== undefined ? ` (${h.costs_x2.costs_bps} bps per side)` : ""}, the average excess return over ${B} is ${pa(x2)}, against ${pa(A)} as tested.`,
    });
  }
  const lag = h?.lag_plus1?.active_pct ?? null;
  if (lag === null || A === null) checks.push({ id: "delay", name: "One-day delay", status: "skipped", detail: A === null ? `The result has no daily curve against ${B} to compare.` : h ? failedText("one day later", "lag_plus1") : whyNot });
  else {
    const drop = A > 0 ? ((A - lag) / A) * 100 : null;
    delayPass = drop === null || drop <= 50;
    checks.push({
      id: "delay",
      name: "One-day delay",
      status: delayPass ? "pass" : "flag",
      detail: `Acting one day later, the average excess return over ${B} is ${pa(lag)}, against ${pa(A)}${drop !== null ? ` (${r1(Math.max(0, drop))}% of it gone)` : ""}.`,
    });
  }
  const placebos = h?.placebo.map((x) => x.active_pct) ?? [];
  const wanted = Math.max(h?.placebo_wanted ?? 0, placebos.length);
  const placeboUnfinished = !!h?.pending?.some((j) => j.startsWith("placebo"));
  /** "k of N finished": said whenever fewer than all ran, so a partial comparison is never shown as a full one. */
  const doneText = wanted ? `${placebos.length} of ${wanted} random versions finished` : "";
  if (A === null || placebos.length < MIN_PLACEBOS) {
    // Incomplete (some ran, too few to count): flagged, and the label below cannot count it as passed.
    const partial = A !== null && !!h && (placebos.length > 0 || placeboUnfinished);
    checks.push({
      id: "placebo",
      name: "Random versions",
      status: partial ? "flag" : "skipped",
      detail:
        A === null
          ? `The result has no daily curve against ${B} to compare.`
          : !h
            ? whyNot
            : partial
              ? `Random comparison incomplete: ${doneText}${placeboUnfinished ? " in time" : ""}${h.job_s ? ` (about ${r1(h.job_s)} s a run)` : ""}; at least ${MIN_PLACEBOS} are needed, so it does not count as passed.`
              : !h.params.includes("random_picks") && h.params.length
                ? "The script's run() has no random_picks setting, so random versions could not be run."
                : `The random versions did not run${h.errors[0] ? `: ${h.errors[0]}` : "."}`,
    });
  } else {
    nullPct = percentileOf(A, placebos);
    const beaten = Math.round((nullPct / 100) * placebos.length);
    const sorted = [...placebos].sort((a, b) => a - b);
    checks.push({
      id: "placebo",
      name: "Random versions",
      status: nullPct >= 90 ? "pass" : "flag",
      detail: `The strategy beat ${beaten} of ${placebos.length} versions that follow the same rules with random picks (their median: ${pa(sorted[sorted.length >> 1]!)} over ${B}; the strategy: ${pa(A)}). ${placebos.length < wanted ? `Random comparison incomplete: ${doneText} in time.` : `All ${wanted} random versions finished.`}`,
    });
  }
  // A random comparison that did not run or did not finish never counts as passed (the Lab's rule only fails a low percentile).
  if (A !== null && nullPct === null && !insufficient && h) caps.push(placebos.length ? `The random comparison is incomplete (${doneText}), so the result cannot count as more than weak evidence.` : "The script's random versions did not run, so the result cannot count as more than weak evidence.");
  const reran = x2 !== null && lag !== null;
  if (!reran && !insufficient)
    caps.push(
      unfinished("costs_x2") || unfinished("lag_plus1")
        ? "The re-runs with doubled costs and a one-day delay did not finish in time, so the result cannot count as more than weak evidence."
        : "The script could not be re-run with doubled costs and a one-day delay, so the result cannot count as more than weak evidence.",
    );

  // Reproducibility: run() with its defaults gives the reported result.
  if (h?.base && A !== null && h.base.active_pct !== null) {
    const same = Math.abs(h.base.active_pct - A) <= Math.max(0.5, Math.abs(A) * 0.05);
    checks.push({
      id: "repro",
      name: "Same result when re-run",
      status: same ? "pass" : "flag",
      detail: same ? `Re-running the script's run() with its defaults gave the same result (${pa(h.base.active_pct)} over ${B}).` : `Re-running run() with its defaults gave ${pa(h.base.active_pct)} over ${B}, not the ${pa(A)} reported: the reported numbers do not come from run().`,
    });
    if (!same) caps.push("Re-running the script did not reproduce the reported numbers.");
  }

  // Best of N tried: the deflated Sharpe of the ACTIVE daily returns (strategy minus the benchmark), so it measures beating
  // the benchmark, not making money; the evidence label uses this same number.
  const configs = r.sweep?.configs_tried ?? 1;
  const totalTrials = Math.max(1, input.trials - 1 + configs);
  const multiple = multipleTesting(active, { trials: totalTrials, configs, params: r.sweep?.params, chosenOn: r.sweep?.chosen_on ?? null, sweepSharpes: r.sweep?.sharpes, benchmark: B });
  if (totalTrials > 1) {
    const f2 = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
    const strong = multiple.dsr !== null && multiple.dsr >= 0.95;
    const what = configs > 1 ? `Best of ${configs.toLocaleString("en-US")} versions tried${r.sweep?.params ? ` (${r.sweep.params})` : ""}${input.trials > 1 ? `, ${plural(totalTrials, "version")} in this conversation` : ""}` : `${plural(totalTrials, "strategy test")} in this conversation`;
    checks.push({
      id: "multiple",
      name: configs > 1 ? `Best of ${configs.toLocaleString("en-US")} tried` : "Versions tried",
      status: strong ? "pass" : configs > 1 ? "flag" : "info",
      detail: `${what}. ${dsrPlain(multiple)} (deflated Sharpe on the daily return over ${B}; 95% or more counts as clear of luck). Its Sharpe over ${B} is ${f2(multiple.sharpe)}; the best of ${totalTrials.toLocaleString("en-US")} random versions would reach about ${f2(multiple.luckSharpe)} by luck, leaving ${f2(multiple.adjustedSharpe)}.`,
      items: [dsrMethod(B)],
    });
    if (configs > 1 && !strong) caps.push(`This is the best of ${configs.toLocaleString("en-US")} versions tried; after correcting for that, it is not clearly better than ${B} (${dsrPlain(multiple).replace(/^Chance/, "chance")}).`);
  }

  // In-sample vs out-of-sample, graded against the Sharpe's sampling error (lib/desk/robustness.ts oosGrade).
  const split = splitStats(r);
  if (!split) checks.push({ id: "oos", name: "Out of sample", status: "skipped", detail: "The curve is too short to hold part of it out (at least 60 trading days on each side)." });
  else {
    const f2 = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
    const where = split.method === "default_30" ? `Falcon held out the last 30% (from ${split.oosStart})` : `${split.method === "walk_forward" ? "Walk-forward" : "Held out"} from ${split.oosStart}`;
    const sweepNote = configs > 1 ? (r.sweep?.chosen_on === "in_sample" && split.method !== "default_30" ? " The parameters were chosen on the in-sample part only." : " The parameters were chosen with the whole period in view, so the held-out part is not truly unseen.") : "";
    const grade = gradeOf(split);
    const se = split.sharpeSE ?? null;
    const gradeText =
      grade === "fell_sharply"
        ? " The result fell sharply out of sample, by more than the Sharpe's sampling error: a common sign of a rule fitted to the past."
        : grade === "weaker"
          ? ` The result was weaker out of sample${se !== null ? ` (the out-of-sample Sharpe's sampling error is about ±${f2(se)})` : ""}.`
          : ` The result held up out of sample${se !== null ? `: the change is within the Sharpe's sampling error (about ±${f2(se)})` : ""}.`;
    checks.push({
      id: "oos",
      name: "Out of sample",
      status: grade === "fell_sharply" || (configs > 1 && r.sweep?.chosen_on !== "in_sample") ? "flag" : grade === "weaker" ? "info" : "pass",
      detail: `${where}. Sharpe ${f2(split.is.sharpe)} in sample, ${f2(split.oos.sharpe)} out of sample; CAGR ${fmtPct(split.is.cagr)} vs ${fmtPct(split.oos.cagr)} (${B} ${fmtPct(split.is.bench_cagr)} vs ${fmtPct(split.oos.bench_cagr)}).${gradeText}${sweepNote}`,
    });
    if (split.bigDrop && configs > 1) caps.push("The swept winner fell sharply on the held-out years, a sign it was fitted to the past.");
  }

  // 9. Steadiness.
  const t = active.length >= 10 ? hacT(active) : NaN;
  if (A !== null && Number.isFinite(t)) checks.push({ id: "steady", name: "Steadiness of the gain", status: t >= 2 ? "pass" : "flag", detail: `Average excess return over ${B} ${pa(A)}, t-statistic ${r2(t)} (2 or more makes luck unlikely).` });

  // 14 and 15. Hindsight list.
  const u = input.universe;
  let hindsightCap: HindsightCap | null = null;
  let comparison: DeskAudit["comparison"] = null;
  let ewActive: number | null = null;
  let survivorship: AuditCaveats["survivorship"] = null;
  const listTickers = u?.tickers ?? [];
  const listChosenToday = !!u && !u.fixedSet && listTickers.length >= 2;
  if (u && listTickers.length >= 2) {
    const ls = bars ? listStats(r, bars, listTickers) : null;
    ewActive = ls?.edgePct ?? null;
    const name = u.listName ?? `the ${listTickers.length} tickers`;
    if (ls) comparison = { strategy: ls.strategyCagr === null ? null : ls.strategyCagr / 100, list: ls.listCagr === null ? null : ls.listCagr / 100, spy: ls.spyCagr === null ? null : ls.spyCagr / 100, listName: name };
    if (listChosenToday) {
      const start = r.period.start || r.series.dates[0] || input.today;
      const yearsBack = (dayMs(input.today) - dayMs(start)) / (365.25 * 86_400_000);
      const late = bars ? lateListings(bars, listTickers, start) : [];
      const sig = hindsightSignals({ listChosenToday: true, yearsBack, tickers: listTickers.length, late, intentTell: intentSaysTodaysList(input.intent), listExcessPct: ls?.excessPct ?? null, pickedToday: u.todaysPick });
      const selective = maxConcurrent(r.trades) > 0 && maxConcurrent(r.trades) <= listTickers.length / 2;
      const built = hindsightTexts(sig, { tickers: listTickers.length, yearsBack, startYear: start.slice(0, 4), selective, listName: u.todaysPick ? u.listName : null }, ls);
      hindsightCap = built.cap;
      survivorship = { late: late.length, total: listTickers.length, listName: u.listName ?? `the ${listTickers.length} tickers` };
      checks.push({ id: "hindsight", name: "Hindsight list", status: sig.suspect ? "flag" : "pass", detail: built.plain ?? built.detail });
      checks.push({
        id: "survivorship",
        name: "Survivorship",
        status: "info",
        detail: `Only companies that still trade today are in the data. Ones that went bankrupt or were bought are missing, which usually makes results look better.${late.length ? ` ${plural(late.length, "member")} of ${listTickers.length.toLocaleString("en-US")} had no prices yet on ${start}: they joined the market later.` : ""}`,
      });
    }
    if (ls) {
      checks.push({
        id: "list_ew",
        name: "Against the list held equally",
        status: ewActive !== null && ewActive > 0 ? "pass" : "flag",
        detail: `Holding all of ${name} at equal weight made ${pa(ls.listCagr)} (CAGR) vs SPY ${pa(ls.spyCagr)}; the strategy made ${pa(ls.strategyCagr)}${ewActive !== null ? `, ${ewActive >= 0 ? "beating" : "trailing"} the list by ${Math.abs(r2(ewActive))} points a year on daily returns` : ""}.`,
      });
    } else if (listChosenToday) checks.push({ id: "list_ew", name: "Against the list held equally", status: "skipped", detail: "The list's prices could not be loaded for the comparison." });
  }

  // The label: the Strategy Lab's rules, then the Desk's caps. The deflated Sharpe is the one shown (active returns, best-of-N).
  const dsr = multiple.dsr ?? NaN;
  const lab = evidenceLabel({
    insufficient,
    insufficientText,
    t: Number.isFinite(t) ? t : 0,
    costsPass,
    delayPass,
    nullPct,
    dsr: Number.isFinite(dsr) ? dsr : 0,
    listUniverse: ewActive !== null,
    activeVsEw: ewActive,
    hindsight: hindsightCap,
  });
  let level = lab.level;
  let reasons = lab.reasons;
  if (caps.length) {
    if (level === "some" || level === "consistent") {
      level = "thin";
      reasons = caps;
    } else reasons = [...reasons, ...caps];
  }
  reasons = Array.from(new Set(reasons)).slice(0, 5);
  // A high deflated Sharpe never shows as a pass next to a weak label: the other checks decide.
  if (level === "thin" || level === "insufficient") {
    const mc = checks.find((c) => c.id === "multiple");
    if (mc && mc.status === "pass") {
      mc.status = "info";
      mc.detail += ` The evidence label is still "${EVIDENCE_TITLE[level]}" because of the other checks.`;
    }
  }

  const whole = wholeStats(r);
  return {
    version: 1,
    benchmark: B,
    ...(whole ? { whole } : {}),
    headline: headlineOf(r, whole, split, B),
    label: { level, title: EVIDENCE_TITLE[level], heading: EVIDENCE_HEADING, subtitle: EVIDENCE_SUBTITLE, reasons, source: { ...EVIDENCE_SOURCE } },
    checks,
    comparison,
    multiple,
    split,
    caveats: { survivorship, dataSource: input.dataSource ?? null },
  };
}

/** Figures as the panel prints them (the model is told to copy these strings). */
function figureLine(f: HeadlineFigures, b: string): string {
  const f2 = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
  const pct0 = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
  return `CAGR ${fmtPct(f.cagr)} vs ${b} ${fmtPct(f.bench_cagr)} (difference ${fmtPts(f.excess)} a year); Sharpe ${f2(f.sharpe)} vs ${b} ${f2(f.bench_sharpe)}; max drawdown ${fmtPct(f.max_dd)} vs ${b} ${fmtPct(f.bench_max_dd)}; closed trades ${f.trades ?? "n/a"}; exposure ${pct0(f.exposure)}`;
}

/** The numbers block of auditForModel: exactly what the panel shows. */
export function headlineForModel(h: Headline): string {
  const lines = [
    `Numbers shown in the results panel (benchmark: ${h.benchmark}). Quote these exactly as written whenever you give a figure; do not recompute, re-round or use other figures from your script's output.`,
    `- ${h.scope === "oos" ? `HEADLINE, ${h.main.label}, ${h.main.start} to ${h.main.end}` : `HEADLINE, whole test, ${h.main.start} to ${h.main.end}`}: ${figureLine(h.main, h.benchmark)}.`,
    ...h.secondary.map((s) => `- ${s.label}, ${s.start} to ${s.end}: ${figureLine(s, h.benchmark)}.`),
    `"Closed trades" means: ${TRADES_DEFINITION}`,
    `"Difference" is the strategy's CAGR minus ${h.benchmark}'s CAGR, in percentage points a year; use it whenever you say how much the strategy beat or trailed ${h.benchmark}. The checks' "average excess return" is a different measure (mean daily difference x 252); do not present it as the gap.`,
  ];
  if (h.scope === "oos") lines.push(`This strategy was selected (parameters picked on the in-sample part), so lead with the out-of-sample numbers and call them out-of-sample; give the in-sample and whole-test numbers only as secondary, labelled.`);
  return lines.join("\n");
}

/** The audit as the model sees it (tool_result of audit_run), so its summary cannot contradict the label or the panel. */
export function auditForModel(a: DeskAudit): string {
  const flagged = a.checks.filter((c) => c.status === "flag");
  const B = a.benchmark ?? "SPY";
  const lines = [
    `Falcon's independent audit of this test (computed outside your script). Benchmark: ${B}. Evidence label shown to the member: "${a.label.title}".`,
    `Why: ${a.label.reasons.join(" ")}`,
    flagged.length ? `Flags:\n${flagged.map((c) => `- ${c.name}: ${c.detail}${c.items?.length ? ` (${c.items.slice(0, 3).join("; ")})` : ""}`).join("\n")}` : "No check was flagged.",
    `Other checks: ${a.checks
      .filter((c) => c.status !== "flag")
      .map((c) => `${c.name} ${c.status === "pass" ? "passed" : c.status === "skipped" ? `skipped (${c.detail})` : `(${c.detail})`}`)
      .join("; ")}.`,
  ];
  if (a.headline) lines.push(headlineForModel(a.headline));
  if (a.split) {
    const g = gradeOf(a.split);
    lines.push(
      `In sample (to ${a.split.is.end}) vs out of sample (from ${a.split.oosStart}${a.split.method === "default_30" ? ", Falcon's default last 30%" : ""}): Sharpe ${a.split.is.sharpe?.toFixed(2) ?? "n/a"} vs ${a.split.oos.sharpe?.toFixed(2) ?? "n/a"}, CAGR ${fmtPct(a.split.is.cagr)} vs ${fmtPct(a.split.oos.cagr)}. Falcon's grade: it ${OOS_GRADE_TEXT[g]}${g === "held_up" ? " (the change is within the Sharpe's sampling error; do not call it a drop or a sign of overfitting)" : g === "fell_sharply" ? ": say so" : ""}. Report both.`,
    );
  }
  if (a.multiple && a.multiple.trials > 1)
    lines.push(
      `Versions tried: ${a.multiple.trials}${a.multiple.configs > 1 ? ` (best of ${a.multiple.configs} in this sweep)` : ""}. ${dsrPlain({ ...a.multiple, benchmark: a.multiple.benchmark ?? B })} (deflated Sharpe on the return over ${B}). It is one input to the label, not evidence on its own: never call it strong when the label is "${a.label.title}". Say "best of ${a.multiple.trials} tried" when you report the winner.`,
    );
  if (a.caveats?.survivorship) lines.push(`Survivorship: ${a.caveats.survivorship.late} of ${a.caveats.survivorship.total} members of ${a.caveats.survivorship.listName} had no prices at the start; name this caveat.`);
  if (a.comparison) lines.push(`CAGR over the test: strategy ${fmtPct(a.comparison.strategy)}, ${a.comparison.listName} held equally ${fmtPct(a.comparison.list)}, SPY ${fmtPct(a.comparison.spy)}.`);
  const rules = a.checks.find((c) => c.id === "rules");
  if (rules?.status === "info") lines.push("This event test came from a custom script written for this question (not Falcon's event-backtest helper): say so in one plain line in your answer.");
  else if (rules?.status === "pass") lines.push("The trades were checked against the declared rules and follow them: the result is Falcon's standard event backtest for these rules.");
  lines.push(
    `In your summary, name this label ("${a.label.title}") and its main reasons in plain words, and never describe the result as stronger evidence than that. Compare with ${B} (the benchmark), not SPY, unless ${B} is SPY. If the code review or the timing checks found a look-ahead, say so plainly and offer to fix the script and run it again.`,
  );
  return lines.join("\n");
}

/** One line for the model's history: the label of a past test. */
export function auditSummaryLine(a: DeskAudit): string {
  const flags = a.checks.filter((c) => c.status === "flag").map((c) => c.name);
  return `Falcon's audit: ${a.label.title}${a.label.reasons.length ? ` (${a.label.reasons[0]})` : ""}${flags.length ? `; flagged: ${flags.join(", ")}` : ""}.`;
}

/** Checks a stored or streamed audit (anything malformed is dropped). */
export function cleanAudit(v: unknown): DeskAudit | undefined {
  const o = obj(v);
  const l = obj(o.label);
  if (o.version !== 1 || typeof l.title !== "string" || !Array.isArray(o.checks)) return undefined;
  const levels: EvidenceLevel[] = ["insufficient", "thin", "some", "consistent"];
  const level = levels.includes(l.level as EvidenceLevel) ? (l.level as EvidenceLevel) : "thin";
  const str = (x: unknown, n = 600) => (typeof x === "string" ? x.slice(0, n) : "");
  const checks: AuditCheck[] = [];
  for (const c of o.checks as unknown[]) {
    const x = obj(c);
    const status = x.status === "pass" || x.status === "flag" || x.status === "info" || x.status === "skipped" ? x.status : "info";
    if (!str(x.name)) continue;
    const items = Array.isArray(x.items) ? x.items.map((i) => str(i, 400)).filter(Boolean).slice(0, 12) : [];
    checks.push({ id: str(x.id, 40), name: str(x.name, 80), status, detail: str(x.detail, 1200), ...(items.length ? { items } : {}) });
  }
  const src = obj(l.source);
  const cmp = obj(o.comparison);
  const bench = str(o.benchmark, 80);
  return {
    version: 1,
    ...(bench ? { benchmark: bench } : {}),
    label: {
      level,
      title: str(l.title, 120),
      heading: str(l.heading, 120),
      subtitle: str(l.subtitle, 600),
      reasons: Array.isArray(l.reasons) ? l.reasons.map((x) => str(x)).filter(Boolean).slice(0, 6) : [],
      source: { label: str(src.label, 120), url: /^https:\/\//.test(str(src.url)) ? str(src.url, 300) : "" },
    },
    checks: checks.slice(0, 20),
    comparison: Object.keys(cmp).length ? { strategy: num(cmp.strategy), list: num(cmp.list), spy: num(cmp.spy), listName: str(cmp.listName, 120) } : null,
    ...cleanExtras(o),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function cleanPeriod(v: unknown): PeriodStats | null {
  const p = obj(v);
  const start = typeof p.start === "string" && DAY.test(p.start) ? p.start : null;
  const end = typeof p.end === "string" && DAY.test(p.end) ? p.end : null;
  if (!start || !end) return null;
  return {
    start,
    end,
    days: num(p.days) ?? 0,
    cagr: num(p.cagr),
    sharpe: num(p.sharpe),
    max_dd: num(p.max_dd),
    total_return: num(p.total_return),
    bench_cagr: num(p.bench_cagr),
    bench_sharpe: num(p.bench_sharpe),
    bench_max_dd: num(p.bench_max_dd),
    trades: num(p.trades) ?? 0,
    win_rate: num(p.win_rate),
    exposure: num(p.exposure),
  };
}

function cleanFigures(v: unknown): HeadlinePart | null {
  const f = obj(v);
  if (typeof f.label !== "string" || (f.id !== "oos" && f.id !== "is" && f.id !== "whole")) return null;
  const d = (x: unknown) => (typeof x === "string" && DAY.test(x) ? x : "");
  return {
    id: f.id,
    label: f.label.slice(0, 80),
    start: d(f.start),
    end: d(f.end),
    cagr: num(f.cagr),
    bench_cagr: num(f.bench_cagr),
    excess: num(f.excess),
    sharpe: num(f.sharpe),
    bench_sharpe: num(f.bench_sharpe),
    max_dd: num(f.max_dd),
    bench_max_dd: num(f.bench_max_dd),
    trades: num(f.trades),
    exposure: num(f.exposure),
  };
}

/** The optional parts of a stored audit (headline, whole test, multiple testing, split, caveats). */
function cleanExtras(o: Record<string, unknown>): Pick<DeskAudit, "multiple" | "split" | "caveats" | "whole" | "headline"> {
  const out: Pick<DeskAudit, "multiple" | "split" | "caveats" | "whole" | "headline"> = {};
  const w = cleanPeriod(o.whole);
  if (w) out.whole = w;
  const h = obj(o.headline);
  const main = cleanFigures(h.main);
  if (main && (h.scope === "oos" || h.scope === "whole")) {
    out.headline = {
      scope: h.scope,
      benchmark: typeof h.benchmark === "string" && h.benchmark ? h.benchmark.slice(0, 80) : "SPY",
      main,
      secondary: (Array.isArray(h.secondary) ? h.secondary : []).map(cleanFigures).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 3),
    };
  }
  const m = obj(o.multiple);
  if (num(m.trials) !== null) {
    out.multiple = {
      trials: Math.max(1, Math.round(num(m.trials)!)),
      configs: Math.max(1, Math.round(num(m.configs) ?? 1)),
      params: typeof m.params === "string" ? m.params.slice(0, 200) : "",
      chosenOn: m.chosenOn === "in_sample" || m.chosenOn === "full_period" ? m.chosenOn : null,
      sharpe: num(m.sharpe),
      luckSharpe: num(m.luckSharpe),
      adjustedSharpe: num(m.adjustedSharpe),
      dsr: num(m.dsr),
      ...(typeof m.benchmark === "string" && m.benchmark ? { benchmark: m.benchmark.slice(0, 80) } : {}),
    };
  }
  const sp = obj(o.split);
  const is = cleanPeriod(sp.is);
  const oos = cleanPeriod(sp.oos);
  if (is && oos && typeof sp.oosStart === "string" && DAY.test(sp.oosStart)) {
    out.split = {
      oosStart: sp.oosStart,
      method: sp.method === "walk_forward" || sp.method === "holdout" ? sp.method : "default_30",
      is,
      oos,
      sharpeDrop: num(sp.sharpeDrop),
      sharpeSE: num(sp.sharpeSE),
      ...(sp.grade === "held_up" || sp.grade === "weaker" || sp.grade === "fell_sharply" ? { grade: sp.grade } : {}),
      bigDrop: sp.bigDrop === true,
    };
  }
  const c = obj(o.caveats);
  if (Object.keys(c).length) {
    const sv = obj(c.survivorship);
    out.caveats = {
      survivorship: num(sv.total) !== null ? { late: Math.max(0, Math.round(num(sv.late) ?? 0)), total: Math.round(num(sv.total)!), listName: typeof sv.listName === "string" ? sv.listName.slice(0, 120) : "" } : null,
      dataSource: typeof c.dataSource === "string" ? c.dataSource.slice(0, 300) : null,
    };
  }
  return out;
}
