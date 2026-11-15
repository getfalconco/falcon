import test from "node:test";
import assert from "node:assert/strict";
import {
  SPEC_LIMITS,
  STARTERS,
  UNIVERSES,
  UNIVERSE_BASES,
  blankSpec,
  defaultYears,
  describeSpec,
  resolvePeriod,
  runChecked,
  universeLabel,
  universeTickers,
  validateSpec,
  type StrategySpecV2,
} from "../src/index";
import { SPEC_TICKER_RE } from "../src/spec";
import { hindsightSignals, hindsightTexts, pickedTodayName } from "../src/audit/tiers";
import { buildPanel, packBars } from "../src/prepare";
import { CONVERSE_SYSTEM } from "../src/ai/prompts";
import { listInput, modelToSpec, tickersQuestion, untypedTickers } from "../src/ai/converse";
import { maxYearsFor, runSpec } from "../src/data/run-spec";
import type { MarketDataProvider } from "../src/data/provider";
import type { Bar } from "../src/data/types";
import { sessions, specData, walkBars } from "./v2-helpers";

const NOW = new Date("2026-11-15T21:00:00Z");

function rankOn(universe: StrategySpecV2["universe"], extra: Partial<StrategySpecV2> = {}): StrategySpecV2 {
  return {
    ...blankSpec(),
    name: "Top 3 by 3-month return",
    intent: "top 3",
    universe,
    params: { lookback: { type: "int", value: 63, min: 21, max: 252, step: 21 } },
    portfolio: { mode: "rank", score: "ret(close, $lookback)", order: "desc", select: { n: 3 }, filter: null, weighting: "equal" },
    rebalance: "monthly",
    ...extra,
  };
}

const rule = (base: (typeof UNIVERSE_BASES)[number]): StrategySpecV2["universe"] => ({ kind: "rule", base, filter: null });

// ---------------------------------------------------------------------------
// The lists

test("universes: every named list resolves to unique, valid Yahoo tickers of the expected size", () => {
  const size: Record<string, [number, number]> = {
    falcon_semis: [58, 58],
    sector_etfs: [11, 11],
    falcon_universe: [1_400, 1_600],
    falcon_graph: [1_400, 1_900],
    us_large_caps: [500, 500],
    sp500_today: [495, 510],
  };
  for (const base of UNIVERSE_BASES) {
    const t = universeTickers(rankOn(rule(base)));
    assert.equal(new Set(t).size, t.length, `${base} repeats tickers`);
    for (const x of t) assert.ok(SPEC_TICKER_RE.test(x), `${base}: ${x}`);
    const [lo, hi] = size[base]!;
    assert.ok(t.length >= lo && t.length <= hi, `${base}: ${t.length}`);
    assert.ok(t.length + 1 <= SPEC_LIMITS.maxUniverseTickers, base);
  }
  // Class shares in Yahoo spelling; well-known members present.
  const sp = new Set(UNIVERSES.sp500_today.tickers);
  for (const t of ["AAPL", "MSFT", "BRK-B", "JPM", "XOM"]) assert.ok(sp.has(t), t);
  const big = new Set(UNIVERSES.us_large_caps.tickers);
  for (const t of UNIVERSES.us_large_caps.tickers) assert.ok(new Set(UNIVERSES.falcon_universe.tickers).has(t), t);
  assert.ok(big.has("NVDA") && big.has("AAPL"));
  for (const b of ["falcon_universe", "falcon_graph", "us_large_caps", "sp500_today"] as const) {
    assert.match(UNIVERSES[b].asOf ?? "", /^\d{4}-\d{2}-\d{2}$/, b);
    assert.equal(UNIVERSES[b].todaysPick, true, b);
  }
  assert.equal(UNIVERSES.sector_etfs.todaysPick, false);
});

test("universes: a named universe validates past the 500-ticker limit for typed lists; a typed list over 500 does not", () => {
  const ok = validateSpec(rankOn(rule("falcon_universe")), NOW);
  assert.ok(ok.ok, ok.ok ? "" : JSON.stringify(ok.issues));
  const typed = validateSpec(rankOn({ kind: "static", tickers: UNIVERSES.falcon_universe.tickers.slice(0, 501) }), NOW);
  assert.equal(typed.ok, false);
});

test("universes: rules text and labels in plain words, with the list date", () => {
  const sp = validateSpec(rankOn(rule("sp500_today")), NOW);
  assert.ok(sp.ok);
  const first = describeSpec(sp.spec, sp.uses).rules[0]!;
  assert.match(first, /^1\. Universe: the S&P 500 members today \(\d{3} tickers, today's membership as of \d{4}-\d{2}-\d{2}\)\.$/);
  assert.equal(universeLabel(rankOn(rule("sp500_today"))), "S&P 500 today");
  assert.equal(universeLabel(rankOn(rule("falcon_universe"))), `Falcon universe (${UNIVERSES.falcon_universe.tickers.length.toLocaleString("en-US")} stocks)`);
  const focus = rankOn({ kind: "static", tickers: ["AAPL", "MSFT", "NVDA"], from: "focus_list", as_of: "2026-11-15" });
  assert.equal(universeLabel(focus), "your focus list (3)");
  const fc = validateSpec(focus, NOW);
  assert.ok(fc.ok);
  assert.equal(describeSpec(fc.spec, fc.uses).rules[0], "1. Universe: your focus list as of 2026-11-15 (3 tickers: AAPL, MSFT, NVDA).");
  assert.equal(universeLabel(rankOn({ kind: "static", tickers: ["AAPL", "MSFT"] })), "AAPL, MSFT");
});

test("universes: wide lists default to the last 5 years, others to 10; named dates win", () => {
  assert.equal(defaultYears(rankOn(rule("falcon_universe"))), 5);
  assert.equal(defaultYears(rankOn(rule("falcon_graph"))), 5);
  assert.equal(defaultYears(rankOn(rule("sp500_today"))), 10);
  assert.equal(defaultYears(rankOn(rule("us_large_caps"))), 10);
  assert.deepEqual(resolvePeriod(rankOn(rule("falcon_universe")), NOW), { start: "2021-11-15", end: "2026-11-15" });
  assert.deepEqual(resolvePeriod(rankOn(rule("sp500_today")), NOW), { start: "2016-11-15", end: "2026-11-15" });
  assert.deepEqual(resolvePeriod(rankOn(rule("falcon_universe"), { period: { start: "2023-01-01", end: null } }), NOW), { start: "2023-01-01", end: "2026-11-15" });
  // About 6 years fit one run for the widest list, 20 for a 500-name list.
  assert.equal(maxYearsFor(UNIVERSES.falcon_graph.tickers.length + 1), 6);
  assert.ok(maxYearsFor(UNIVERSES.sp500_today.tickers.length + 1) >= 20);
});

test("starters: every starter compiles, two use the wide universes", () => {
  for (const s of STARTERS) {
    const c = validateSpec(s.spec, NOW);
    assert.ok(c.ok, `${s.id}: ${c.ok ? "" : JSON.stringify(c.issues)}`);
  }
  const wide = STARTERS.filter((s) => s.spec.universe.kind === "rule" && UNIVERSES[s.spec.universe.base].todaysPick);
  assert.deepEqual(wide.map((s) => s.spec.universe.kind === "rule" && s.spec.universe.base).sort(), ["falcon_universe", "sp500_today"]);
});

// ---------------------------------------------------------------------------
// Loading: too large before any request, a deadline reports progress

function fakeProvider(delayMs: number, calls: { n: number }): MarketDataProvider {
  const dates = sessions("2019-01-01", 2_000);
  return {
    name: "fake",
    prices: {
      name: "fake prices",
      async dailyBars(ticker: string, from: string, to: string, signal?: AbortSignal): Promise<Bar[]> {
        calls.n++;
        if (ticker !== "SPY" && delayMs) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, delayMs);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }
        return walkBars(dates, ticker.length * 7 + ticker.charCodeAt(0)).filter((b) => b.date >= from && b.date <= to);
      },
    },
    earnings: null,
    ripple: null,
    rates: null,
    beta: true,
  };
}

test("load: a wide universe over too many years is refused before any price is requested, with the years that fit", async () => {
  const calls = { n: 0 };
  const r = await runSpec(rankOn(rule("falcon_universe"), { period: { start: "2010-01-01", end: null } }), { provider: fakeProvider(0, calls), now: NOW });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 400);
  assert.match(!r.ok ? r.errors[0]! : "", /at most 6 years/);
  assert.equal(calls.n, 0);
});

test("load: a deadline on a wide universe returns 504 with how many tickers are loaded (and cached)", async () => {
  const calls = { n: 0 };
  const r = await runSpec(rankOn(rule("falcon_universe")), { provider: fakeProvider(200, calls), now: NOW, deadlineAt: Date.now() + 1_000 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 504);
  assert.ok(r.progress && r.progress.total === UNIVERSES.falcon_universe.tickers.length + 1, JSON.stringify(r.progress));
  assert.ok(r.progress!.loaded > 0 && r.progress!.loaded < r.progress!.total, JSON.stringify(r.progress));
  assert.match(r.errors[0]!, /of 1,50\d tickers are loaded and cached/);
  // Reads are pooled: far fewer than all tickers were started.
  assert.ok(calls.n < 400, String(calls.n));
});

test("prepare: packed bars build the same panel as Bar objects", () => {
  const dates = sessions("2020-01-01", 300);
  const bars: Record<string, Bar[]> = { SPY: walkBars(dates, 1), A: walkBars(dates, 2, { from: 40 }), B: walkBars(dates, 3).filter((_, i) => i % 7 !== 3) };
  const a = buildPanel(bars, ["A", "B", "SPY"], dates);
  const b = buildPanel(Object.fromEntries(Object.entries(bars).map(([k, v]) => [k, packBars(v)])), ["A", "B", "SPY"], dates);
  for (const f of ["open", "high", "low", "close", "raw", "volume", "dv", "has"] as const) assert.deepEqual(Array.from(b[f]), Array.from(a[f]), f);
});

// ---------------------------------------------------------------------------
// Hindsight on named universes (check 14)

test("hindsight: a named list of today's stocks or the focus list is confirmed by construction; the sector ETFs are not a pick", () => {
  assert.match(pickedTodayName(rankOn(rule("sp500_today")))!, /^the S&P 500 members today \(as of \d{4}-\d{2}-\d{2}\)$/);
  assert.match(pickedTodayName(rankOn(rule("us_large_caps")))!, /500 most traded/);
  assert.equal(pickedTodayName(rankOn(rule("sector_etfs"))), null);
  assert.equal(pickedTodayName(rankOn(rule("falcon_semis"))), null);
  assert.equal(pickedTodayName(rankOn({ kind: "static", tickers: ["AAPL", "MSFT"], from: "focus_list", as_of: "2026-11-15" })), "your focus list as of 2026-11-15");
  assert.equal(pickedTodayName(rankOn({ kind: "static", tickers: ["AAPL", "MSFT"] })), null);
  const base = { listChosenToday: true, yearsBack: 5, tickers: 500, late: [], intentTell: false, listExcessPct: 0.5 };
  assert.equal(hindsightSignals(base).confirmed, false);
  const sig = hindsightSignals({ ...base, pickedToday: true });
  assert.equal(sig.confirmed, true);
  const t = hindsightTexts(sig, { tickers: 500, yearsBack: 5, startYear: "2021", selective: true, listName: "the S&P 500 members today (as of 2026-11-12)" }, null);
  assert.ok(t.cap, "a confirmed list caps the label");
  assert.match(t.detail, /The universe is the S&P 500 members today \(as of 2026-11-12\): its membership as it stands today, not as it stood in 2021\./);
  assert.match(t.cap!.someText, /it is the S&P 500 members today/);
  // A test inside the last year is not a hindsight test.
  assert.equal(hindsightSignals({ ...base, pickedToday: true, yearsBack: 0.5 }).confirmed, false);
});

test("hindsight: a past test on the S&P 500 today warns, confirms and keeps the label below Strong", () => {
  const dates = sessions("2018-01-01", 1_300);
  const now = new Date(`${dates.at(-1)}T21:00:00Z`);
  const bars: Record<string, Bar[]> = { SPY: walkBars(dates, 5, { volume: 9e7 }) };
  UNIVERSES.sp500_today.tickers.forEach((t, i) => (bars[t] = walkBars(dates, 100 + i, { drift: 0.0003 + (i % 7) * 0.0001, volume: 2e7 })));
  const spec = rankOn(rule("sp500_today"), { period: { start: dates[400]!, end: null } });
  const c = validateSpec(spec, now);
  assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.issues));
  const r = runChecked(c, { data: specData(bars), now });
  const c14 = r.quality.checks.find((x) => x.id === 14)!;
  assert.equal(c14.status, "warn");
  assert.equal(r.quality.values.hindsight!.confirmed, "yes");
  assert.match(c14.detail, /S&P 500 members today/);
  assert.notEqual(r.quality.label.level, "consistent");
});

test("hindsight: the 11 sector ETFs are a fixed set, not a pick (check 14 passes)", () => {
  const dates = sessions("2018-01-01", 1_300);
  const now = new Date(`${dates.at(-1)}T21:00:00Z`);
  const bars: Record<string, Bar[]> = { SPY: walkBars(dates, 5, { volume: 9e7 }) };
  UNIVERSES.sector_etfs.tickers.forEach((t, i) => (bars[t] = walkBars(dates, 300 + i, { volume: 2e7 })));
  const c = validateSpec(rankOn(rule("sector_etfs"), { period: { start: dates[400]!, end: null } }), now);
  assert.ok(c.ok);
  const r = runChecked(c, { data: specData(bars), now });
  assert.equal(r.quality.checks.find((x) => x.id === 14)!.status, "pass");
});

// ---------------------------------------------------------------------------
// The AI side, offline

test("ai: the prompt names every universe and the mapping phrases, lists no wide list's tickers, and has no dates", () => {
  for (const b of UNIVERSE_BASES) assert.ok(CONVERSE_SYSTEM.includes(`"${b}"`), b);
  for (const phrase of ['"Large caps"', '"All stocks"', '"Stocks in Falcon\'s graph"', '"My focus list"', '"list": "FOCUS"', "sp500_today"]) assert.ok(CONVERSE_SYSTEM.includes(phrase), phrase);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(CONVERSE_SYSTEM));
  assert.ok(!CONVERSE_SYSTEM.includes(UNIVERSES.falcon_universe.tickers.slice(100, 104).join(", ")));
  assert.ok(CONVERSE_SYSTEM.length < 40_000, String(CONVERSE_SYSTEM.length));
  assert.ok(CONVERSE_SYSTEM.includes("Falcon's Backtest") && !CONVERSE_SYSTEM.includes("Strategy Lab"));
});

const specJson = (universe: unknown) =>
  JSON.stringify({
    name: "Focus list above its 50-day average",
    universe,
    params: { ma: { type: "int", value: 50, min: 10, max: 200, step: 5 } },
    defs: {},
    portfolio: { mode: "rules", entry: "close > ts_mean(close, $ma)", exit: "close < ts_mean(close, $ma)", max_positions: 3, clock: "close", reentry: "edge", tiebreak: "seeded", sizing: "equal" },
    rebalance: "monthly",
    risk: { stop_pct: null, trailing_pct: null, take_profit_pct: null, max_hold_days: null },
    cash: "tbill",
    benchmark: "SPY",
    period: { start: null, end: null },
    execution: { commission_bps: 1, spread: "auto", borrow_bps_yr: 50, gross_cap: 1 },
    capital: 100000,
  });

test("ai: the focus list travels as list FOCUS and comes back marked as the focus list, untyped tickers allowed", () => {
  const input = { intent: "My focus list above its 50-day average", answers: [], focus: ["aapl", "MSFT", "brk.b", "MSFT"] };
  const listed = listInput(input, NOW);
  assert.deepEqual(listed.lists.get("FOCUS"), ["AAPL", "MSFT", "BRK-B"]);
  const spec = modelToSpec(specJson({ kind: "list", list: "FOCUS" }), input.intent, [], listed.lists, [], listed.marks)!;
  assert.deepEqual(spec.universe, { kind: "static", tickers: ["AAPL", "MSFT", "BRK-B"], from: "focus_list", as_of: "2026-11-15" });
  const c = validateSpec(spec, NOW);
  assert.ok(c.ok, c.ok ? "" : JSON.stringify(c.issues));
  assert.equal(c.spec.universe.kind === "static" && c.spec.universe.from, "focus_list");
  assert.deepEqual(untypedTickers(c.spec, input, listed.lists), []);
  // An edit keeps the focus-list mark through list L0.
  const edit = listInput({ intent: input.intent, answers: [], edit: { request: "use a 100-day average", current: c.spec } }, NOW);
  const edited = modelToSpec(specJson({ kind: "list", list: "L0" }), input.intent, [], edit.lists, [], edit.marks)!;
  assert.equal(edited.universe.kind === "static" && edited.universe.from, "focus_list");
  // Without a focus list, FOCUS is an unknown handle the model is told to fix.
  const problems: string[] = [];
  modelToSpec(specJson({ kind: "list", list: "FOCUS" }), input.intent, [], listInput({ intent: input.intent, answers: [] }, NOW).lists, problems);
  assert.match(problems[0] ?? "", /no ticker list FOCUS/);
});

test("ai: a named universe needs no typed tickers; the tickers question offers the lists and the focus list", () => {
  for (const b of UNIVERSE_BASES) {
    const spec = modelToSpec(specJson({ kind: "rule", base: b, filter: null }), "x", [])!;
    const c = validateSpec(spec, NOW);
    assert.ok(c.ok, `${b}: ${c.ok ? "" : JSON.stringify(c.issues)}`);
    assert.deepEqual(untypedTickers(c.spec, { intent: "momentum on all stocks", answers: [] }), [], b);
  }
  const q = tickersQuestion(["AAPL", "MSFT"]);
  assert.ok(q.options.length <= 4 && q.options[0] === "I will type the tickers");
  assert.ok(q.options.some((o) => o.startsWith("My focus list (2")));
  assert.ok(q.options.some((o) => o.startsWith("S&P 500 members today")));
  assert.ok(tickersQuestion([]).options.some((o) => o.startsWith("Falcon's universe")));
});
