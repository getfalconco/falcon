// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/iv.test.ts
// Supabase, Databento and Yahoo are answered by a mocked fetch; nothing leaves the machine.
// The option chain is synthetic (Black-Scholes prices at a known volatility), never Databento data.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { bsmPrice } from "../../../../../packages/engine/src/options/math.ts";
import { expiryInstantMs } from "../../../../../packages/engine/src/options/surface.ts";
import { normalizeChart } from "../chart-spec";
import { deskToolCommand } from "./command";
import {
  capRefusal,
  chainRequest,
  computeChain,
  discountToContinuous,
  ivAtMoneyness,
  ivStanding,
  ivTool,
  ivToolLabel,
  parseIvInput,
  pickIvSnapshots,
  resetIv,
  shapeIv,
  smileOf,
  smileOutput,
  spread,
  storedView,
  surfaceOutput,
  termPoints,
  type IvContract,
  type LiveChain,
  type Market,
  type StoreRow,
} from "./iv";
import { resetYahoo } from "./yahoo";

/* ------------------------------------------------------------------ input */

test("parseIvInput: defaults, class shares and bad input", () => {
  assert.deepEqual(parseIvInput({ ticker: "aapl" }), { ticker: "AAPL", detail: "summary", expiration: null, live: false, range: "1y" });
  assert.deepEqual(parseIvInput({ ticker: "BRK.B", detail: "Surface", live: true }), { ticker: "BRK-B", detail: "surface", expiration: null, live: true, range: "1y" });
  assert.equal(parseIvInput({ ticker: "AAPL", detail: "history", range: "3M" }).range, "3m");
  assert.throws(() => parseIvInput({ ticker: "AAPL", detail: "history", range: "10y" }), /range must be one of/);
  assert.equal(parseIvInput({ ticker: "SOUN", detail: "smile", expiration: "2026-12-18" }).expiration, "2026-12-18");
  assert.throws(() => parseIvInput({}), /ticker is required/);
  assert.throws(() => parseIvInput({ ticker: "Apple Inc" }), /not a US stock ticker/);
  assert.throws(() => parseIvInput({ ticker: "AAPL", detail: "3d" }), /detail must be one of/);
  assert.throws(() => parseIvInput({ ticker: "AAPL", expiration: "Dec 18" }), /YYYY-MM-DD/);
  assert.throws(() => parseIvInput({ ticker: "AAPL", live: "yes" }), /live must be/);
});

test("label and slash command", () => {
  assert.equal(ivToolLabel({ ticker: "aapl" }, "running"), "Reading AAPL options overview");
  assert.equal(ivToolLabel({ ticker: "AAPL", detail: "surface" }), "Built AAPL IV surface");
  assert.equal(deskToolCommand("falcon_options", { ticker: "brk.b", detail: "term" }).cmd, "/options BRK.B term");
  assert.equal(deskToolCommand("falcon_options", { ticker: "AAPL", detail: "summary" }).cmd, "/options AAPL");
  assert.equal(deskToolCommand("falcon_options", { ticker: "AAPL", detail: "history", range: "1y" }).cmd, "/options AAPL history 1y");
  assert.equal(deskToolCommand("falcon_options", { ticker: "SPY", detail: "history" }).cmd, "/options SPY history 1y");
  assert.equal(ivToolLabel({ ticker: "AAPL", detail: "history" }, "running"), "Reading AAPL IV history");
});

/* ------------------------------------------------------------------ caps */

test("capRefusal: per pull, ledger, caller month and total month caps", () => {
  const caps = { maxPullUsd: 0.25, callerMonthUsd: 10, totalMonthUsd: 110 };
  assert.equal(capRefusal(0.005, { callerUsd: 1, totalUsd: 50 }, caps), null);
  assert.match(capRefusal(0.3, { callerUsd: 0, totalUsd: 0 }, caps)!, /\$0\.30, over the \$0\.25 limit/);
  assert.match(capRefusal(0.01, null, caps)!, /ledger could not be read/);
  assert.match(capRefusal(0.02, { callerUsd: 9.99, totalUsd: 20 }, caps)!, /monthly budget for on-demand options data \(\$10\.00\)/);
  assert.match(capRefusal(0.02, { callerUsd: 1, totalUsd: 109.99 }, caps)!, /monthly Databento budget \(\$110\.00\)/);
  assert.equal(capRefusal(0.01, { callerUsd: 9.99, totalUsd: 20 }, caps), null);
  assert.match(capRefusal(Number.NaN, { callerUsd: 0, totalUsd: 0 }, caps)!, /could not price/);
});

/* ------------------------------------------------------------------ snapshots */

test("pickIvSnapshots: end of day, intraday and early close", () => {
  // Monday 2026-11-16 10:55 New York; Databento's OPRA range ends at today's open.
  const a = pickIvSnapshots(Date.parse("2026-11-16T15:55:00Z"), Date.parse("2026-11-16T14:30:00Z"));
  assert.equal(a.eod?.label, "2026-11-13 15:45 ET");
  assert.equal(a.eod?.asOfMs, Date.parse("2026-11-13T20:45:00Z"));
  assert.equal(a.latest?.label, "2026-11-13 15:45 ET");
  // Range through 13:00 New York today: the latest is intraday 12:59, the end of day still Friday.
  const b = pickIvSnapshots(Date.parse("2026-11-16T19:00:00Z"), Date.parse("2026-11-16T18:00:00Z"));
  assert.equal(b.latest?.label, "2026-11-16 12:59 ET");
  assert.equal(b.latest?.intraday, true);
  assert.equal(b.eod?.label, "2026-11-13 15:45 ET");
  // Unknown range after the close: today's 15:45 once it is 15 minutes old.
  assert.equal(pickIvSnapshots(Date.parse("2026-11-16T21:05:00Z"), null).eod?.label, "2026-11-16 15:45 ET");
  // The day after Thanksgiving closes at 13:00: snapshot 12:45.
  assert.equal(pickIvSnapshots(Date.parse("2026-11-28T15:00:00Z"), null).eod?.label, "2026-11-27 12:45 ET");
});

test("chainRequest: one parent, the engine's quote window", () => {
  const r = chainRequest("BRK-B", { date: "2026-11-13", minute: 945 });
  assert.deepEqual(r, { dataset: "OPRA.PILLAR", schema: "cbbo-1m", symbols: ["BRKB.OPT"], stype_in: "parent", start: "2026-11-13T20:40:00.000Z", end: "2026-11-13T20:46:00.000Z" });
});

/* ------------------------------------------------------------------ store and standing */

const block = (atmIv: number, asOf = "2026-11-13T20:45:00.000Z") => ({
  asOf,
  source: "OPRA via Databento" as const,
  spot: 356.03,
  atmIv,
  impliedMove5: { sessions: 5, expiration: "2026-11-20", rawPct: 2.44, marketAdjustedPct: 2.1 },
  impliedMove20: { sessions: 20, expiration: "2026-12-18", rawPct: 4.96, marketAdjustedPct: 4.31 },
  skew: 3.4,
  cpSpread: 3,
  beta: 0.57,
  vix: 19.3,
});

test("storedView: latest record, history oldest first, newer skip, term", () => {
  const rows: StoreRow[] = [
    { as_of: "2026-11-12", skip: null, block: block(20.1), ivPct: null, term: null },
    { as_of: "2026-11-13", skip: null, block: block(21.9), ivPct: 40, term: [["2026-11-20", 7.01, 0.2168], ["2026-12-18", 35.01, 0.22085], ["bad", Number.NaN, 0.2] as never] },
  ];
  const v = storedView(rows);
  assert.equal(v.stored?.session, "2026-11-13");
  assert.equal(v.stored?.block.ivPct, 40);
  assert.deepEqual(v.stored?.history, [{ date: "2026-11-12", atmIv: 20.1 }, { date: "2026-11-13", atmIv: 21.9 }]);
  assert.equal(v.stored?.term.length, 2);
  assert.equal(v.skip, null);
  const s = storedView([{ as_of: "2026-11-16", skip: "poor chain: only 9 contracts with an IV", block: null, ivPct: null, term: null }, ...rows]);
  assert.deepEqual(s.skip, { session: "2026-11-16", reason: "poor chain: only 9 contracts with an IV" });
  assert.equal(storedView([]).stored, null);
});

test("ivStanding: needs 20 sessions; percentile and rank", () => {
  const few = ivStanding(30, [{ date: "2026-11-13", atmIv: 21.9 }]);
  assert.equal(few.percentile, null);
  assert.match(few.note!, /need 20 earlier stored sessions; Falcon has 1 \(since 2026-11-13\)/);
  const hist = Array.from({ length: 25 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, atmIv: 20 + i }));
  const s = ivStanding(32, hist);
  assert.equal(s.sessions, 25);
  assert.equal(s.percentile, 50); // 12 below, 1 equal: (12 + 0.5) / 25
  assert.equal(s.rank, 50); // (32 - 20) / (44 - 20)
  assert.equal(s.low, 20);
  assert.equal(s.high, 44);
  assert.equal(ivStanding(50, hist).rank, 100);
});

/* ------------------------------------------------------------------ shaping */

const SPOT = 100;
function synthContracts(): IvContract[] {
  const out: IvContract[] = [];
  const exps: Array<[string, number]> = [["2026-11-20", 7], ["2026-12-18", 35], ["2027-01-15", 63], ["2027-03-19", 126], ["2027-06-18", 217]];
  for (const [expiration, days] of exps) {
    for (let k = 70; k <= 130; k += 5) {
      const smile = 0.3 + 0.002 * Math.abs(k - 100) + (k < 100 ? 0.001 * (100 - k) : 0) + days / 3650;
      out.push({ strike: k, right: "P", expiration, days, iv: smile + (k >= 100 ? 0.05 : 0) });
      out.push({ strike: k, right: "C", expiration, days, iv: smile + (k < 100 ? 0.05 : 0) });
    }
  }
  return out;
}

test("smileOf takes the out-of-the-money side; ivAtMoneyness interpolates, never extrapolates", () => {
  const c = synthContracts();
  const s = smileOf(c, "2026-12-18", SPOT);
  assert.equal(s.length, 13);
  const at90 = s.find((p) => p.strike === 90)!;
  assert.ok(Math.abs(at90.iv - (0.3 + 0.02 + 0.01 + 35 / 3650)) < 1e-12, "put side below spot");
  const at110 = s.find((p) => p.strike === 110)!;
  assert.ok(Math.abs(at110.iv - (0.3 + 0.02 + 35 / 3650)) < 1e-12, "call side above spot");
  assert.ok(Math.abs(ivAtMoneyness(s, SPOT, 92.5)! - (at90.iv + s.find((p) => p.strike === 95)!.iv) / 2) < 1e-12);
  assert.equal(ivAtMoneyness(s, SPOT, 140), null);
  assert.equal(ivAtMoneyness([{ strike: 75, iv: 0.3 }, { strike: 100, iv: 0.3 }], SPOT, 90), null, "gap over 20 points");
  assert.equal(ivAtMoneyness([{ strike: 80, iv: 0.3 }, { strike: 95, iv: 0.4 }], SPOT, 90)!.toFixed(4), "0.3667", "a $3 stock's 15-point strike gap");
});

test("surfaceOutput is a valid show_chart surface3d grid", () => {
  const out = surfaceOutput({ contracts: synthContracts(), spot: SPOT })!;
  assert.deepEqual(out.grid.x, [80, 85, 90, 95, 100, 105, 110, 115, 120]);
  assert.deepEqual(out.grid.y, [7, 35, 63, 126, 217]);
  assert.equal(out.grid.z.length, 5);
  assert.ok(out.grid.z.every((row) => row.length === 9));
  assert.ok(out.grid.z.slice(1).every((row) => row.every((v) => typeof v === "number")));
  // A week out the 80% and 120% wings are past 4 standard deviations: empty.
  assert.deepEqual([out.grid.z[0]![0], out.grid.z[0]![8], typeof out.grid.z[0]![4]], [null, null, "number"]);
  assert.equal(out.expirations[0], "2026-11-20");
  const chart = normalizeChart({ kind: "surface3d", title: "IV surface", grid: out.grid, axes: out.axes });
  assert.ok(chart.ok, JSON.stringify(chart));
});

test("smileOutput: nearest 30 days by default, nearest listed expiry when asked, capped", () => {
  const chain = { contracts: synthContracts(), spot: SPOT };
  const s = smileOutput(chain, null)!;
  assert.equal(s.expiration, "2026-12-18");
  assert.equal(s.points.length, 13);
  assert.deepEqual(s.points[0], [70, 40]);
  const t = smileOutput(chain, "2027-01-20")!;
  assert.equal(t.expiration, "2027-01-15");
  assert.match(t.note!, /nearest listed/);
  assert.equal(spread(Array.from({ length: 100 }, (_, i) => i), 40).length, 40);
  assert.deepEqual(termPoints([{ expiration: "2026-11-17", days: 1, iv: 0.2 }, { expiration: "2026-11-20", days: 7.01, iv: 0.2168 }]), [["2026-11-20", 7, 21.7]]);
});

test("shapeIv: stored summary, stored term, no surface without a live chain", () => {
  const stored = storedView([{ as_of: "2026-11-13", skip: null, block: block(21.9), ivPct: null, term: [["2026-11-20", 7.01, 0.2168], ["2026-12-18", 35.01, 0.22085], ["2027-02-19", 98.01, 0.25288]] }]).stored!;
  const q = parseIvInput({ ticker: "AAPL" });
  const a = shapeIv({ q, stored, live: null, liveNote: null }) as Record<string, unknown>;
  assert.equal(a.atmIv30Pct, 21.9);
  assert.equal(a.data, "stored (free)");
  assert.equal(a.snapshot, "2026-11-13 15:45 ET");
  assert.equal(typeof a.atmIv60Pct, "number");
  assert.match(String(a.meaning), /not a forecast/);
  assert.equal((a.term as unknown[]).length, 3, "summary carries a compact term structure");
  assert.equal(a.ivToVix, 1.13);
  assert.deepEqual((a.ivStanding as Record<string, unknown>).percentile, null);
  const b = shapeIv({ q: parseIvInput({ ticker: "AAPL", detail: "term" }), stored, live: null, liveNote: null }) as Record<string, unknown>;
  assert.deepEqual(b.term, [["2026-11-20", 7, 21.7], ["2026-12-18", 35, 22.1], ["2027-02-19", 98, 25.3]]);
  const c = shapeIv({ q: parseIvInput({ ticker: "AAPL", detail: "surface" }), stored, live: null, liveNote: "the monthly Databento budget ($110.00) is used up" }) as Record<string, unknown>;
  assert.equal(c.surface, undefined);
  assert.ok((c.notes as string[]).some((n) => /No surface: the monthly Databento budget/.test(n)));
  assert.ok(JSON.stringify(c).length < 4_000);
});

/* ------------------------------------------------------------------ the engine's math on a synthetic chain */

const SIGMA = 0.6;
const RATE = discountToContinuous(3.9);
const SNAP = { date: "2026-11-13", minute: 945, asOfMs: Date.parse("2026-11-13T20:45:00Z"), label: "2026-11-13 15:45 ET", intraday: false };
const EXPIRIES = ["2026-11-20", "2026-12-18", "2027-01-15", "2027-03-19"];

/** cbbo-1m records of a chain priced at SIGMA (European prices, 2% wide), for `root` around `spot`. */
function chainRecords(root: string, spot: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let id = 1000;
  for (const exp of EXPIRIES) {
    const T = (expiryInstantMs(exp) - SNAP.asOfMs) / (365 * 86_400_000);
    for (let i = -6; i <= 6; i++) {
      const K = Math.round(spot * (1 + i * 0.05) * 2) / 2;
      for (const right of ["C", "P"] as const) {
        const px = bsmPrice({ S: spot, K, T, r: RATE, q: 0, sigma: SIGMA, right });
        const osi = `${root.padEnd(6, " ")}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${right}${String(Math.round(K * 1000)).padStart(8, "0")}`;
        const iso = "2026-11-13T20:44:30.000000000Z";
        out.push({ ts_recv: iso, hd: { ts_event: iso, rtype: 177, publisher_id: 20, instrument_id: id++ }, symbol: osi, levels: [{ bid_px: (px * 0.99).toFixed(4), ask_px: (px * 1.01).toFixed(4), bid_sz: 10, ask_sz: 10 }] });
      }
    }
  }
  return out;
}

function synthMarket(spot: number): Market {
  return { daily: [{ date: "2026-11-13", open: spot, high: spot, low: spot, close: spot, adj: spot, volume: 1e6 }], minuteSpot: spot, spy: [], vix: 0.193, rate: RATE, dividends: [] };
}

test("computeChain recovers the volatility the chain was priced at (engine surface.ts and cards.ts)", () => {
  const chain = computeChain("SOUN", SNAP, chainRecords("SOUN", 10), synthMarket(10), 0.0004);
  assert.ok(Math.abs(chain.block.atmIv - 60) <= 1.5, `ATM IV ${chain.block.atmIv}`);
  assert.equal(chain.spot, 10);
  assert.equal(chain.term.length, 4);
  assert.ok(chain.contracts.length >= 80);
  assert.ok(chain.block.impliedMove5 && chain.block.impliedMove5.rawPct > 0);
  assert.equal(chain.block.vix, 19.3);
  const s = surfaceOutput(chain)!;
  assert.ok(s.grid.z.flat().filter((v) => v !== null).every((v) => Math.abs(v! - 60) < 3));
  assert.throws(() => computeChain("SOUN", SNAP, chainRecords("SOUN", 10).slice(0, 10), synthMarket(10), 0), /too thin/);
  assert.throws(() => computeChain("SOUN", SNAP, [], synthMarket(10), 0), /no option quotes/);
});

/* ------------------------------------------------------------------ the tool, end to end (mocked fetch) */

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
const saved = { ...process.env };
let calls: Array<{ url: string; method: string; body: string }> = [];

function mockFetch(routes: [RegExp, Handler][]) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A Yahoo daily chart of 260 weekdays to 2026-11-13 with a wiggle (so beta has variance). */
function dailyChart(base: number, wiggle: number) {
  const ts: number[] = [];
  const close: number[] = [];
  let d = Date.parse("2026-11-13T14:30:00Z");
  for (let i = 0; ts.length < 260; i++, d -= 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    ts.unshift(d / 1000);
  }
  ts.forEach((_, i) => close.push(i === ts.length - 1 ? base : base * (1 + wiggle * Math.sin(i * 1.7))));
  return { chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: ts, indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1e6) }], adjclose: [{ adjclose: close }] } }] } };
}
const minuteChart = (spot: number) => ({ chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: [Date.parse("2026-11-13T20:43:00Z") / 1000, Date.parse("2026-11-13T20:44:00Z") / 1000], indicators: { quote: [{ close: [spot * 1.001, spot] }] } }] } });

// Monday 2026-11-16 14:00 New York; Databento's OPRA range ends at today's open.
const NOW = Date.parse("2026-11-16T19:00:00Z");

/** Synthetic open interest (statistics, two exchanges each) and volume (ohlcv-1d, two exchanges each) for SOUN. */
function pcRecords(schema: string): Array<Record<string, unknown>> {
  const osi = (exp: string, right: "C" | "P", k: number) => `SOUN  ${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${right}${String(k * 1000).padStart(8, "0")}`;
  const contracts: Array<[string, "C" | "P", number, number, number]> = [
    // expiration, right, strike, open interest, volume
    ["2026-11-20", "C", 10, 5000, 300],
    ["2026-11-20", "P", 10, 2000, 150],
    ["2026-12-18", "C", 12, 9000, 600],
    ["2026-12-18", "P", 8, 6000, 210],
  ];
  const out: Array<Record<string, unknown>> = [];
  contracts.forEach(([exp, right, k, oi, vol], i) => {
    for (const pub of [20, 21]) {
      if (schema === "statistics") out.push({ ts_recv: "2026-11-16T11:30:00.5Z", hd: { ts_event: "2026-11-16T11:30:00.5Z", rtype: 24, publisher_id: pub, instrument_id: 5000 + i }, price: null, quantity: oi, stat_type: 9, symbol: osi(exp, right, k) });
      else out.push({ hd: { ts_event: "2026-11-13T00:00:00Z", rtype: 35, publisher_id: pub, instrument_id: 5000 + i }, open: "1", high: "1", low: "1", close: "1", volume: String(vol / 2), symbol: osi(exp, right, k) });
    }
  });
  return out;
}

type Costs = { cbbo: number; statistics?: number; ohlcv?: number; oiNarrow?: number };
const schemaOf = (url: string, init?: RequestInit) => new URLSearchParams(typeof init?.body === "string" ? init.body : url.split("?")[1] ?? "").get("schema");

function routes(opts: { store: StoreRow[]; cost: number | Costs }): [RegExp, Handler][] {
  const costs: Costs = typeof opts.cost === "number" ? { cbbo: opts.cost, statistics: opts.cost, ohlcv: opts.cost } : opts.cost;
  return [
    [/sb\.test\/rest\/v1\/options_daily/, () => json(opts.store)],
    [/sb\.test\/rest\/v1\/options_spend\?select/, () => json([{ caller: "desk-iv", cost_usd: 0.5 }, { caller: "options-daily", cost_usd: 20 }], 200, { "content-range": "0-1/2" })],
    [/sb\.test\/rest\/v1\/options_spend\?on_conflict/, () => new Response(null, { status: 201 })],
    [/metadata\.get_dataset_range/, () => json({ end: "2026-11-16T14:30:00Z", schema: { "cbbo-1m": { end: "2026-11-16T14:30:00Z" }, statistics: { end: "2026-11-16T14:30:00Z" }, "ohlcv-1d": { end: "2026-11-14T00:00:00Z" } } })],
    [/metadata\.get_cost/, (url) => json(schemaOf(url) === "statistics" ? (/T11%3A29%3A30/.test(url) ? costs.oiNarrow ?? costs.statistics : costs.statistics) ?? 0 : schemaOf(url) === "ohlcv-1d" ? costs.ohlcv ?? 0 : costs.cbbo)],
    [/timeseries\.get_range/, (url, init) => new Response((schemaOf(url, init) === "cbbo-1m" ? chainRecords("SOUN", 10) : pcRecords(schemaOf(url, init)!)).map((r) => JSON.stringify(r)).join("\n"))],
    [/chart\/(SOUN|AAPL)\?range=1y/, () => json(dailyChart(10, 0.02))],
    [/chart\/(SOUN|AAPL)\?range=5d&interval=1m/, () => json(minuteChart(10))],
    [/chart\/SPY\?/, () => json(dailyChart(600, 0.01))],
    [/chart\/%5EVIX\?/, () => json(dailyChart(19.3, 0.05))],
    [/chart\/%5EIRX\?/, () => json(dailyChart(3.9, 0))],
  ];
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.DATABENTO_API_KEY = "db-test-key";
  process.env.OPTIONS_DISPLAY = "all";
  delete process.env.DESK_IV_MAX_PULL_USD;
  delete process.env.DESK_IV_MONTH_CAP_USD;
  resetIv();
  resetYahoo();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

const storedRow: StoreRow = { as_of: "2026-11-13", skip: null, block: block(21.9), ivPct: null, term: [["2026-11-20", 7.01, 0.2168], ["2026-12-18", 35.01, 0.22085]] };

test("ivTool: a current stored row is free (nothing priced or bought) beyond the summary's put/call", async () => {
  mockFetch(routes({ store: [storedRow], cost: 0.005 }));
  const term = (await ivTool({ ticker: "AAPL", detail: "term" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(term.data, "stored (free)");
  assert.equal(term.putCall, undefined);
  assert.ok(!calls.some((c) => /get_cost|get_range|options_spend/.test(c.url)));
  const out = (await ivTool({ ticker: "AAPL" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(out.data, "stored (free)");
  assert.equal(out.atmIv30Pct, 21.9);
  assert.ok(!calls.some((c) => /get_range/.test(c.url) && schemaOf(c.url, { body: c.body }) === "cbbo-1m"), "no chain bought");
});

test("ivTool: a stored row's summary buys only the put/call pieces, within one per-pull limit, once", async () => {
  // AAPL-like: open interest $0.043 fits, volume $0.345 does not.
  mockFetch(routes({ store: [{ ...storedRow, as_of: "2026-11-13" }], cost: { cbbo: 0.005, statistics: 0.043, ohlcv: 0.345 } }));
  const out = (await ivTool({ ticker: "SOUN" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(out.data, "stored (free)");
  const pc = out.putCall as { volume: unknown; openInterest: { asOf: string; calls: number; puts: number; ratio: number; largest: unknown[] }; data: string; notes: string[]; meaning: string };
  assert.equal(pc.volume, null);
  assert.equal(pc.openInterest.asOf, "2026-11-16 pre-open (positions after the 2026-11-13 close)");
  assert.deepEqual([pc.openInterest.calls, pc.openInterest.puts, pc.openInterest.ratio], [14000, 8000, 0.57]);
  assert.deepEqual(pc.openInterest.largest[0], ["2026-12-18", 12, "C", 9000]);
  assert.equal(pc.data, "on demand, $0.0430");
  assert.ok(pc.notes.some((n) => /Put\/call volume not bought: it would cost \$0\.34 of OPRA data \(\$0\.39 with the rest of this pull\), over the \$0\.25 limit/.test(n)), JSON.stringify(pc.notes));
  const writes = calls.filter((c) => /options_spend\?on_conflict/.test(c.url));
  assert.equal(writes.length, 1);
  const lines = JSON.parse(writes[0]!.body);
  assert.deepEqual(lines.map((l: { schema: string; caller: string; cost_usd: number }) => [l.schema, l.caller, l.cost_usd]), [["statistics", "desk-iv", 0.043]]);
  const pulls = calls.filter((c) => /get_range/.test(c.url)).map((c) => schemaOf(c.url, { body: c.body }));
  assert.deepEqual(pulls, ["statistics"]);
  // Again: open interest is cached (not bought twice).
  calls = [];
  const again = (await ivTool({ ticker: "SOUN" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal((again.putCall as { data: string }).data, "on demand (already bought, free)");
  assert.equal(calls.filter((c) => /get_range/.test(c.url)).length, 0);
});

test("ivTool: open interest falls back to the whole pre-open when the 06:30 window is empty", async () => {
  mockFetch(routes({ store: [storedRow], cost: { cbbo: 0.005, statistics: 0.04, ohlcv: 0.01, oiNarrow: 0 } }));
  const out = (await ivTool({ ticker: "SOUN" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal((out.putCall as { openInterest: { ratio: number } }).openInterest.ratio, 0.57);
  const line = JSON.parse(calls.find((c) => /options_spend\?on_conflict/.test(c.url))!.body).find((l: { schema: string }) => l.schema === "statistics");
  assert.deepEqual([line.start_at, line.end_at], ["2026-11-16T05:00:00.000Z", "2026-11-16T14:30:00.000Z"]);
});

test("ivTool: a name outside the store buys chain, open interest and volume in one pull and one ledger write", async () => {
  mockFetch(routes({ store: [], cost: { cbbo: 0.0004, statistics: 0.005, ohlcv: 0.035 } }));
  const out = (await ivTool({ ticker: "SOUN" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(out.data, "on demand, $0.0004");
  const pc = out.putCall as { volume: { session: string; calls: number; puts: number; ratio: number }; openInterest: { ratio: number }; data: string };
  assert.deepEqual(pc.volume, { session: "2026-11-13", calls: 900, puts: 360, ratio: 0.4 });
  assert.equal(pc.openInterest.ratio, 0.57);
  assert.equal(pc.data, "on demand, $0.0400");
  const writes = calls.filter((c) => /options_spend\?on_conflict/.test(c.url));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]!.body).map((l: { schema: string }) => l.schema), ["cbbo-1m", "statistics", "ohlcv-1d"]);
  const first = calls.findIndex((c) => /get_range/.test(c.url));
  assert.ok(first > calls.indexOf(writes[0]!), "charged before any download");
});

test("ivTool: a ticker outside the store is priced, charged in the ledger first, then bought once", async () => {
  mockFetch(routes({ store: [], cost: 0.0004 }));
  const out = (await ivTool({ ticker: "SOUN", detail: "surface" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(out.data, "on demand, $0.0004");
  assert.equal(out.snapshot, "2026-11-13 15:45 ET");
  assert.ok(Math.abs((out.atmIv30Pct as number) - 60) <= 1.5);
  assert.ok((out.surface as { grid: { y: number[] } }).grid.y.length >= 3);
  const charge = calls.findIndex((c) => /options_spend\?on_conflict/.test(c.url));
  const pull = calls.findIndex((c) => /get_range/.test(c.url));
  assert.ok(charge >= 0 && pull > charge, "charge written before the download");
  const line = JSON.parse(calls[charge]!.body)[0];
  assert.equal(line.caller, "desk-iv");
  assert.equal(line.cost_usd, 0.0004);
  assert.equal(line.kind, "charge");
  // The same snapshot again: cached, not bought twice.
  const again = (await ivTool({ ticker: "SOUN", detail: "smile" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(again.data, "on demand (already bought, free)");
  assert.equal(calls.filter((c) => /get_range/.test(c.url)).length, 1);
  assert.equal((again.smile as { expiration: string }).expiration, "2026-12-18");
});

test("ivTool: a pull over the cap is refused before anything is bought", async () => {
  mockFetch(routes({ store: [], cost: 0.5 }));
  await assert.rejects(ivTool({ ticker: "SOUN" }, { admin: false, now: () => NOW }), /over the \$0\.25 limit/);
  assert.ok(!calls.some((c) => /get_range|options_spend\?on_conflict/.test(c.url)));
  // With a stored row the answer falls back to it and says why.
  mockFetch(routes({ store: [storedRow], cost: 0.5 }));
  const out = (await ivTool({ ticker: "AAPL", detail: "surface" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(out.data, "stored (free)");
  assert.ok((out.notes as string[]).some((n) => /No surface: No fresh options snapshot was bought: this chain alone is priced at \$0\.50/.test(n)), JSON.stringify(out.notes));
});

test("ivTool: the caller's month cap", async () => {
  process.env.DESK_IV_MONTH_CAP_USD = "0.5";
  mockFetch(routes({ store: [], cost: 0.01 }));
  await assert.rejects(ivTool({ ticker: "SOUN" }, { admin: false, now: () => NOW }), /monthly budget for on-demand options data \(\$0\.50\)/);
  assert.ok(!calls.some((c) => /get_range/.test(c.url)));
});

test("ivTool: OPTIONS_DISPLAY is respected (admin mode needs the founder admin session)", async () => {
  mockFetch(routes({ store: [storedRow], cost: 0.005 }));
  process.env.OPTIONS_DISPLAY = "off";
  await assert.rejects(ivTool({ ticker: "AAPL" }, { admin: true, now: () => NOW }), /not shown/);
  process.env.OPTIONS_DISPLAY = "admin";
  await assert.rejects(ivTool({ ticker: "AAPL" }, { admin: false, now: () => NOW }), /not shown/);
  assert.equal(calls.length, 0);
  const out = (await ivTool({ ticker: "AAPL" }, { admin: true, now: () => NOW })) as Record<string, unknown>;
  assert.equal(out.atmIv30Pct, 21.9);
});

test("ivTool: a chain stored as too thin is not bought again", async () => {
  mockFetch(routes({ store: [{ as_of: "2026-11-13", skip: "poor chain: only 9 contracts with an IV", block: null, ivPct: null, term: null }], cost: 0.001 }));
  await assert.rejects(ivTool({ ticker: "ABCD" }, { admin: false, now: () => NOW }), /too thin to read on 2026-11-13/);
  assert.ok(!calls.some((c) => /get_cost|get_range/.test(c.url)));
});

// Keep the LiveChain type exercised (shape used by the route's tests elsewhere).
export type _LiveChain = LiveChain;
