import test from "node:test";
import assert from "node:assert/strict";
import { blankSpec, describeSpec, runChecked, validateSpec, type QualityReport, type StrategySpecV2 } from "../src/index";
import { VALUE_UNITS, fillSlots, formatValue } from "../src/audit/report";
import { tierB } from "../src/audit/tiers";
import { prepare } from "../src/prepare";
import { benchmarks, simulateSpec } from "../src/run";
import { allowedNumbers, inventedNumbers, repairReply, repairSentence, review, templateProblems } from "../src/ai/review";
import { sessions, specData, walkBars } from "./v2-helpers";

// ---------------------------------------------------------------------------
// A report shaped like the founder's run: 250 static tickers, top 3 by the
// 63-session return every Tuesday, 10% trailing stop, a confirmed hindsight list.

function founder() {
  const tickers = ["AAPL", "NVDA", "SNDK", "PLTR", "BRK-B", "0700.HK"];
  const spec: StrategySpecV2 = {
    ...blankSpec(),
    name: "Top 3 three-month gainers every Tuesday, 10% trailing stop",
    intent: "Every Tuesday purchase previous 3 month's top 3 gainers. With %10 trailing stop",
    universe: { kind: "static", tickers },
    params: { lookback: { type: "int", value: 63, min: 21, max: 252, step: 21 }, n: { type: "int", value: 3, min: 1, max: 10, step: 1 } },
    portfolio: { mode: "rank", score: "ret(close, $lookback)", order: "desc", select: { n: "$n" }, filter: null, weighting: "equal" },
    rebalance: "weekly",
    rebalance_weekday: 2,
    risk: { stop_pct: null, trailing_pct: 10, take_profit_pct: null, max_hold_days: null },
  } as StrategySpecV2;
  const describe = {
    rules: [
      "1. Trades any of 6 tickers: AAPL, NVDA, SNDK, PLTR, BRK-B, 0700.HK.",
      "2. Each week, on the close of the session before Tuesday, ranks the tickers with data by the 63-session return ($lookback), highest first.",
      "3. Holds the top 3 ($n) at Tuesday's open, at equal weight; everything else is sold.",
      "4. Trailing stop 10% below the highest close since entry.",
      "5. Cash earns the 3-month T-bill rate.",
    ],
    paramLabels: {},
    cannotKnow: [],
  };
  const report: QualityReport = {
    tiers: ["A"],
    label: { level: "some", title: "Some evidence", heading: "", subtitle: "", reasons: ["Part of the result comes from the list itself: held equally, it made 20.7% a year vs SPY's 15.0%."] },
    checks: [
      { id: 7, name: "Null comparison (200 seeds)", tier: "B", level: "I", status: "pass", detail: "x" },
      { id: 9, name: "Costs", tier: "A", level: "W", status: "warn", detail: "x" },
      { id: 12, name: "Concentration", tier: "A", level: "W", status: "warn", detail: "The 5 best trades made 72% of the profit." },
      { id: 14, name: "Hindsight universe", tier: "A", level: "W", status: "warn", detail: "x" },
    ],
    flags: [],
    values: {
      hindsight: { years_back: 10, tickers: 250, start_year: "2016", confirmed: "yes", late_listed: 18, late_examples: "PLTR, SNDK", list_annual_pct: 20.7, spy_annual_pct: 15, strategy_annual_pct: 45.7, list_vs_spy_pct: 5.27, rules_vs_list_pct: 24.49 },
      sample: { trades: 766, rebalances: 522, years: 10 },
      active: { annual_pct: 29.76, range_lo: 9.78, range_hi: 51.12, hac_t: 2.55 },
      bootstrap: { k: 990, n: 1000, k_of_n: "990 of 1000" },
      costs: { x2_active_pct: 27.11, break_even_bps: 60.3, modelled_bps: 2.8, monthly_turnover_pct: 215.7, drag_pct: 1.45 },
      delay: { active_pct: 28.05, drop_pct: 5.8 },
      concentration: { top_ticker: "SNDK", top_ticker_share_pct: 45.4, top5_trades_share_pct: 72, best_year: "2026", best_year_share_pct: 42.1 },
      liquidity: { over_adv: 0, capacity_adv_pct: 0.59, min_raw_price: 6.27 },
      regimes: { above_200d_pct: 31.2, below_200d_pct: -4.1, low_vol_pct: 1, mid_vol_pct: 2, high_vol_pct: 3 },
    },
  };
  return { spec, describe, report, allow: allowedNumbers({ spec, describe, report }) };
}

const S = (template: string, ...refs: string[]) => ({ template, slots: refs.map((ref) => ({ ref })) });

// ---------------------------------------------------------------------------
// The validator: numbers that define the strategy pass, invented ones do not.

test("validator: rule parameters, the person's own numbers, ticker symbols and report-named constants are allowed", () => {
  const { allow } = founder();
  for (const t of [
    "The intent says a 10% trailing stop, and the rules hold the top 3 by the 63-session return.",
    "The best 5 trades made {} of the profit.", // top5_trades_share_pct names the 5
    "With SPY above its 200-day average the active return was {}.", // above_200d_pct, "200 seeds"
    "BRK-B and 0700.HK are in the list; cash earns the 3-month T-bill rate, as in the S&P 500.",
  ]) {
    assert.deepEqual(inventedNumbers(t, allow), [], t);
  }
});

test("validator: numbers Falcon did not compute and the strategy does not define are rejected", () => {
  const { allow } = founder();
  assert.deepEqual(inventedNumbers("The strategy made 45.7% a year.", allow), ["45.7"]);
  assert.deepEqual(inventedNumbers("Over 7 years, 1,200 trades.", allow), ["7", "1,200"]);
  assert.deepEqual(inventedNumbers("The best year was 2026.", allow), ["2026"]);
  // The rules' "1." numbering is not a parameter.
  assert.deepEqual(inventedNumbers("It held 4 names.", allow), ["4"]);
  // A ticker not in the list does not hide its digits.
  assert.deepEqual(inventedNumbers("9988.HK rose.", allow), ["9988"]);
});

test("validator: a check's fixed numbers are allowed only when that check is in the report", () => {
  const { spec, describe, report } = founder();
  const t = "The active return has a 90% range from {} to {}.";
  assert.deepEqual(inventedNumbers(t, allowedNumbers({ spec, describe, report })), ["90"]);
  const withUncertainty = { ...report, checks: [...report.checks, { id: 8, name: "Uncertainty", tier: "A" as const, level: "I" as const, status: "info" as const, detail: "x" }] };
  assert.deepEqual(inventedNumbers(t, allowedNumbers({ spec, describe, report: withUncertainty })), []);
  // Check 12 (concentration) is in the report: "more than 50% of the profit" is its threshold.
  assert.deepEqual(inventedNumbers("The 5 best trades made more than 50% of the profit.", allowedNumbers({ spec, describe, report })), []);
});

test("validator: without the spec only report-named constants pass", () => {
  const { report } = founder();
  const allow = allowedNumbers({ report });
  assert.deepEqual(inventedNumbers("A 10% trailing stop and the 5 best trades.", allow), ["10"]);
  const out = { headline: S("A 10% stop."), flags: [], interpretation_risks: [], next_experiments: [] };
  assert.ok(templateProblems(out, report).some((p) => p.includes('"10"')));
  assert.deepEqual(templateProblems(out, report, founder().allow), []);
});

// ---------------------------------------------------------------------------
// Repair: drop only what carries the problem.

test("repair: a sentence with an invented number is dropped, the rest of the template and its slots are kept", () => {
  const { report, allow } = founder();
  const s = S("The strategy made {} a year. That is 3.4 times SPY's {}. The list held equally made {}.", "hindsight.strategy_annual_pct", "hindsight.spy_annual_pct", "hindsight.list_annual_pct");
  const r = repairSentence(s, report, allow)!;
  assert.deepEqual(r, S("The strategy made {} a year. The list held equally made {}.", "hindsight.strategy_annual_pct", "hindsight.list_annual_pct"));
  // Unknown ref: only its sentence goes.
  assert.deepEqual(repairSentence(S("Made {}. Lost {}.", "active.annual_pct", "nope.x"), report, allow), S("Made {}.", "active.annual_pct"));
  // Nothing valid left, or slots that cannot be matched to holes: null.
  assert.equal(repairSentence(S("It made 12% a year."), report, allow), null);
  assert.equal(repairSentence(S("Made {} and {}.", "active.annual_pct"), report, allow), null);
  // A valid sentence comes back as is.
  const ok = S("Made {}.", "active.annual_pct");
  assert.equal(repairSentence(ok, report, allow), ok);
});

test("repair: flags lose a bad try_next or the whole flag, experiments need both halves, unknown checks go", () => {
  const { report, allow } = founder();
  const out = {
    headline: S("The list explains much of the gain: {} a year against {} for the list.", "hindsight.strategy_annual_pct", "hindsight.list_annual_pct"),
    flags: [
      { check_id: 12, severity: "medium" as const, meaning: S("The best 5 trades made {} of the profit.", "concentration.top5_trades_share_pct"), try_next: S("Drop the 11 best names.") },
      { check_id: 14, severity: "high" as const, meaning: S("About 60 names were not listed."), try_next: null },
      { check_id: 99, severity: "low" as const, meaning: S("Fine."), try_next: null },
    ],
    interpretation_risks: [S("The intent says a 10% trailing stop."), S("It trades 52 times a year.")],
    next_experiments: [
      { change: S("Run it on the first half."), why: S("This tests {}.", "concentration.best_year") },
      { change: S("Delay by 7 sessions."), why: S("This tests timing.") },
    ],
  };
  const r = repairReply(out, report, allow);
  assert.ok(r.headline);
  assert.deepEqual(
    r.reply.flags.map((f) => [f.check_id, f.try_next]),
    [[12, null]],
  );
  assert.deepEqual(r.reply.interpretation_risks, [S("The intent says a 10% trailing stop.")]);
  assert.equal(r.reply.next_experiments.length, 1);
  assert.equal(r.dropped, 5);
});

test("Explain: digits from the rules pass on the first call; a repaired reply is used without a retry", async () => {
  const { spec, describe, report } = founder();
  const sent: unknown[] = [];
  const reply = {
    headline: S("The strategy made {} a year against {} for the same list held equally and {} for SPY.", "hindsight.strategy_annual_pct", "hindsight.list_annual_pct", "hindsight.spy_annual_pct"),
    flags: [
      { check_id: 12, severity: "medium", meaning: S("The best 5 trades made {} of the profit, and {} alone made {}.", "concentration.top5_trades_share_pct", "concentration.top_ticker", "concentration.top_ticker_share_pct"), try_next: null },
      { check_id: 9, severity: "low", meaning: S("At twice the costs the active return is {} a year. Turnover is {} a month. That is 9 trades a week.", "costs.x2_active_pct", "costs.monthly_turnover_pct"), try_next: null },
    ],
    interpretation_risks: [S("The intent says a 10% trailing stop; the rules measure it from the highest close since entry.")],
    next_experiments: [{ change: S("Use the list as it stood in {}.", "hindsight.start_year"), why: S("This separates the rules from the list, which beat SPY by {} a year.", "hindsight.list_vs_spy_pct") }],
  };
  const client = { beta: { messages: { create: async (p: unknown) => (sent.push(p), { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }], usage: {} }) } } };
  const r = await review({ spec, describe, report }, { client: client as never });
  assert.equal(sent.length, 1, "no retry");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.review.headline, "The strategy made 45.7% a year against 20.7% for the same list held equally and 15% for SPY.");
  assert.equal(r.review.flags[0]!.meaning, "The best 5 trades made 72% of the profit, and SNDK alone made 45.4%.");
  assert.equal(r.review.flags[1]!.meaning, "At twice the costs the active return is 27.1% a year. Turnover is 216% a month.");
  assert.equal(r.review.interpretationRisks[0], "The intent says a 10% trailing stop; the rules measure it from the highest close since entry.");
  assert.deepEqual(r.review.nextExperiments[0], { change: "Use the list as it stood in 2016.", why: "This separates the rules from the list, which beat SPY by 5.3 points a year." });
  assert.equal(r.review.repaired, 1);
});

test("Explain: a lost headline is retried; if the retry is no better, Falcon's label sentence heads the kept parts", async () => {
  const { spec, describe, report } = founder();
  const bad = { headline: S("It made 45.7% a year."), flags: [{ check_id: 14, severity: "high", meaning: S("The list made {} a year.", "hindsight.list_annual_pct"), try_next: null }], interpretation_risks: [], next_experiments: [] };
  let calls = 0;
  const client = { beta: { messages: { create: async () => (calls++, { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(bad) }], usage: {} }) } } };
  const r = await review({ spec, describe, report }, { client: client as never });
  assert.equal(calls, 2);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.review.headline, "Some evidence. Part of the result comes from the list itself: held equally, it made 20.7% a year vs SPY's 15.0%.");
  assert.equal(r.review.flags[0]!.meaning, "The list made 20.7% a year.");
  // Nothing valid at all: invalid.
  const empty = { headline: S("It made 45.7% a year."), flags: [], interpretation_risks: [], next_experiments: [] };
  const c2 = { beta: { messages: { create: async () => ({ model: "m", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(empty) }], usage: {} }) } } };
  const r2 = await review({ spec, describe, report }, { client: c2 as never });
  assert.ok(!r2.ok && r2.reason === "invalid");
});

// ---------------------------------------------------------------------------
// Units: the filler formats by the value's declared unit, not by the template.

test("units: percent, points, counts, years, dollars, basis points and text", () => {
  assert.equal(formatValue(45.7, "pct"), "45.7%");
  assert.equal(formatValue(-4.1, "pct"), "-4.1%");
  assert.equal(formatValue(24.49, "pts"), "24.5 points");
  assert.equal(formatValue(1, "pts"), "1 point");
  assert.equal(formatValue(1000, "count"), "1,000");
  assert.equal(formatValue(10, "years"), "10 years");
  assert.equal(formatValue(6.27, "usd"), "$6.27");
  assert.equal(formatValue(2.8, "bp"), "2.8 bp");
  assert.equal(formatValue(2.56, "number"), "2.6");
  assert.equal(formatValue("2026", "text"), "2026");
  assert.equal(formatValue(null, "pct"), "n/a");
});

test("units: a unit the template already wrote is kept once, a clashing one gives way", () => {
  const { report } = founder();
  const f = (t: string, ...refs: string[]) => fillSlots(t, refs, report.values);
  assert.equal(f("made {} a year", "hindsight.strategy_annual_pct"), "made 45.7% a year");
  assert.equal(f("made {}% a year", "hindsight.strategy_annual_pct"), "made 45.7% a year");
  assert.equal(f("made {} percent", "hindsight.strategy_annual_pct"), "made 45.7 percent");
  assert.equal(f("beat SPY by {} a year", "hindsight.list_vs_spy_pct"), "beat SPY by 5.3 points a year");
  assert.equal(f("beat SPY by {}% a year", "hindsight.list_vs_spy_pct"), "beat SPY by 5.3 points a year");
  assert.equal(f("beat SPY by {} percentage points", "hindsight.list_vs_spy_pct"), "beat SPY by 5.3 percentage points");
  assert.equal(f("made {} points a year", "hindsight.strategy_annual_pct"), "made 45.7% a year");
  assert.equal(f("over {} trades and {}", "sample.trades", "sample.years"), "over 766 trades and 10 years");
  assert.equal(f("over {} years", "sample.years"), "over 10 years");
  assert.equal(f("a {}-year test", "sample.years"), "a 10-year test");
  assert.equal(f("{} of {} resamples", "bootstrap.k", "bootstrap.n"), "990 of 1,000 resamples");
  assert.equal(f("a low of {} and ${}", "liquidity.min_raw_price", "liquidity.min_raw_price"), "a low of $6.27 and $6.27");
  assert.equal(f("break-even about {} and {} bp", "costs.break_even_bps", "costs.modelled_bps"), "break-even about 60.3 bp and 2.8 bp");
  assert.equal(f("in {}, {} of it", "concentration.best_year", "concentration.best_year_share_pct"), "in 2026, 42.1% of it");
  assert.equal(f("{} was missing", "nope.x"), "n/a was missing");
});

// Every value the tiers produce has a declared unit (rank, rules, event study, Tier B).
test("units: every value produced by Tier A and Tier B is listed in VALUE_UNITS", () => {
  const dates = sessions("2015-01-01", 1500);
  const now = new Date(`${dates.at(-1)}T21:00:00Z`);
  const period = { start: dates[300]!, end: dates.at(-1)! };
  const bars = { SPY: walkBars(dates, 1, { volume: 9e7 }), AAA: walkBars(dates, 2), BBB: walkBars(dates, 3), CCC: walkBars(dates, 4), DDD: walkBars(dates, 5) };
  const tickers = ["AAA", "BBB", "CCC", "DDD"];
  const base = { ...blankSpec(), universe: { kind: "static", tickers }, period } as StrategySpecV2;
  const specs: StrategySpecV2[] = [
    { ...base, params: { lb: { type: "int", value: 63, min: 21, max: 252, step: 21 } }, portfolio: { mode: "rank", score: "ret(close, $lb)", order: "desc", select: { n: 2 }, filter: null, weighting: "equal" }, rebalance: "weekly" } as StrategySpecV2,
    { ...base, params: { ma: { type: "int", value: 50, min: 10, max: 200, step: 10 } }, portfolio: { mode: "rules", entry: "close > ts_mean(close, $ma)", exit: "close < ts_mean(close, $ma)", max_positions: 4, clock: "close", reentry: "edge", tiebreak: "seeded", sizing: "equal" } } as StrategySpecV2,
    { ...base, params: {}, portfolio: { mode: "event_study", event: "ret(close, 1) > 0.02", targets: "ret(close, 1) > 0.02", windows: [1, 5, 20] } } as StrategySpecV2,
  ];
  const seen = new Set<string>();
  for (const spec of specs) {
    const c = validateSpec(spec, now);
    assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.issues));
    if (!c.ok) continue;
    const data = specData(bars);
    const r = runChecked(c, { data, now });
    for (const [g, vals] of Object.entries(r.quality.values)) for (const k of Object.keys(vals)) seen.add(`${g}.${k}`);
    if (spec.portfolio.mode === "event_study") continue;
    const prep = prepare(data, c.tickers, period, "close", false);
    const b = tierB(c, prep, simulateSpec(c, prep), benchmarks(c.spec, prep), { deadlineMs: 60_000 });
    for (const [g, vals] of Object.entries(b.values)) for (const k of Object.keys(vals)) seen.add(`${g}.${k}`);
  }
  for (const g of ["sample", "null", "hindsight", "costs", "event", "null_b", "neighbourhood", "loo", "regimes"]) assert.ok([...seen].some((r) => r.startsWith(`${g}.`)), `no ${g} values were produced`);
  const missing = [...seen].filter((ref) => {
    const [g, k] = ref.split(".");
    return !VALUE_UNITS[g!]?.[k!];
  });
  assert.deepEqual(missing, []);
  // describe() is used for allowed numbers; it must not throw on these specs.
  for (const spec of specs) {
    const c = validateSpec(spec, now);
    if (c.ok) assert.ok(Array.isArray(describeSpec(c.spec, c.uses).rules));
  }
});
