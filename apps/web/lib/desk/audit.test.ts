// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/audit.test.ts
// The Desk audit's deterministic checks and its evidence label; pure, nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVIDENCE_TITLE } from "@falcon/backtest";
import {
  auditForModel,
  buildDeskAudit,
  cleanAudit,
  fillPriceCheck,
  listStats,
  maxConcurrent,
  parseHarnessOutput,
  parseReview,
  roundTrips,
  signalTimingCheck,
  type AuditInput,
  type DayBar,
  type HarnessOutput,
} from "./audit";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_CONTINUE_TEXT, AUDIT_MAX_CONTINUES, auditContinues, auditUniverse, loadsBenchmark, shouldContinue } from "./audit-run";
import { HARNESS_PY } from "./audit-harness";
import { fmtPts } from "./robustness";
import { compactRunResult, fmtPct, resultSummaryLine, validateRunResult, type RunResult, type RunTrade } from "./run-result";

/** Business days from `start`, n of them. */
function days(start: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/** A deterministic pseudo-random stream. */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

const DATES = days("2019-01-02", 252 * 6);

/** A result whose strategy beats SPY by `edge` a day on average, with `trades` round trips. */
function result(opts: { edge?: number; noise?: number; trades?: number; costs?: number | null; tradeList?: RunTrade[] } = {}): RunResult {
  const r = rand(7);
  const edge = opts.edge ?? 0.0006;
  const noise = opts.noise ?? 0.004;
  let e = 1;
  let b = 1;
  const equity: number[] = [];
  const bench: number[] = [];
  for (let i = 0; i < DATES.length; i++) {
    if (i) {
      const m = r() * 0.02;
      b *= 1 + m + 0.0003;
      e *= 1 + m + 0.0003 + edge + r() * noise;
    }
    equity.push(e);
    bench.push(b);
  }
  const n = opts.trades ?? 200;
  const trades: RunTrade[] =
    opts.tradeList ??
    Array.from({ length: n }, (_, k) => [
      { date: DATES[10 + k * 5]!, ticker: "AAA", side: "buy" as const, qty: 1, weight: 0.33, price: 100, pnl: null, signal_date: DATES[9 + k * 5]! },
      { date: DATES[12 + k * 5]!, ticker: "AAA", side: "sell" as const, qty: 1, weight: 0.33, price: 101, pnl: 0.01 },
    ]).flat();
  return {
    name: "Test",
    period: { start: DATES[0]!, end: DATES[DATES.length - 1]! },
    universe: "test",
    assumptions: { costs_bps: opts.costs === undefined ? 5 : opts.costs, rebalance: "weekly", signal_lag: "1 day", notes: [] },
    metrics: { cagr: null, vol: null, sharpe: null, max_dd: null, total_return: null, trades: trades.length, win_rate: null, turnover: null, benchmark: { cagr: null, sharpe: null, max_dd: null, total_return: null } },
    series: { dates: DATES, equity, benchmark_equity: bench, drawdown: equity.map(() => 0) },
    trades,
    trade_count: trades.length,
    warnings: [],
    code: "",
  };
}

/** Re-runs that keep most of the gain, and placebos well below it. */
function goodHarness(active: number): HarnessOutput {
  return {
    error: null,
    defaults: { costs_bps: 5, lag_days: 1 },
    params: ["costs_bps", "lag_days", "seed", "random_picks"],
    costs_x2: { cagr: 0.1, active_pct: active * 0.9, total_return: 1, trades: 200, costs_bps: 10 },
    lag_plus1: { cagr: 0.1, active_pct: active * 0.8, total_return: 1, trades: 200, lag_days: 2 },
    base: { cagr: 0.1, active_pct: active, total_return: 1, trades: 200 },
    reported: null,
    placebo: Array.from({ length: 20 }, (_, i) => ({ seed: i + 1, active_pct: -2 + i * 0.1 })),
    placebo_wanted: 20,
    errors: [],
    elapsed_s: 10,
    complete: true,
    pending: [],
    hops: 1,
    ran: 23,
    job_s: 0.1,
  };
}

const base = (over: Partial<AuditInput>): AuditInput => ({
  result: result(),
  review: { ok: true, issues: [] },
  harness: null,
  bars: null,
  universe: null,
  intent: "test this rule",
  trials: 1,
  today: "2026-11-16",
  ...over,
});

/** The reported gain over SPY, as the audit computes it. */
function activeOf(r: RunResult): number {
  const s = r.series;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < s.dates.length; i++) {
    sum += s.equity[i]! / s.equity[i - 1]! - 1 - (s.benchmark_equity[i]! / s.benchmark_equity[i - 1]! - 1);
    n++;
  }
  return (sum / n) * 252 * 100;
}

test("fillPriceCheck: prices outside the day's low..high are flagged, rounding tolerated", () => {
  const bars = new Map<string, DayBar[]>([["BRK-B", [{ date: "2024-01-02", open: 100, high: 105, low: 99, close: 104 }]]]);
  const t = (price: number): RunTrade => ({ date: "2024-01-02", ticker: "BRK.B", side: "buy", qty: 1, weight: null, price, pnl: null });
  assert.equal(fillPriceCheck([t(104), t(105.1), t(98.9)], bars).outside.length, 0);
  const bad = fillPriceCheck([t(110), t(90), t(100)], bars);
  assert.equal(bad.checked, 3);
  assert.equal(bad.outside.length, 2);
  assert.match(bad.outside[0]!, /BRK\.B at 110\.00/);
  // A trade on a day without a bar is counted, not judged.
  assert.equal(fillPriceCheck([{ ...t(100), date: "2024-01-03" }], bars).noBar, 1);
});

test("signalTimingCheck: entries before or on their signal day are flagged", () => {
  const bars = new Map<string, DayBar[]>([["AAA", [{ date: "2024-01-02", open: 100, high: 105, low: 99, close: 104 }]]]);
  const buy = (date: string, signal: string, price = 100): RunTrade => ({ date, ticker: "AAA", side: "buy", qty: 1, weight: null, price, pnl: null, signal_date: signal });
  const ok = signalTimingCheck([buy("2024-01-03", "2024-01-02")], bars);
  assert.deepEqual([ok.checked, ok.before.length, ok.sameDay.length], [1, 0, 0]);
  const early = signalTimingCheck([buy("2024-01-01", "2024-01-02")], bars);
  assert.equal(early.before.length, 1);
  const sameClose = signalTimingCheck([buy("2024-01-02", "2024-01-02", 104)], bars);
  assert.match(sameClose.sameDay[0]!, /at that day's close/);
  const sameOpen = signalTimingCheck([buy("2024-01-02", "2024-01-02", 100)], bars);
  assert.match(sameOpen.sameDay[0]!, /open, before the close/);
  // Sells and buys without a signal date are not judged.
  assert.equal(signalTimingCheck([{ ...buy("2024-01-02", "2024-01-02"), signal_date: undefined }], bars).checked, 0);
});

test("roundTrips and maxConcurrent", () => {
  const r = result({ trades: 40 });
  assert.equal(roundTrips(r), 40);
  assert.equal(roundTrips({ ...r, trades: r.trades.slice(0, 10), trade_count: 400 }), 200);
  const tr = (date: string, ticker: string, side: "buy" | "sell"): RunTrade => ({ date, ticker, side, qty: null, weight: null, price: null, pnl: null });
  assert.equal(maxConcurrent([tr("2024-01-01", "A", "buy"), tr("2024-01-01", "B", "buy"), tr("2024-01-02", "A", "sell"), tr("2024-01-02", "C", "buy"), tr("2024-01-03", "D", "buy")]), 3);
});

test("label: re-runs that hold up, a clean review and costs give Some or Strong evidence", () => {
  const r = result();
  const A = activeOf(r);
  const a = buildDeskAudit(base({ result: r, harness: goodHarness(A) }));
  assert.ok(a.label.level === "some" || a.label.level === "consistent", a.label.level);
  assert.equal(a.label.title, EVIDENCE_TITLE[a.label.level]);
  assert.equal(a.checks.find((c) => c.id === "costs_x2")?.status, "pass");
  assert.equal(a.checks.find((c) => c.id === "delay")?.status, "pass");
  assert.equal(a.checks.find((c) => c.id === "placebo")?.status, "pass");
  assert.equal(a.checks.find((c) => c.id === "repro")?.status, "pass");
  assert.ok(a.label.source.url.startsWith("https://"));
});

test("label: failed robustness re-runs give Weak evidence with the Strategy Lab's reasons", () => {
  const r = result();
  const A = activeOf(r);
  const h = goodHarness(A);
  const a = buildDeskAudit(base({ result: r, harness: { ...h, costs_x2: { ...h.costs_x2!, active_pct: -1 }, lag_plus1: { ...h.lag_plus1!, active_pct: A * 0.2 }, placebo: h.placebo.map((p) => ({ ...p, active_pct: A + 1 })) } }));
  assert.equal(a.label.level, "thin");
  assert.ok(a.label.reasons.includes("With trading costs doubled, the gain disappears."));
  assert.ok(a.label.reasons.some((x) => x.startsWith("Acting one day later")));
  assert.ok(a.label.reasons.includes("Random versions of the same strategy often did as well."));
});

test("label: Desk caps (no re-runs, look-ahead, no costs, impossible fills) keep it at Weak evidence", () => {
  const r = result();
  const A = activeOf(r);
  const noRerun = buildDeskAudit(base({ result: r, harness: null, harnessError: "The script has no run() function." }));
  assert.equal(noRerun.label.level, "thin");
  assert.match(noRerun.label.reasons.join(" "), /could not be re-run/);
  assert.equal(noRerun.checks.find((c) => c.id === "costs_x2")?.status, "skipped");

  const look = buildDeskAudit(base({ result: r, harness: goodHarness(A), review: { ok: true, issues: [{ line: 42, severity: "high", kind: "same-bar fill", issue: "Buys at the close used to rank." }] } }));
  assert.equal(look.label.level, "thin");
  assert.match(look.label.reasons[0]!, /look-ahead \(line 42\)/);
  assert.equal(look.checks.find((c) => c.id === "review")?.status, "flag");

  const free = buildDeskAudit(base({ result: result({ costs: 0 }), harness: goodHarness(A) }));
  assert.equal(free.label.level, "thin");
  assert.equal(free.checks.find((c) => c.id === "costs")?.status, "flag");

  const bars = new Map<string, DayBar[]>([["AAA", DATES.map((d) => ({ date: d, open: 50, high: 51, low: 49, close: 50 }))]]);
  const fills = buildDeskAudit(base({ result: r, harness: goodHarness(A), bars }));
  assert.equal(fills.label.level, "thin");
  assert.equal(fills.checks.find((c) => c.id === "fills")?.status, "flag");
});

test("the harness's measure of the full result file wins over a cut curve", () => {
  const r = result();
  const h = { ...goodHarness(40), reported: { cagr: 0.3, active_pct: 40, total_return: 5, trades: 200 } };
  const a = buildDeskAudit(base({ result: r, harness: h }));
  assert.match(a.checks.find((c) => c.id === "costs_x2")!.detail, /against \+40\.0% a year as tested/);
  assert.equal(a.checks.find((c) => c.id === "repro")?.status, "pass");
  // run() disagreeing with the reported file is flagged and caps the label.
  const off = buildDeskAudit(base({ result: r, harness: { ...h, base: { cagr: 0.1, active_pct: 5, total_return: 1, trades: 200 } } }));
  assert.equal(off.checks.find((c) => c.id === "repro")?.status, "flag");
  assert.equal(off.label.level, "thin");
});

test("label: too few trades or too short is Not enough trades to judge", () => {
  const few = buildDeskAudit(base({ result: result({ trades: 12 }), harness: goodHarness(5) }));
  assert.equal(few.label.level, "insufficient");
  assert.equal(few.label.title, "Not enough trades to judge");
  assert.match(few.label.reasons[0]!, /Only 12 trades in 5\.8 years/);
});

test("hindsight: a today's list caps the label and compares strategy, list and SPY", () => {
  const r = result();
  const A = activeOf(r);
  // A list that beat SPY by a lot: the winners' list.
  const spy: DayBar[] = [];
  const up: DayBar[] = [];
  const flat: DayBar[] = [];
  let s = 100;
  let u = 100;
  DATES.forEach((d, i) => {
    if (i) {
      s *= 1.0003;
      u *= 1.0012;
    }
    spy.push({ date: d, open: s, high: s, low: s, close: s });
    up.push({ date: d, open: u, high: u, low: u, close: u });
    flat.push({ date: d, open: 100, high: 100, low: 100, close: 100 });
  });
  const bars = new Map<string, DayBar[]>([
    ["SPY", spy],
    ["AAA", up],
    ["BBB", up],
    ["CCC", flat],
    ["DDD", up.slice(300)],
  ]);
  const ls = listStats(r, bars, ["AAA", "BBB", "CCC", "DDD"]);
  assert.ok(ls && ls.listCagr! > ls.spyCagr!);
  const universe = { tickers: ["AAA", "BBB", "CCC", "DDD"], listName: "S&P 500 members as of 2026-11-01", todaysPick: true, fixedSet: false };
  // Trades priced inside the bars so only hindsight matters here.
  const priced = { ...r, trades: r.trades.map((t) => ({ ...t, price: null })) };
  const a = buildDeskAudit(base({ result: priced, harness: goodHarness(A), bars, universe }));
  assert.ok(a.label.level === "some" || a.label.level === "thin", a.label.level);
  assert.equal(a.checks.find((c) => c.id === "hindsight")?.status, "flag");
  assert.match(a.checks.find((c) => c.id === "hindsight")!.detail, /were chosen today/);
  assert.ok(a.comparison && a.comparison.list! > a.comparison.spy!);
  assert.match(a.label.reasons.join(" "), /hindsight/);
  // Not a list: a single ticker has no hindsight check.
  const single = buildDeskAudit(base({ result: priced, harness: goodHarness(A), bars, universe: { tickers: [], listName: null, todaysPick: false, fixedSet: false } }));
  assert.equal(single.checks.find((c) => c.id === "hindsight"), undefined);
});

test("auditUniverse: named lists, typed tickers, SPY as the benchmark only", () => {
  const load = (o: Partial<Parameters<typeof auditUniverse>[0][number]>) => ({ tickers: ["SPY"], universe: null, universeLabel: null, todaysPick: false, start: "2016-01-04", end: "2026-11-13", from: "2015-01-01", fields: ["open", "close"] as ("open" | "close")[], benchmark: "SPY", typedSpy: false, ...o });
  assert.deepEqual(auditUniverse([load({ tickers: ["SPY"], typedSpy: true })])?.tickers, []);
  const sp = auditUniverse([load({ tickers: ["AAPL", "MSFT", "SPY"], universe: "sp500_today", universeLabel: "S&P 500 members as of 2026-11-01", todaysPick: true })])!;
  assert.deepEqual(sp.tickers, ["AAPL", "MSFT"]);
  assert.equal(sp.todaysPick, true);
  assert.equal(auditUniverse([load({ tickers: ["XLK", "XLF", "SPY"], universe: "sector_etfs", universeLabel: "sector ETFs" })])!.fixedSet, true);
  assert.deepEqual(auditUniverse([load({ tickers: ["SPY", "QQQ", "TLT"], typedSpy: true })])!.tickers, ["SPY", "QQQ", "TLT"]);
});

test("parseReview and parseHarnessOutput are lenient", () => {
  const r = parseReview('Here:\n```json\n{"issues":[{"line":"12","severity":"high","kind":"shift","issue":"Uses close[t] to trade at close[t]."},{"line":999,"issue":"x"},{"severity":"low"}]}\n```', 50);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.issues.length, 2);
    assert.equal(r.issues[0]!.line, 12);
    assert.equal(r.issues[1]!.line, null);
    assert.equal(r.issues[1]!.severity, "medium");
  }
  assert.equal(parseReview("no json").ok, false);
  const h = parseHarnessOutput({ variants: { costs_x2: { active_pct: "1.5", costs_bps: 10 }, lag_plus1: { error: "boom" } }, placebo: [{ seed: 1, active_pct: 0.2 }, { seed: 2, active_pct: null }], placebo_wanted: 20 });
  assert.equal(h.costs_x2?.active_pct, 1.5);
  assert.equal(h.lag_plus1, null);
  assert.equal(h.placebo.length, 1);
});

test("the model sees the label, and the stored audit survives cleanAudit", () => {
  const r = result();
  const a = buildDeskAudit(base({ result: r, harness: null, harnessError: "x" }));
  const text = auditForModel(a);
  assert.match(text, new RegExp(`"${a.label.title}"`));
  assert.match(text, /never describe the result as stronger evidence/);
  const back = cleanAudit(JSON.parse(JSON.stringify(a)));
  assert.deepEqual(back, JSON.parse(JSON.stringify(a)));
  assert.equal(cleanAudit({ version: 2 }), undefined);
});

/* ------------------------------------------------------------------ panel fixes (bugs 1, 2, 5) */

test("bug 1: the benchmark the test names is used in every label; SPY only by default", () => {
  const r = { ...result(), benchmark: "Equal weight of the 23 funds" };
  const a = buildDeskAudit(base({ result: r, harness: goodHarness(activeOf(r)) }));
  assert.equal(a.benchmark, "Equal weight of the 23 funds");
  assert.equal(a.headline?.benchmark, "Equal weight of the 23 funds");
  assert.equal(a.multiple?.benchmark, "Equal weight of the 23 funds");
  for (const c of a.checks) assert.doesNotMatch(c.detail, /SPY/, `${c.id}: ${c.detail}`);
  const text = auditForModel(a);
  assert.match(text, /Benchmark: Equal weight of the 23 funds/);
  assert.doesNotMatch(text, /over SPY|vs SPY/);
  assert.match(resultSummaryLine(r), /benchmark Equal weight of the 23 funds: CAGR/);
  // No name in the result: the load_prices benchmark, else SPY.
  const hinted = buildDeskAudit(base({ result: result(), benchmarkHint: "AGG" }));
  assert.equal(hinted.benchmark, "AGG");
  assert.equal(buildDeskAudit(base({ result: result() })).benchmark, "SPY");
  // validateRunResult reads it (string or object), keeps "" when absent.
  const v = validateRunResult({ ...result(), benchmark: { ticker: "AGG" } });
  assert.ok(v.ok && v.result.benchmark === "AGG");
  const none = validateRunResult({ ...result(), benchmark: undefined });
  assert.ok(none.ok && none.result.benchmark === "");
  // The benchmark ticker is not part of the traded list.
  const load = { tickers: ["XLK", "XLF", "AGG", "SPY"], universe: null, universeLabel: null, todaysPick: false, start: "2016-01-04", end: "2026-11-13", from: "2015-01-01", fields: ["close"] as "close"[], benchmark: "AGG", typedSpy: false, typed: ["XLK", "XLF"] };
  assert.deepEqual(auditUniverse([load])!.tickers, ["XLK", "XLF"]);
  assert.equal(loadsBenchmark([load]), "AGG");
  assert.equal(loadsBenchmark([{ ...load, benchmark: "SPY" }]), null);
});

test("bug 2: trades are closed round trips everywhere, and the model gets the panel's exact numbers", () => {
  const r0 = result({ trades: 33 });
  // The script counted entries and exits (66 + 1 still open = 67).
  const raw = { ...r0, metrics: { ...r0.metrics, trades: 67 }, trades: [...r0.trades, { date: DATES[400]!, ticker: "BBB", side: "buy", qty: 1, weight: 0.3, price: 50, pnl: null }] };
  const v = validateRunResult(JSON.parse(JSON.stringify(raw)));
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.result.metrics.trades, 33);
  assert.equal(v.result.closed_trades, 33);
  // The stored (cut) copy keeps the count.
  const stored = validateRunResult(JSON.parse(JSON.stringify(compactRunResult(v.result, 400, 10).result)));
  assert.ok(stored.ok && stored.result.metrics.trades === 33 && stored.result.trades.length === 10);
  const a = buildDeskAudit(base({ result: v.result, harness: goodHarness(activeOf(v.result)) }));
  const w = a.headline!.main;
  assert.equal(a.headline!.scope, "whole");
  assert.equal(w.trades, 33);
  assert.equal(a.checks.find((c) => c.id === "sample")!.detail.startsWith("33 closed trades"), true);
  // The model's text carries the exact strings the panel prints (fmtPct / fmtPts / 2-decimal Sharpe).
  const text = auditForModel(a);
  assert.ok(text.includes(`CAGR ${fmtPct(w.cagr)} vs SPY ${fmtPct(w.bench_cagr)} (difference ${fmtPts(w.excess)} a year)`), text);
  assert.ok(text.includes(`Sharpe ${w.sharpe!.toFixed(2)}`));
  assert.ok(text.includes("closed trades 33"));
  assert.match(text, /Quote these exactly as written/);
  assert.match(text, /Closed round trips/);
  // And survives storage.
  assert.deepEqual(cleanAudit(JSON.parse(JSON.stringify(a)))!.headline, JSON.parse(JSON.stringify(a.headline)));
});

test("bug 5: the deflated Sharpe is measured against the benchmark, and never looks strong next to a weak label", () => {
  // Buy-and-hold plus noise: a positive raw Sharpe, no edge over the benchmark.
  const rnd = rand(11);
  const r0 = result({ edge: 0 });
  const equity = r0.series.benchmark_equity.map((b, i) => (b as number) * (1 + (i ? rnd() * 0.0004 : 0)));
  const r = { ...r0, series: { ...r0.series, equity }, sweep: { configs_tried: 90, params: "a x b", chosen_on: "in_sample" as const, sharpes: [] } };
  const a = buildDeskAudit(base({ result: r }));
  assert.ok(a.multiple!.dsr! < 0.8, `dsr ${a.multiple!.dsr}`);
  assert.match(a.checks.find((c) => c.id === "multiple")!.detail, /Chance it truly beats SPY after 90 tries: \d+%/);
  // A strong edge but a weak label (no trading costs): the check is not shown as passed.
  const strong = result({ edge: 0.002, costs: 0 });
  const b2 = buildDeskAudit(base({ result: strong, trials: 3, harness: goodHarness(activeOf(strong)) }));
  assert.equal(b2.label.level, "thin");
  assert.ok(b2.multiple!.dsr! >= 0.95);
  const mc = b2.checks.find((c) => c.id === "multiple")!;
  assert.notEqual(mc.status, "pass");
  assert.match(mc.detail, /evidence label is still "Weak evidence"/);
  assert.match(auditForModel(b2), /never call it strong when the label is "Weak evidence"/);
});

/* ------------------------------------------------------------------ incomplete re-runs (the random comparison timing out) */

const LEVEL_RANK = { insufficient: 0, thin: 1, some: 2, consistent: 3 } as const;

/** The harness as it reads when only `done` random versions finished and the rest were still pending. */
function partialHarness(active: number, done: number, extra: Partial<HarnessOutput> = {}): HarnessOutput {
  const h = goodHarness(active);
  return { ...h, placebo: h.placebo.slice(0, done), complete: false, pending: [...Array.from({ length: 20 - done }, (_, i) => `placebo:${done + i + 1}`), "base"], base: null, ...extra };
}

test("incomplete random comparison: says k of 20, is flagged, and caps the label (never a silent skip)", () => {
  const r = result();
  const A = activeOf(r);
  const full = buildDeskAudit(base({ result: r, harness: goodHarness(A) }));
  assert.ok(full.label.level === "some" || full.label.level === "consistent");
  assert.match(full.checks.find((c) => c.id === "placebo")!.detail, /All 20 random versions finished/);

  const six = buildDeskAudit(base({ result: r, harness: partialHarness(A, 6) }));
  const pc = six.checks.find((c) => c.id === "placebo")!;
  assert.equal(pc.status, "flag");
  assert.match(pc.detail, /^Random comparison incomplete: 6 of 20 random versions finished in time/);
  assert.match(pc.detail, /does not count as passed/);
  assert.equal(six.label.level, "thin");
  assert.match(six.label.reasons.join(" "), /random comparison is incomplete \(6 of 20 random versions finished\)/);
  assert.match(auditForModel(six), /Random comparison incomplete: 6 of 20/);

  // Enough to compare (10+), still said to be partial.
  const fifteen = buildDeskAudit(base({ result: r, harness: partialHarness(A, 15) }));
  assert.match(fifteen.checks.find((c) => c.id === "placebo")!.detail, /Random comparison incomplete: 15 of 20 random versions finished in time\./);

  // No random_picks in run(): skipped with the reason, and the label is capped too.
  const none = buildDeskAudit(base({ result: r, harness: { ...goodHarness(A), params: ["costs_bps", "lag_days"], placebo: [], placebo_wanted: 0 } }));
  assert.equal(none.checks.find((c) => c.id === "placebo")!.status, "skipped");
  assert.match(none.checks.find((c) => c.id === "placebo")!.detail, /no random_picks setting/);
  assert.equal(none.label.level, "thin");
});

test("incomplete doubled-costs or delay re-runs say they did not finish, and cap the label", () => {
  const r = result();
  const A = activeOf(r);
  const h = { ...goodHarness(A), costs_x2: null, complete: false, pending: ["costs_x2"], job_s: 9.5 };
  const a = buildDeskAudit(base({ result: r, harness: h }));
  const c = a.checks.find((x) => x.id === "costs_x2")!;
  assert.equal(c.status, "skipped");
  assert.match(c.detail, /did not finish in time \(about 9\.5 s a run\), so this check is incomplete/);
  assert.equal(a.label.level, "thin");
  assert.match(a.label.reasons.join(" "), /did not finish in time/);
});

test("the label never improves when a re-run check is incomplete", () => {
  const r = result();
  const A = activeOf(r);
  const good = goodHarness(A);
  const bad = { ...good, placebo: good.placebo.map((p) => ({ ...p, active_pct: A + 1 })) };
  for (const complete of [good, bad]) {
    const ref = LEVEL_RANK[buildDeskAudit(base({ result: r, harness: complete })).label.level];
    const variants: HarnessOutput[] = [
      ...[0, 1, 6, 9].map((k) => ({ ...complete, placebo: complete.placebo.slice(0, k), complete: false, pending: Array.from({ length: 20 - k }, (_, i) => `placebo:${k + i + 1}`) })),
      { ...complete, costs_x2: null, complete: false, pending: ["costs_x2"] },
      { ...complete, lag_plus1: null, complete: false, pending: ["lag_plus1"] },
      { ...complete, costs_x2: null, lag_plus1: null, placebo: [], complete: false, pending: ["costs_x2", "lag_plus1", "placebo:1"] },
    ];
    for (const v of variants) {
      const lvl = LEVEL_RANK[buildDeskAudit(base({ result: r, harness: v })).label.level];
      assert.ok(lvl <= ref, `incomplete ${JSON.stringify(v.pending.slice(0, 3))} gave ${lvl} > ${ref}`);
      assert.ok(lvl <= LEVEL_RANK.thin, "an incomplete re-run keeps the label at Weak evidence at best");
    }
  }
});

test("shouldContinue: re-runs carry on while pending and making progress, at most AUDIT_MAX_CONTINUES times", () => {
  const r = result();
  const h = partialHarness(activeOf(r), 8, { ran: 10 });
  assert.equal(shouldContinue({ harness: h, error: null, continues: 0, canContinue: true }), true);
  assert.equal(shouldContinue({ harness: h, error: null, continues: AUDIT_MAX_CONTINUES, canContinue: true }), false);
  assert.equal(shouldContinue({ harness: h, error: null, continues: 0, canContinue: false }), false, "no resume left: settle with what finished");
  assert.equal(shouldContinue({ harness: { ...h, ran: 0 }, error: null, continues: 1, canContinue: true }), false, "no progress: a version longer than a request");
  assert.equal(shouldContinue({ harness: { ...h, ran: 0 }, error: null, continues: 0, canContinue: true }), true, "the first continue is always tried");
  assert.equal(shouldContinue({ harness: { ...h, complete: true, pending: [] }, error: null, continues: 0, canContinue: true }), false);
  assert.equal(shouldContinue({ harness: { ...h, complete: null }, error: null, continues: 0, canContinue: true }), false, "an older harness never continues");
  assert.equal(shouldContinue({ harness: null, error: "The re-runs ran out of time.", continues: 0, canContinue: true }), true);
  assert.equal(shouldContinue({ harness: null, error: "The re-runs ran out of time.", continues: 1, canContinue: true }), false);
  // The count of continues comes from the reply's own tool results.
  const tail = [0, 1].map(() => ({ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "x", content: JSON.stringify({ status: "continuing", note: AUDIT_CONTINUE_TEXT }) }] }));
  assert.equal(auditContinues(tail), 2);
  assert.equal(auditContinues([]), 0);
});

/* ------------------------------------------------------------------ the Python harness itself (needs python3) */

const PY = spawnSync("python3", ["--version"]).status === 0;

/** A tiny strategy: seeded picks, `sleep` seconds a run (pure Python, no numpy). */
const TOY = (sleep: number) => `import json, os, random, time
import datetime as dt
DATES = [str(dt.date(2020, 1, 1) + dt.timedelta(days=i)) for i in range(300)]

def run(costs_bps=5.0, lag_days=1, seed=None, random_picks=False):
    time.sleep(${sleep})
    rng = random.Random(seed if random_picks else 12345)
    eq, be, e, b = [], [], 1.0, 1.0
    for i in range(len(DATES)):
        e *= 1 + rng.uniform(-0.01, 0.0112) - costs_bps / 1e5 - 0.0001 * (lag_days - 1)
        b *= 1.0003
        eq.append(e)
        be.append(b)
    return {"series": {"dates": DATES, "equity": eq, "benchmark_equity": be}, "trades": []}

if __name__ == "__main__":
    r = run()
    json.dump(r, open("falcon_result.json", "w"))
`;

function harnessRun(dir: string, budget: number) {
  const p = spawnSync("python3", [join(dir, "falcon_audit.py"), "--script", "toy.py", "--budget", String(budget), "--placebos", "20"], {
    cwd: dir,
    env: { ...process.env, OUTPUT_DIR: join(dir, "out"), TMPDIR: join(dir, "tmp") },
    encoding: "utf8",
  });
  assert.equal(p.status, 0, p.stderr);
  return parseHarnessOutput(JSON.parse(readFileSync(join(dir, "out", "falcon_audit.json"), "utf8")));
}

function toyDir(sleep: number): string {
  const dir = mkdtempSync(join(tmpdir(), "falcon-harness-"));
  for (const d of ["out", "tmp"]) spawnSync("mkdir", ["-p", join(dir, d)]);
  writeFileSync(join(dir, "falcon_audit.py"), HARNESS_PY);
  writeFileSync(join(dir, "toy.py"), TOY(sleep));
  spawnSync("python3", ["toy.py"], { cwd: dir });
  return dir;
}

test("harness: all 20 random versions with fixed seeds 1..20, the same numbers every time", { skip: !PY && "python3 not installed" }, () => {
  const a = harnessRun(toyDir(0), 20);
  const b = harnessRun(toyDir(0), 20);
  assert.equal(a.complete, true);
  assert.deepEqual(a.pending, []);
  assert.deepEqual(a.placebo.map((p) => p.seed), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(a.placebo, b.placebo, "a fresh sandbox gives the same random versions");
  assert.ok(a.costs_x2 && a.lag_plus1 && a.base);
  assert.equal(new Set(a.placebo.map((p) => p.active_pct.toFixed(6))).size, 20, "each seed is its own version");
});

test("harness: a slow script continues across calls, keeps every finished version and ends identical", { skip: !PY && "python3 not installed" }, () => {
  // Up to 4 workers here (1 in the real sandbox): 0.8 s a version cannot fit 23 versions in 2.5 s either way.
  const dir = toyDir(0.8);
  const first = harnessRun(dir, 2.5);
  assert.equal(first.complete, false);
  assert.ok(first.placebo.length < 20 && first.pending.length > 0, JSON.stringify(first.pending));
  assert.ok(first.costs_x2 && first.lag_plus1, "the two label re-runs go first");
  assert.ok((first.elapsed_s ?? 99) < 3, "it stops before the budget instead of cutting a version off");
  const seen = new Map(first.placebo.map((p) => [p.seed, p.active_pct]));
  let last = first;
  for (let hop = 0; hop < 12 && last.complete === false; hop++) {
    const next = harnessRun(dir, 2.5);
    assert.ok(next.placebo.length >= last.placebo.length, "never loses finished versions");
    for (const p of next.placebo) if (seen.has(p.seed)) assert.equal(p.active_pct, seen.get(p.seed));
    last = next;
  }
  assert.equal(last.complete, true);
  assert.equal(last.placebo.length, 20);
  assert.ok((last.hops ?? 0) >= 2);
  // The same 20 numbers as one uninterrupted run.
  assert.deepEqual(last.placebo, harnessRun(toyDir(0), 20).placebo);
  // A call after it is complete answers from the saved state.
  const again = harnessRun(dir, 2.5);
  assert.equal(again.ran, 0);
  assert.deepEqual(again.placebo, last.placebo);
});
