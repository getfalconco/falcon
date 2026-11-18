// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/robustness.test.ts
// The multiple-testing correction and the in-sample / out-of-sample split; pure, known inputs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeskAudit, cleanAudit } from "./audit";
import { annualSharpe, exposureOf, expectedMaxSharpe, headlineOf, multipleTesting, oosGrade, sharpeSE, splitStats, wholeOf, wholeStats } from "./robustness";
import { validateRunResult, type RunResult, type RunTrade } from "./run-result";

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

/** Daily returns alternating mu +/- spread: Sharpe = mu / spread * sqrt(252) (sample sd, n even, close to it). */
function alt(n: number, mu: number, spread: number): number[] {
  return Array.from({ length: n }, (_, i) => mu + (i % 2 ? -spread : spread));
}

function curve(returns: number[]): number[] {
  const eq = [1];
  for (const x of returns) eq.push(eq[eq.length - 1]! * (1 + x));
  return eq;
}

function result(equity: number[], extra: Partial<RunResult> = {}, trades: RunTrade[] = []): RunResult {
  const dates = days("2018-01-02", equity.length);
  return {
    name: "T",
    period: { start: dates[0]!, end: dates[dates.length - 1]! },
    universe: "SPY",
    assumptions: { costs_bps: 5, rebalance: "daily", signal_lag: "1 day", notes: [] },
    metrics: { cagr: null, vol: null, sharpe: null, max_dd: null, total_return: null, trades: trades.length, win_rate: null, turnover: null, benchmark: { cagr: null, sharpe: null, max_dd: null, total_return: null } },
    series: { dates, equity, benchmark_equity: curve(alt(equity.length - 1, 0.0003, 0.01)), drawdown: equity.map(() => 0) },
    trades,
    trade_count: trades.length,
    warnings: [],
    code: "",
    ...extra,
  };
}

test("expectedMaxSharpe: luck's best Sharpe of N tries matches Bailey & Lopez de Prado (sd 1)", () => {
  assert.equal(expectedMaxSharpe(1, 1 / 252), 0);
  assert.ok(Math.abs(expectedMaxSharpe(10, 1 / 252) - 1.575) < 0.005);
  assert.ok(Math.abs(expectedMaxSharpe(100, 1 / 252) - 2.531) < 0.005);
  assert.ok(Math.abs(expectedMaxSharpe(1000, 1 / 252) - 3.255) < 0.005);
});

test("annualSharpe: mean / sd x sqrt(252)", () => {
  const xs = alt(500, 0.001, 0.01);
  const s = annualSharpe(xs)!;
  // sample sd of +/-0.01 over 500 points is 0.01 * sqrt(500/499)
  assert.ok(Math.abs(s - (0.001 / (0.01 * Math.sqrt(500 / 499))) * Math.sqrt(252)) < 1e-9);
  assert.equal(annualSharpe(alt(10, 0.001, 0.01)), null);
});

test("multipleTesting: more versions tried lowers the deflated Sharpe and raises luck's bar", () => {
  const xs = alt(756, 0.0006, 0.01); // Sharpe about 0.95 over 3 years
  const one = multipleTesting(xs, { trials: 1 });
  const many = multipleTesting(xs, { trials: 50, configs: 50 });
  assert.equal(one.luckSharpe, 0);
  assert.ok(one.dsr! > 0.9);
  assert.ok(many.luckSharpe! > 0.5);
  assert.ok(many.dsr! < one.dsr!);
  assert.ok(Math.abs(many.adjustedSharpe! - (many.sharpe! - many.luckSharpe!)) < 1e-12);
  // The sweep's own spread sets the bar: a wide spread of Sharpes means a higher bar.
  const narrow = multipleTesting(xs, { trials: 50, configs: 50, sweepSharpes: Array.from({ length: 50 }, (_, i) => 0.5 + i * 0.002) });
  const wide = multipleTesting(xs, { trials: 50, configs: 50, sweepSharpes: Array.from({ length: 50 }, (_, i) => -0.5 + i * 0.03) });
  assert.ok(wide.luckSharpe! > narrow.luckSharpe!);
  assert.ok(wide.dsr! < narrow.dsr!);
});

test("splitStats: default holds out the last 30% and flags a big drop", () => {
  const rets = [...alt(210, 0.002, 0.005), ...alt(90, -0.0005, 0.005)];
  const r = result(curve(rets));
  const s = splitStats(r)!;
  assert.equal(s.method, "default_30");
  assert.equal(s.oosStart, r.series.dates[Math.round(301 * 0.7)]);
  assert.ok(s.is.sharpe! > 5);
  assert.ok(s.oos.sharpe! < 0);
  assert.ok(s.bigDrop);
  assert.equal(s.is.days + s.oos.days, 300);
  // Given a split, it is used.
  const given = splitStats({ ...r, split: { oos_start: r.series.dates[200]!, method: "holdout" } })!;
  assert.equal(given.oosStart, r.series.dates[200]);
  assert.equal(given.method, "holdout");
  // A steady curve does not drop.
  assert.equal(splitStats(result(curve(alt(300, 0.001, 0.005))))!.bigDrop, false);
  // Too short: nothing.
  assert.equal(splitStats(result(curve(alt(100, 0.001, 0.005)))), null);
});

test("exposureOf: days with a position open", () => {
  const d = days("2020-01-01", 10);
  const t: RunTrade[] = [
    { date: d[2]!, ticker: "A", side: "buy", qty: 1, weight: 1, price: 1, pnl: null },
    { date: d[5]!, ticker: "A", side: "sell", qty: 1, weight: 1, price: 1, pnl: 0.1 },
  ];
  assert.equal(exposureOf(t, d), 0.3);
  assert.equal(exposureOf([], d), null);
});

test("validateRunResult reads sweep and split; the audit shows Best of N and caps a weak sweep winner", () => {
  const rets = [...alt(900, 0.0004, 0.01), ...alt(400, 0.0001, 0.01)];
  const base = result(curve(rets));
  const v = validateRunResult({ ...base, sweep: { configs_tried: "48", params: "fast 20-100 x slow 100-300", chosen_on: "in_sample", sharpes: [0.1, 0.5, 0.9, "0.3"] }, split: { oos_start: base.series.dates[900], method: "holdout" } });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.deepEqual(v.result.sweep, { configs_tried: 48, params: "fast 20-100 x slow 100-300", chosen_on: "in_sample", sharpes: [0.1, 0.5, 0.9, 0.3] });
  assert.deepEqual(v.result.split, { oos_start: base.series.dates[900], method: "holdout" });
  const a = buildDeskAudit({ result: v.result, review: { ok: true, issues: [] }, harness: null, bars: null, universe: null, intent: "", trials: 1, today: "2026-11-16", dataSource: "Prices: test" });
  const m = a.checks.find((c) => c.id === "multiple")!;
  assert.equal(m.name, "Best of 48 tried");
  assert.equal(m.status, "flag");
  assert.equal(a.multiple?.trials, 48);
  assert.equal(a.split?.method, "holdout");
  assert.ok(a.label.level === "thin" || a.label.level === "insufficient");
  assert.ok(a.label.reasons.some((x) => /best of 48/i.test(x)) || a.label.level === "insufficient");
  // Survives storage.
  const back = cleanAudit(JSON.parse(JSON.stringify(a)))!;
  assert.equal(back.multiple?.configs, 48);
  assert.equal(back.split?.oosStart, base.series.dates[900]);
  assert.equal(back.caveats?.dataSource, "Prices: test");
  // A single test in the conversation: no Best-of check.
  const single = buildDeskAudit({ result: base, review: { ok: true, issues: [] }, harness: null, bars: null, universe: null, intent: "", trials: 1, today: "2026-11-16" });
  assert.equal(single.checks.find((c) => c.id === "multiple"), undefined);
  assert.equal(single.multiple?.trials, 1);
});

/* ------------------------------------------------------------------ panel fixes (bugs 3, 4, 6) */

test("bug 3: exposure over the whole test lies between its parts (day-weighted average of the same day sets)", () => {
  const rets = alt(400, 0.0005, 0.01);
  const eq = curve(rets);
  const d = days("2018-01-02", eq.length);
  // In position for most of the first 70%, all of the last 30%: the parts are 92%-ish and 100%.
  const trades: RunTrade[] = [
    { date: d[20]!, ticker: "SPY", side: "buy", qty: 1, weight: 1, price: 1, pnl: null },
    { date: d[60]!, ticker: "SPY", side: "sell", qty: 1, weight: 1, price: 1, pnl: 0.01 },
    { date: d[61]!, ticker: "SPY", side: "buy", qty: 1, weight: 1, price: 1, pnl: null },
  ];
  // The script reports its own (different) exposure: it must not be mixed with the measured parts.
  const r = result(eq, { metrics: { ...result(eq).metrics, exposure: 0.69 } }, trades);
  const s = splitStats(r)!;
  const w = wholeStats(r)!;
  const lo = Math.min(s.is.exposure!, s.oos.exposure!);
  const hi = Math.max(s.is.exposure!, s.oos.exposure!);
  assert.ok(w.exposure! >= lo - 1e-12 && w.exposure! <= hi + 1e-12, `${w.exposure} not in [${lo}, ${hi}]`);
  // Exactly the day-weighted average: IS has the first k dates, OOS the rest.
  const k = s.is.days + 1;
  const n = r.series.dates.length;
  assert.ok(Math.abs(w.exposure! - (s.is.exposure! * k + s.oos.exposure! * (n - k)) / n) < 1e-12);
  // The headline's whole-test exposure is the measured one, not the script's 69%.
  assert.equal(wholeOf(headlineOf(r, w, s))!.exposure, w.exposure);
  // A sell and a re-buy on the same day keeps the position (a rebalance).
  const reb: RunTrade[] = [
    { date: d[0]!, ticker: "A", side: "buy", qty: 1, weight: 1, price: 1, pnl: null },
    { date: d[5]!, ticker: "A", side: "buy", qty: 1, weight: 1, price: 1, pnl: null },
    { date: d[5]!, ticker: "A", side: "sell", qty: 1, weight: 1, price: 1, pnl: 0 },
  ];
  assert.equal(exposureOf(reb, d.slice(0, 10)), 1);
});

test("bug 4: Sharpe 0.66 -> 0.59 out of sample is noise, not 'fell sharply'", () => {
  // Lo (2002): SE of an annualized Sharpe over T days ~ sqrt((1 + SR_d^2 / 2) / T) x sqrt(252).
  assert.ok(Math.abs(sharpeSE(0, 252)! - 1) < 1e-12);
  assert.ok(Math.abs(sharpeSE(0.59, 750)! - Math.sqrt((1 + 0.5 * (0.59 ** 2 / 252)) / 750) * Math.sqrt(252)) < 1e-12);
  const g = oosGrade({ sharpe: 0.66, cagr: 0.1, bench_cagr: 0.09 }, { sharpe: 0.59, cagr: 0.095, bench_cagr: 0.09, days: 750 });
  assert.equal(g.grade, "held_up");
  // A real collapse beyond the sampling error is still called out.
  assert.equal(oosGrade({ sharpe: 1.6, cagr: 0.2, bench_cagr: 0.1 }, { sharpe: 0.1, cagr: 0.02, bench_cagr: 0.1, days: 750 }).grade, "fell_sharply");
  // Halved but within noise (a short held-out part): weaker, not a collapse.
  assert.equal(oosGrade({ sharpe: 1.0, cagr: 0.12, bench_cagr: 0.1 }, { sharpe: 0.45, cagr: 0.11, bench_cagr: 0.1, days: 250 }).grade, "weaker");
  // Beat the benchmark in sample, lost to it out of sample, without halving: weaker.
  assert.equal(oosGrade({ sharpe: 0.8, cagr: 0.12, bench_cagr: 0.1 }, { sharpe: 0.7, cagr: 0.08, bench_cagr: 0.1, days: 750 }).grade, "weaker");
  // On a curve: Sharpe about 0.66 in sample, about 0.59 out of sample: no alarm.
  const rets = [...alt(1050, 0.00042, 0.01), ...alt(450, 0.000372, 0.01)];
  const s = splitStats(result(curve(rets)))!;
  assert.ok(Math.abs(s.is.sharpe! - 0.66) < 0.02 && Math.abs(s.oos.sharpe! - 0.59) < 0.02, `${s.is.sharpe} ${s.oos.sharpe}`);
  assert.equal(s.grade, "held_up");
  assert.equal(s.bigDrop, false);
});

test("bug 6: a selected strategy's headline is the out-of-sample part; a plain test's is the whole test", () => {
  const rets = [...alt(900, 0.0012, 0.01), ...alt(400, 0.0002, 0.01)];
  const base = result(curve(rets));
  const picked: RunResult = { ...base, sweep: { configs_tried: 90, params: "fast x slow", chosen_on: "in_sample", sharpes: [] }, split: { oos_start: base.series.dates[900]!, method: "holdout" } };
  const s = splitStats(picked)!;
  const h = headlineOf(picked, wholeStats(picked), s);
  assert.equal(h.scope, "oos");
  assert.equal(h.main.id, "oos");
  assert.equal(h.main.label, "Out of sample (not used to pick)");
  assert.equal(h.main.cagr, s.oos.cagr);
  assert.equal(h.main.excess, s.oos.cagr! - s.oos.bench_cagr!);
  assert.deepEqual(h.secondary.map((x) => x.id), ["is", "whole"]);
  assert.ok(h.secondary[0]!.cagr! > h.main.cagr!);
  // A selection period alone (no sweep count) also counts as selected.
  assert.equal(headlineOf({ ...base, split: picked.split }, null, s).scope, "oos");
  // Not selected: the whole test leads, with the benchmark's name carried.
  const plain = headlineOf({ ...base, benchmark: "AGG" }, wholeStats(base), splitStats(base));
  assert.equal(plain.scope, "whole");
  assert.equal(plain.benchmark, "AGG");
  assert.equal(plain.secondary.length, 0);
});
