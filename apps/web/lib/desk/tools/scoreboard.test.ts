// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/scoreboard.test.ts
// A fake in-memory store stands in for Supabase and Yahoo; nothing is read from or written to the real tables.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { deskToolCommand } from "./command";
import {
  SCOREBOARD_TOOL_NAME,
  isMissingTable,
  matchupFromRow,
  parseScoreboardInput,
  resetScoreboard,
  runScoreboardTool,
  scoreboardCommand,
  scoreboardLabel,
  type ScoreboardStore,
} from "./scoreboard";

const NOW = Date.parse("2026-11-16T19:00:00Z"); // Monday 14:00 New York: last closed session 2026-11-13
const LATER = Date.parse("2026-11-21T15:00:00Z"); // Saturday after the first 5-session window closed

const forecast = (id: number, ticker: string, o: Record<string, unknown> = {}) => ({
  id,
  created_at: "2026-11-14T12:17:45Z",
  event_id: `e${id}`,
  card_id: `c${id}`,
  ticker,
  tier: "watch",
  family: null,
  sign_pred: 1,
  window_days: 5,
  published: true,
  model_version: "v1",
  covariates: { confidence: "medium" },
  ...o,
});

const term: Array<[string, number, number]> = [
  ["2026-11-20", 7, 0.4],
  ["2026-12-18", 35, 0.4],
];

function fakeStore(over: Partial<ScoreboardStore> = {}): ScoreboardStore & { closesAsked: string[] } {
  const closesAsked: string[] = [];
  return {
    closesAsked,
    async matchups() {
      return null;
    },
    async forecasts() {
      return [
        forecast(1, "AAA"),
        forecast(2, "AAA", { event_id: "e1", card_id: "c1", created_at: "2026-11-15T12:00:00Z", sign_pred: -1 }), // a later row for the same hit: ignored
        forecast(3, "BBB", { tier: "documented", sign_pred: -1 }),
        forecast(4, "CCC", { sign_pred: 0 }),
        forecast(5, "NOPE"), // no options stored
      ];
    },
    async hits() {
      return new Map([["c3|BBB", { history: { windowDays: 5, avgMovePct: -1, events: [1, -2, 3, -4, 5, -6].map((d) => ({ movePct: d, benchmarkPct: 0 })) } }]]);
    },
    async options(tickers) {
      const m = new Map();
      for (const t of tickers) if (t !== "NOPE") m.set(t, [{ session: "2026-11-13", asOf: "2026-11-13T20:45:00Z", spot: 50, iv: 0.4, skew: null, beta: 1, vix: 0.2, term }]);
      return m;
    },
    async etfs() {
      return new Map([["AAA", "XLK"]]);
    },
    async closes(t) {
      closesAsked.push(t);
      const up: Record<string, [number, number]> = { AAA: [100, 106], BBB: [100, 97], CCC: [100, 100.5], XLK: [100, 101], SPY: [100, 100] };
      const v = up[t];
      return v ? new Map([["2026-11-13", v[0]], ["2026-11-20", v[1]]]) : null;
    },
    ...over,
  };
}

beforeEach(() => resetScoreboard());

test("input, label and command", () => {
  assert.deepEqual(parseScoreboardInput({}), { ticker: null, tier: null, kind: null });
  assert.deepEqual(parseScoreboardInput({ ticker: "brk.b", tier: "Documented" }), { ticker: "BRK-B", tier: "documented", kind: null });
  assert.deepEqual(parseScoreboardInput({ kind: "Earnings" }), { ticker: null, tier: null, kind: "earnings" });
  assert.throws(() => parseScoreboardInput({ kind: "dividends" }), /kind must be one of/);
  assert.equal(deskToolCommand(SCOREBOARD_TOOL_NAME, { kind: "earnings" }).cmd, "/scoreboard earnings");
  assert.throws(() => parseScoreboardInput({ tier: "strong" }), /tier must be one of/);
  assert.equal(scoreboardLabel({}, "running"), "Scoring Falcon vs the options market");
  assert.equal(scoreboardLabel({ ticker: "nvda" }), "Scored Falcon vs the options market (NVDA)");
  assert.equal(scoreboardCommand({ ticker: "nvda", tier: "watch" }), "/scoreboard NVDA watch");
  assert.equal(deskToolCommand(SCOREBOARD_TOOL_NAME, { tier: "documented" }).cmd, "/scoreboard documented");
  assert.equal(isMissingTable({ code: "PGRST205" }), true);
  assert.equal(isMissingTable({ code: "23505", message: "dup" }), false);
});

test("live: nothing matured yet, pending schedule and sample counts", async () => {
  const store = fakeStore();
  const r = await runScoreboardTool({}, { store, nowMs: NOW });
  assert.equal(r.ok, true);
  const out = JSON.parse(r.content);
  assert.match(out.source, /live/);
  assert.equal(out.sample.ledger_rows, 5);
  assert.equal(out.sample.forecasts, 4);
  assert.equal(out.sample.with_market_number, 3);
  assert.equal(out.sample.directional_with_market, 2);
  assert.equal(out.sample.with_falcon_size, 1);
  assert.equal(out.sample.matured, 0);
  assert.equal(out.sample.next_maturity, "2026-11-20");
  assert.deepEqual(out.sample.maturing, { "2026-11-20": 3 });
  assert.match(out.warnings[0], /No matchup has matured yet/);
  assert.equal(out.examples_pending.length, 2);
  assert.equal(store.closesAsked.length, 0, "no prices are read before a window closes");
});

test("live: matured windows are measured against the sector ETF and scored", async () => {
  const store = fakeStore();
  const out = JSON.parse((await runScoreboardTool({}, { store, nowMs: LATER })).content);
  assert.equal(out.sample.matured, 3);
  // AAA up: 6% - XLK 1% = +5 (hit). BBB down: -3% - SPY 0 = -3 (hit). CCC unclear: no direction.
  assert.equal(out.direction.n, 2);
  assert.equal(out.direction.hits, 2);
  assert.equal(out.size.n, 1); // only BBB has Falcon's size (record mean |move| 3.5)
  assert.ok(store.closesAsked.includes("XLK") && store.closesAsked.includes("SPY"));
  assert.ok(out.by_label.some((g: { label: string; n: number }) => g.label === "documented" && g.n === 1));
  const only = JSON.parse((await runScoreboardTool({ ticker: "BBB" }, { store, nowMs: LATER })).content);
  assert.equal(only.sample.forecasts, 1);
});

test("reads forecast_matchups when it has rows", async () => {
  const row = {
    key: "rf:9",
    kind: "forecast",
    ticker: "ZZZ",
    created_at: "2026-11-14T12:00:00Z",
    horizon_sessions: 5,
    base_date: "2026-11-13",
    exit_date: "2026-11-20",
    falcon_sign: 1,
    falcon_abs_pct: 3,
    tier: "measured",
    market_method: "term_interp",
    market_raw_pct: "5",
    market_adj_pct: 4,
    units: "abnormal",
    realized_raw_pct: 6,
    realized_abn_pct: 2,
  };
  const m = matchupFromRow(row);
  assert.equal(m.marketRawPct, 5);
  assert.equal(m.falconSign, 1);
  const store = fakeStore({ matchups: async () => [row], forecasts: async () => assert.fail("the ledger is not read when the table has rows") });
  const out = JSON.parse((await runScoreboardTool({}, { store, nowMs: LATER })).content);
  assert.match(out.source, /forecast_matchups/);
  assert.equal(out.direction.hits, 1);
  assert.equal(out.size.falcon_mae_pct, 1);
  assert.equal(out.size.market_mae_pct, 2);
});

test("a store failure becomes a plain error, never a throw", async () => {
  const store = fakeStore({ forecasts: async () => Promise.reject(new Error("boom")) });
  const r = await runScoreboardTool({}, { store, nowMs: NOW });
  assert.equal(r.ok, false);
  assert.match(JSON.parse(r.content).error, /unavailable/);
  const bad = await runScoreboardTool({ tier: "x" }, { store, nowMs: NOW });
  assert.match(JSON.parse(bad.content).error, /tier must be one of/);
});

test("earnings rows are scored apart, in raw moves, by sector", async () => {
  const earn = (t: string, d: string, falcon: number | null, market: number, realized: number | null, etf: string) => ({
    key: `earn:${t}:${d}`,
    kind: "earnings",
    ticker: t,
    created_at: `${d}T20:45:00Z`,
    horizon_sessions: 1,
    base_date: "2026-10-27",
    exit_date: d,
    falcon_sign: 0,
    falcon_abs_pct: falcon,
    market_method: "earnings_straddle",
    market_raw_pct: market,
    market_adj_pct: market,
    units: "raw",
    realized_raw_pct: realized,
    realized_abn_pct: realized === null ? null : realized - 1,
    benchmark: etf,
    straddle: { dte: t === "AAA" ? 2 : 20 },
  });
  const rows = [earn("AAA", "2026-10-28", 5, 6, -4, "XLK"), earn("BBB", "2026-10-28", 3, 4, 9, "XLK"), earn("CCC", "2026-10-28", null, 5, 2, "XLF"), earn("DDD", "2026-11-30", 4, 5, null, "XLF")];
  const forecastRow = { key: "rf:1", kind: "forecast", ticker: "ZZZ", created_at: "2026-11-14T12:00:00Z", horizon_sessions: 5, base_date: "2026-11-13", exit_date: "2026-11-20", falcon_sign: 1, falcon_abs_pct: 3, market_method: "term_interp", market_raw_pct: 5, market_adj_pct: 4, units: "abnormal", realized_raw_pct: 6, realized_abn_pct: 2 };
  const store = fakeStore({ matchups: async () => [forecastRow, ...rows] });
  const all = JSON.parse((await runScoreboardTool({}, { store, nowMs: LATER })).content);
  assert.equal(all.sample.forecasts, 1, "the main figures are the forecasts'");
  assert.equal(all.earnings.sample.releases, 4);
  assert.equal(all.earnings.sample.matured, 3);
  // Size: AAA |4| vs Falcon 5 (1) and market 6 (2); BBB |9| vs 3 (6) and 4 (5); CCC has no Falcon estimate.
  assert.equal(all.earnings.size.n, 2);
  assert.equal(all.earnings.size.falcon_mae_pct, 3.5);
  assert.equal(all.earnings.size.market_mae_pct, 3.5);
  const tech = all.earnings.by_sector.find((g: { etf: string }) => g.etf === "XLK");
  assert.equal(tech.sector, "Technology");
  assert.equal(tech.n, 2);
  assert.deepEqual(all.earnings.by_straddle_expiry.map((g: { n: number }) => g.n), [1, 2]);
  assert.deepEqual(all.earnings.sample.reaction_days_by_year, { "2026": 4 });
  const only = JSON.parse((await runScoreboardTool({ kind: "earnings" }, { store, nowMs: LATER })).content);
  assert.equal(only.filters.kind, "earnings");
  assert.equal(only.sample.forecasts, 4);
  assert.equal(only.direction.n, 0, "earnings carry no direction");
});
