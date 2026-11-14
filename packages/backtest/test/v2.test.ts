import test from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATES,
  checkFormula,
  describeSpec,
  emptyUses,
  floorBps,
  runBacktest,
  runChecked,
  v1ToV2,
  validateSpec,
  blankSpec,
  type StrategySpecV2,
} from "../src/index";
import { computeOutput } from "../src/output";
import { prepare } from "../src/prepare";
import { simulate } from "../src/simulate";
import { costModel } from "../src/costs";
import { quarterly, sessions, specData, toMarketData, walkBars } from "./v2-helpers";
import type { CheckEnv } from "../src/fsl/check";

const env = (params: CheckEnv["params"] = {}, defs: Record<string, string> = {}, mode: CheckEnv["mode"] = "rules"): CheckEnv => ({ mode, params, defs });
const P = { p: { type: "number" as const, value: 50, min: 0, max: 100, step: 1 } };

test("checker rejects look-ahead, levels, bare rank, bad names and cycles", () => {
  const bad: [string, CheckEnv, RegExp][] = [
    ["delay(close, 0) > 0", env(), /at least 1 session/],
    ["delay(close, -1) > 0", env(), /at least 1 session/],
    ["rank(ret(close, 20)) > 0.5", env(), /rank\(\) is not available/],
    ["close > 50", env(), /fixed number/],
    ["close > $p", env(P), /compared with \$p/],
    ['at("SPY", close) > close', env(), /adjusted price of SPY/],
    ["$Lookback > 1", env(), /not a valid parameter name/],
    ["lookback_period > 1", env({}, { lookback_period: "lookback_period + 1" }), /loop/],
    ['ripple.judged_dir > 0', env(), /not available in backtests/],
    ['close > ts_mean(close, 20) and "2020-01-01" == "x"', env(), /Dates cannot appear/],
  ];
  for (const [src, e, re] of bad) {
    const r = checkFormula(src, "entry", e);
    assert.equal(r.ok, false, `${src} should be rejected`);
    if (!r.ok) assert.match(`${r.error} ${r.hint ?? ""}`, re, src);
  }
  // The raw_close hint for level comparisons.
  const lvl = checkFormula("close > 50", "entry", env());
  assert.ok(!lvl.ok && /raw_close/.test(lvl.hint ?? ""));
  // Identifier "Lookback Period" as a param key is a spec error.
  const s = blankSpec();
  (s.params as Record<string, unknown>)["Lookback Period"] = { type: "int", value: 5, min: 1, max: 10, step: 1 };
  assert.equal(validateSpec(s).ok, false);
  // A w() cycle.
  const w = { ...blankSpec(), universe: { kind: "static" as const, tickers: ["SPY"] }, params: {}, portfolio: { mode: "weights" as const, weights: { SPY: '1 - w("TLT")', TLT: '1 - w("SPY")' } } };
  const wr = validateSpec(w);
  assert.equal(wr.ok, false);
  if (!wr.ok) assert.match(wr.issues.map((i) => i.message).join(" "), /loop/);
});

test("checker accepts the forms the design names", () => {
  const ok = [
    "close > ts_mean(close, 200)",
    "crosses_above(ts_mean(close, 50), ts_mean(close, 200))",
    'rsi(close, 2) < 10 and close > ts_mean(close, 200)',
    'at("SPY", close / ts_mean(close, 200)) > 1',
    "top_n(ret(close, 126), 3)",
    'at("SPY", vol(21)) > 0.25',
    "count(close < delay(close, 1), 3) == 3",
    "tdom == -1 or tdom <= 3",
    'of("NVDA", earnings.reaction_abn) > 0.03',
    "macd(close, 12, 26) > 0",
    "raw_close > 5",
    'ts_zscore(at("KO", close) / at("PEP", close), 60) < -2',
  ];
  for (const src of ok) {
    const r = checkFormula(src, "entry", env());
    assert.ok(r.ok, `${src}: ${r.ok ? "" : r.error}`);
  }
});

function synthetic(n = 1400) {
  const dates = sessions("2018-01-01", n);
  const semis = ["NVDA", "AMD", "AVGO", "QCOM", "TXN", "INTC", "MU", "AMAT", "LRCX", "KLAC", "ADI", "MRVL", "NXPI", "MCHP", "ON"];
  const bars: Record<string, ReturnType<typeof walkBars>> = {
    SPY: walkBars(dates, 1, { vol: 0.01, volume: 80_000_000, start: 300 }),
    QQQ: walkBars(dates, 2, { vol: 0.013, volume: 40_000_000, start: 200 }),
  };
  const earnings: Record<string, ReturnType<typeof quarterly>> = {};
  semis.forEach((t, i) => {
    bars[t] = walkBars(dates, 10 + i, { vol: 0.025 });
    // Busy earnings days: several names report on the same sessions.
    earnings[t] = quarterly(dates, 100 + i, 30 + (i % 3));
  });
  return { dates, data: specData(bars, earnings) };
}

test("v1 parity: the 3 templates give identical trades through v1 and v1ToV2 + FSL + engine v2 (legacy)", () => {
  const { dates, data } = synthetic();
  const config = { start: dates[300]!, end: dates[dates.length - 1]!, initialCapital: 100_000, commissionBps: 1, slippageBps: 5 };
  for (const t of TEMPLATES) {
    const v1 = runBacktest(t.rules, config, toMarketData(data), { tiebreak: "list_order" });
    const spec = v1ToV2(t.rules, config);
    const check = validateSpec(spec, new Date(`${config.end}T20:00:00Z`));
    assert.ok(check.ok, check.ok ? "" : JSON.stringify(check.issues));
    if (!check.ok) continue;
    const v2 = runChecked(check, { data, now: new Date(`${config.end}T20:00:00Z`) });
    assert.ok(v1.trades.length > 3, `${t.id}: the fixture should trade`);
    assert.equal(v2.trades.length, v1.trades.length, `${t.id}: trade count`);
    v1.trades.forEach((a, i) => {
      const b = v2.trades[i]!;
      assert.equal(b.ticker, a.ticker, `${t.id} trade ${i} ticker`);
      assert.equal(b.entryDate, a.entryDate, `${t.id} trade ${i} entry`);
      assert.equal(b.exitDate, a.exitDate, `${t.id} trade ${i} exit`);
      assert.ok(Math.abs(b.entryPrice - a.entryPrice) < 1e-9 * a.entryPrice, `${t.id} trade ${i} entry price`);
      assert.ok(Math.abs(b.pnl - a.pnl) < 1e-6, `${t.id} trade ${i} pnl`);
      assert.equal(b.exitReason, a.exitReason);
    });
    assert.ok(Math.abs(v2.curves!.strategy.at(-1)! - v1.equity.at(-1)!.strategy) < 1e-6, `${t.id}: final equity`);
  }
  // Without legacy, the semis template differs on at least one busy earnings day (seeded tie-break, not list order).
  const semis = TEMPLATES.find((t) => t.id === "semis-beat")!;
  const spec = v1ToV2(semis.rules, config);
  const free = structuredClone(spec);
  delete free.legacy;
  free.cash = "zero";
  free.execution.spread = 5;
  (free.portfolio as { reentry: unknown }).reentry = { cooldown_days: 0 };
  const a = runChecked(validateSpec(spec, new Date(`${config.end}T20:00:00Z`)) as never, { data, now: new Date(`${config.end}T20:00:00Z`) });
  const fc = validateSpec(free, new Date(`${config.end}T20:00:00Z`));
  assert.ok(fc.ok);
  const b = runChecked(fc as never, { data, now: new Date(`${config.end}T20:00:00Z`) });
  const key = (r: typeof a) => r.trades.map((x) => `${x.entryDate}:${x.ticker}`).join("|");
  assert.notEqual(key(a), key(b));
});

function rulesSpec(over: Partial<StrategySpecV2> & { entry: string; exit?: string | null; tickers?: string[] }): StrategySpecV2 {
  const s = blankSpec();
  const { entry, exit, tickers, ...rest } = over;
  return {
    ...s,
    params: {},
    universe: { kind: "static", tickers: tickers ?? ["AAA"] },
    portfolio: { mode: "rules", entry, exit: exit ?? null, max_positions: 1, clock: "close", reentry: "edge", tiebreak: "seeded", sizing: "equal" },
    cash: "zero",
    execution: { commission_bps: 0, spread: 0, borrow_bps_yr: 0, gross_cap: 1 },
    ...rest,
  };
}

test("contract: after a stop exit while entry stays true, no re-entry until it goes false then true (edge), or the cooldown", () => {
  const dates = sessions("2020-01-01", 60);
  const closes = dates.map((_, i) => (i < 10 ? 100 : i === 12 ? 90 : i < 30 ? 101 : i < 35 ? 99 : 102));
  const bars = {
    SPY: walkBars(dates, 3),
    AAA: dates.map((date, i) => {
      const c = closes[i]!;
      const o = i ? closes[i - 1]! : c;
      return { date, open: o, high: Math.max(o, c), low: Math.min(o, c) * (i === 12 ? 0.95 : 1), close: c, volume: 1e7, rawClose: c, dollarVolume: c * 1e7 };
    }),
  };
  const data = specData(bars);
  const now = new Date(`${dates.at(-1)}T20:00:00Z`);
  const base = rulesSpec({ entry: "raw_close > 95", period: { start: dates[0]!, end: dates.at(-1)! }, risk: { stop_pct: 5, trailing_pct: null, take_profit_pct: null, max_hold_days: null } });
  const run = (s: StrategySpecV2) => {
    const c = validateSpec(s, now);
    assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.issues));
    return runChecked(c as never, { data, now });
  };
  const edge = run(base);
  assert.equal(edge.trades[0]!.exitReason, "stop_loss");
  // raw_close > 95 is false only on sessions 30-34 (99 is above 95... use the stop day): entry stays true after the stop.
  // Session 12 closes at 90 (< 95) so entry goes false there; the re-entry comes after it turns true again.
  const second = edge.trades[1];
  assert.ok(second, "re-enters once the rule went false and true again");
  assert.ok(second!.entryDate > dates[12]!);
  const always = run(rulesSpec({ entry: "raw_close > 50", period: base.period, risk: base.risk }));
  assert.equal(always.trades.length, 1, "entry never goes false after the stop: no re-entry under edge");
  const coolSpec = rulesSpec({ entry: "raw_close > 50", period: base.period, risk: base.risk });
  (coolSpec.portfolio as { reentry: unknown }).reentry = { cooldown_days: 5 };
  const cool = run(coolSpec);
  assert.ok(cool.trades.length >= 2, "the cooldown lets it back in");
  const gap = Number(new Date(`${cool.trades[1]!.entryDate}T00:00:00Z`)) - Number(new Date(`${cool.trades[0]!.exitDate}T00:00:00Z`));
  assert.ok(gap >= 5 * 86_400_000);
});

test("contract: NaN targets hold, targets apply only on rebalance dates", () => {
  const dates = sessions("2020-01-01", 300);
  const data = specData({ SPY: walkBars(dates, 4), TLT: walkBars(dates, 5) });
  const now = new Date(`${dates.at(-1)}T20:00:00Z`);
  const spec: StrategySpecV2 = {
    ...blankSpec(),
    params: {},
    universe: { kind: "static", tickers: ["SPY", "TLT"] },
    portfolio: { mode: "weights", weights: { SPY: "0.6", TLT: "0.4" } },
    rebalance: "quarterly",
    period: { start: dates[30]!, end: dates.at(-1)! },
  };
  const c = validateSpec(spec, now);
  assert.ok(c.ok);
  if (!c.ok) return;
  const prep = prepare(data, c.tickers, { start: dates[30]!, end: dates.at(-1)! }, "close", false);
  const out = computeOutput(c.spec, prep, c.weightOrder).output;
  assert.equal(out.kind, "targets");
  if (out.kind !== "targets") return;
  const T = prep.panel.dates.length;
  let rebs = 0;
  for (let t = 0; t < T; t++) {
    if (out.rebalance[t]) rebs++;
    else assert.ok(Number.isNaN(out.target[t]!), "off rebalance dates the target is HOLD");
  }
  assert.ok(rebs >= 4 && rebs <= 6, `quarterly rebalances: ${rebs}`);
  // A manual target panel: NaN everywhere after the first allocation leaves positions untouched.
  const target = new Float64Array(2 * T).fill(NaN);
  target[prep.startIndex] = 0.5;
  target[T + prep.startIndex] = 0.5;
  const reb = new Uint8Array(T).fill(1);
  const sim = simulate(prep.panel, { kind: "targets", target, rebalance: reb }, {
    universe: ["SPY", "TLT"], startIndex: prep.startIndex, endIndex: prep.endIndex, clock: "close", maxPositions: 2, sizing: "equal",
    reentry: "edge", tiebreak: "seeded", seed: "x", risk: { stop_pct: null, trailing_pct: null, take_profit_pct: null, max_hold_days: null },
    commissionBps: 1, spread: "auto", noCostFloor: false, cashRate: null, capital: 100_000, grossCap: 1, drift: "none", legacyOrder: false,
  });
  assert.equal(sim.trades.length, 2, "bought once, held to the end");
  assert.ok(sim.trades.every((t) => t.exitReason === "end"));
});

test("contract: a pre-open rule cannot read close t", () => {
  const dates = sessions("2020-01-01", 260);
  const bars = { SPY: walkBars(dates, 6), AAA: walkBars(dates, 7) };
  const earnings = { AAA: quarterly(dates, 8, 40) };
  const data = specData(bars, earnings);
  const now = new Date(`${dates.at(-1)}T20:00:00Z`);
  const mk = (clock: "close" | "preopen") =>
    rulesSpec({ entry: "earnings.event and close > delay(close, 1)", period: { start: dates[20]!, end: dates.at(-1)! } } as never) as StrategySpecV2;
  const pre = mk("preopen");
  (pre.portfolio as { clock: string }).clock = "preopen";
  const c = validateSpec(pre, now);
  assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.issues));
  if (!c.ok) return;
  const prep = prepare(data, c.tickers, { start: dates[20]!, end: dates.at(-1)! }, "preopen", false);
  const out = computeOutput(c.spec, prep, null).output;
  // Changing session t's bar must not change the pre-open decision at t.
  const T = prep.panel.dates.length;
  const t = 150;
  const changed = structuredClone(bars);
  changed.AAA[t]!.close *= 1.5;
  const prep2 = prepare(specData(changed, earnings), c.tickers, { start: dates[20]!, end: dates.at(-1)! }, "preopen", false);
  const out2 = computeOutput(c.spec, prep2, null).output;
  if (out.kind === "signals" && out2.kind === "signals") assert.equal(out.entry[t], out2.entry[t]);
  // And a price-only rule cannot use the pre-open clock.
  const priceOnly = rulesSpec({ entry: "close > delay(close, 1)" });
  (priceOnly.portfolio as { clock: string }).clock = "preopen";
  assert.equal(validateSpec(priceOnly).ok, false);
  assert.ok(T > t);
});

test("costs: SPY at daily rebalance pays a 0.5 bp half-spread; a $3 stock with $2M ADV pays at least 25 bp", () => {
  assert.equal(floorBps(30e9, 450, 3), 0.5);
  assert.ok(floorBps(2e6, 3, 1) >= 25);
  assert.ok(floorBps(2e6, 30, 40) >= 40, "Corwin-Schultz raises the illiquid tiers");
  const dates = sessions("2021-01-01", 80);
  const bars = { SPY: walkBars(dates, 9, { volume: 80_000_000, start: 450 }), PENNY: walkBars(dates, 10, { volume: 600_000, start: 3 }) };
  const prep = prepare(specData(bars), ["SPY", "PENNY"], { start: dates[30]!, end: dates.at(-1)! }, "close", false);
  const cm = costModel(prep.panel, { spread: "auto", commissionBps: 1 });
  assert.equal(cm.halfSpread(prep.panel.col.get("SPY")!, 60) * 10_000, 0.5);
  assert.ok(cm.halfSpread(prep.panel.col.get("PENNY")!, 60) * 10_000 >= 25);
  // A typed spread below the floor is raised to it.
  const typed = costModel(prep.panel, { spread: 1, commissionBps: 1 });
  assert.ok(typed.halfSpread(prep.panel.col.get("PENNY")!, 60) * 10_000 >= 25);
});

test("describe(): numbered rules from templates, parameter labels from operator slots", () => {
  const s = blankSpec();
  const c = validateSpec(s);
  assert.ok(c.ok);
  if (!c.ok) return;
  const d = describeSpec(c.spec, c.uses);
  assert.match(d.rules[0]!, /^1\. Trades SPY\./);
  assert.match(d.rules[1]!, /^2\. Enters at the next open when, on the close, SPY's close is above its 200-session average close \(\$ma\)\./);
  assert.equal(d.paramLabels.ma, "average length");
  for (const r of d.rules) assert.ok(!/should|—/.test(r));
  const u = emptyUses();
  assert.ok(u.params.size === 0);
});

test("expressiveness: the 12 audit strategies compile exactly", async () => {
  const { EXPRESSIVENESS } = await import("./expressiveness");
  assert.equal(EXPRESSIVENESS.length, 12);
  for (const e of EXPRESSIVENESS) {
    const c = validateSpec(e.spec);
    assert.ok(c.ok, `${e.id}: ${c.ok ? "" : JSON.stringify(c.issues)}`);
    if (c.ok) assert.ok(describeSpec(c.spec, c.uses).rules.length >= 2);
  }
});
