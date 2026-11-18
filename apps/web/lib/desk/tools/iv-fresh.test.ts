// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/iv-fresh.test.ts
// Freshness of falcon_options and the Yahoo same-day fallback (iv-fresh.ts, iv.ts). Supabase and Yahoo are answered
// by a mocked fetch; the option chain is synthetic (Black-Scholes prices at a known volatility).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { bsmPrice } from "../../../../../packages/engine/src/options/math.ts";
import { expiryInstantMs } from "../../../../../packages/engine/src/options/surface.ts";
import { currentSession, earningsFromEpoch, earningsSoon, isStale, yahooExpiriesToFetch, yahooInputs, yahooIvCheck } from "./iv-fresh";
import { discountToContinuous, ivTool, resetIv, type StoreRow } from "./iv";
import { resetYahoo, type YahooOptionChain } from "./yahoo";

const ms = (iso: string) => Date.parse(iso);
const epoch = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

/* ------------------------------------------------------------------ the rule */

test("currentSession: the latest NYSE session that has opened", () => {
  // Monday 2026-11-16 14:00 New York: today, open.
  assert.deepEqual(currentSession(ms("2026-11-16T19:00:00Z")), { date: "2026-11-16", openMs: ms("2026-11-16T14:30:00Z"), closeMs: ms("2026-11-16T21:00:00Z"), inSession: true });
  // Monday 08:00, before the open: Friday's session.
  assert.equal(currentSession(ms("2026-11-16T13:00:00Z"))!.date, "2026-11-13");
  // Saturday: Friday, closed.
  assert.equal(currentSession(ms("2026-11-14T15:00:00Z"))!.inSession, false);
  // Thanksgiving: Wednesday's session; the Friday after closes at 13:00.
  assert.equal(currentSession(ms("2026-11-26T17:00:00Z"))!.date, "2026-11-25");
  assert.equal(currentSession(ms("2026-11-27T19:00:00Z"))!.closeMs, ms("2026-11-27T18:00:00Z"));
});

test("isStale: older than the current session's open", () => {
  const mon = currentSession(ms("2026-11-16T19:00:00Z"));
  assert.equal(isStale(ms("2026-11-13T20:45:00Z"), mon), true, "Friday's 15:45 is stale on Monday afternoon");
  assert.equal(isStale(ms("2026-11-16T18:45:00Z"), mon), false);
  const pre = currentSession(ms("2026-11-16T13:00:00Z"));
  assert.equal(isStale(ms("2026-11-13T20:45:00Z"), pre), false, "pre-market, Friday's 15:45 is the latest there is");
  assert.equal(isStale(ms("2026-11-12T20:45:00Z"), pre), true);
});

test("earnings within 7 days, with the time of day", () => {
  const now = ms("2026-11-16T19:00:00Z");
  assert.deepEqual(earningsFromEpoch(1794949200, now, "Yahoo"), { date: "2026-11-17", time: "after_close", daysAway: 1, source: "Yahoo" });
  assert.equal(earningsFromEpoch(ms("2026-11-19T13:30:00Z") / 1000, now, "Yahoo")!.time, "before_open");
  assert.equal(earningsFromEpoch(ms("2026-11-30T21:00:00Z") / 1000, now, "Yahoo"), null, "14 days away");
  assert.equal(earningsSoon("2026-11-13", "after_close", now, "x"), null, "already past");
  assert.equal(earningsSoon("2026-11-23", "unknown", now, "x")!.daysAway, 7);
});

test("yahooExpiriesToFetch: the summary's expiries, every one for the full views, the asked smile expiry", () => {
  const asOf = ms("2026-11-16T18:45:00Z");
  const days = [0, 2, 4, 7, 14, 21, 28, 35, 49, 63, 91, 98, 126, 182, 217, 245, 364, 399, 455, 763];
  const exps = days.map((d) => epoch(new Date(ms("2026-11-16T00:00:00Z") + d * 86_400_000).toISOString().slice(0, 10)));
  const sum = yahooExpiriesToFetch(exps, asOf, false);
  const d = (e: number) => Math.round((e * 1000 - ms("2026-11-16T00:00:00Z")) / 86_400_000);
  assert.deepEqual(sum.map(d), [2, 4, 7, 14, 21, 28, 35, 49, 63, 91, 98, 126, 182, 364]);
  const full = yahooExpiriesToFetch(exps, asOf, true);
  assert.equal(full.map(d).at(-1), 399);
  assert.ok(!full.map(d).includes(0), "the same-day expiry is useless");
  assert.ok(yahooExpiriesToFetch(exps, asOf, false, "2027-07-15").map(d).includes(245));
});

/* ------------------------------------------------------------------ a synthetic Yahoo chain */

const SIGMA = 0.6;
const RATE = discountToContinuous(3.9);
const SPOT = 10;
const NOW = ms("2026-11-16T19:00:00Z");
/** The option quotes are 15 minutes behind the stock quote. */
const OPT_TIME = ms("2026-11-16T18:45:00Z");
const EXPS = ["2026-11-18", "2026-11-20", "2026-12-18", "2027-01-15", "2027-03-19"];

function chainFor(exp: string): YahooOptionChain {
  const T = (expiryInstantMs(exp) - OPT_TIME) / (365 * 86_400_000);
  const side = (right: "C" | "P") =>
    Array.from({ length: 13 }, (_, k) => {
      const K = Math.round(SPOT * (1 + (k - 6) * 0.05) * 2) / 2;
      const px = bsmPrice({ S: SPOT, K, T, r: RATE, q: 0, sigma: SIGMA, right });
      return { contractSymbol: `SOUN${exp}${right}${K}`, strike: K, bid: px * 0.99, ask: px * 1.01, lastPrice: px, lastTradeDate: OPT_TIME / 1000 - (k === 6 ? 0 : 600), volume: 10, openInterest: 100, impliedVolatility: SIGMA + 0.01, expiration: epoch(exp) };
    });
  return {
    underlyingSymbol: "SOUN",
    expirationDates: EXPS.map(epoch),
    quote: { symbol: "SOUN", regularMarketPrice: SPOT, regularMarketTime: NOW / 1000 - 5, marketState: "REGULAR", exchangeDataDelayedBy: 15, earningsTimestampStart: 1794949200 },
    options: [{ expirationDate: epoch(exp), calls: side("C"), puts: side("P") }],
  };
}

test("yahooInputs: the chain's time is the latest option trade (delayed), one definition and quote per contract", () => {
  const inp = yahooInputs("SOUN", [chainFor("2026-11-20"), chainFor("2026-12-18"), chainFor("2026-12-18")], NOW)!;
  assert.equal(inp.asOfMs, OPT_TIME);
  assert.equal(inp.spot, SPOT);
  assert.equal(inp.definitions.length, 52, "duplicates dropped");
  assert.equal(inp.quotes.size, 52);
  assert.ok([...inp.quotes.values()].every((q) => q.tsMs === OPT_TIME));
  assert.equal(inp.earningsEpoch, 1794949200);
  // No option trade for a while (an illiquid name): the quote time minus the delay.
  const quiet = chainFor("2026-11-20");
  quiet.options![0]!.calls!.forEach((c) => (c.lastTradeDate = OPT_TIME / 1000 - 7200));
  quiet.options![0]!.puts!.forEach((c) => (c.lastTradeDate = OPT_TIME / 1000 - 7200));
  assert.equal(yahooInputs("SOUN", [quiet], NOW)!.asOfMs, NOW - 5_000 - 15 * 60_000);
  assert.equal(yahooInputs("SOUN", [{ expirationDates: [1] }], NOW), null);
  // Yahoo's own IV next to Falcon's.
  const check = yahooIvCheck(inp, SPOT, [{ expiration: "2026-12-18", days: 32, iv: 0.6 }])!;
  assert.equal(check.yahooPct, 61);
  assert.equal(check.diffPts, 1);
});

/* ------------------------------------------------------------------ the tool, end to end */

type Handler = (url: string) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
const saved = { ...process.env };
let calls: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function dailyChart(base: number, wiggle: number, last = "2026-11-16") {
  const ts: number[] = [];
  for (let d = ms(`${last}T14:30:00Z`); ts.length < 260; d -= 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) ts.unshift(d / 1000);
  }
  const close = ts.map((_, i) => (i === ts.length - 1 ? base : base * (1 + wiggle * Math.sin(i * 1.7))));
  return { chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: ts, indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1e6) }], adjclose: [{ adjclose: close }] } }] } };
}
const minuteChart = { chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: [ms("2026-11-16T18:43:00Z") / 1000, ms("2026-11-16T18:44:00Z") / 1000], indicators: { quote: [{ close: [SPOT * 1.001, SPOT] }] } }] } };

const stored: StoreRow = {
  as_of: "2026-11-13",
  skip: null,
  block: { asOf: "2026-11-13T20:45:00.000Z", source: "OPRA via Databento", spot: 9.5, atmIv: 55, impliedMove5: null, impliedMove20: null, skew: 1, cpSpread: 0, beta: 1.5, vix: 19 },
  ivPct: null,
  term: [["2026-11-20", 7, 0.55]],
};

function mock(opts: { yahooOptions: boolean }) {
  calls = [];
  const routes: Array<[RegExp, Handler]> = [
    [/sb\.test\/rest\/v1\/options_daily/, () => json([stored])],
    [/fc\.yahoo\.com/, () => new Response("", { status: 404 })],
    [/getcrumb/, () => new Response("crumb123")],
    [/v7\/finance\/options\/SOUN/, (url) => {
      if (!opts.yahooOptions) return new Response("busy", { status: 500 });
      const d = /[?&]date=(\d+)/.exec(url)?.[1];
      return json({ optionChain: { result: [chainFor(d ? new Date(Number(d) * 1000).toISOString().slice(0, 10) : EXPS[0]!)] } });
    }],
    [/quoteSummary\/SOUN\?modules=calendarEvents/, () => json({ quoteSummary: { result: [{ calendarEvents: { earnings: { earningsDate: [{ raw: 1794949200 }], isEarningsDateEstimate: false } } }] } })],
    [/chart\/SOUN\?range=1y/, () => json(dailyChart(SPOT, 0.02))],
    [/chart\/SOUN\?range=5d&interval=1m/, () => json(minuteChart)],
    [/chart\/SPY\?/, () => json(dailyChart(600, 0.01))],
    [/chart\/%5EVIX\?/, () => json(dailyChart(19.3, 0.05))],
    [/chart\/%5EIRX\?/, () => json(dailyChart(3.9, 0))],
  ];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    for (const [re, fn] of routes) if (re.test(url)) return fn(url);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  delete process.env.DATABENTO_API_KEY; // Databento cannot serve today without a live licence: only Yahoo can
  process.env.OPTIONS_DISPLAY = "all";
  resetIv();
  resetYahoo();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

test("ivTool, in session: today's Yahoo chain, computed by Falcon, with as_of, source, sources and the pre-earnings straddle", async () => {
  mock({ yahooOptions: true });
  const out = (await ivTool({ ticker: "SOUN" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(out.stale, false);
  assert.equal(out.as_of, "2026-11-16T18:45:00.000Z");
  assert.equal(out.snapshot, "2026-11-16 13:45 ET");
  assert.match(String(out.source), /^Yahoo Finance options chain \(delayed ~15 min\): Falcon computed every figure/);
  assert.ok(Math.abs((out.atmIv30Pct as number) - 60) <= 2, `ATM IV ${out.atmIv30Pct}`);
  const f = out.freshness as Record<string, unknown>;
  assert.equal(f.currentSession, "2026-11-16");
  assert.equal(f.ageMinutes, 15);
  const e = out.earnings as { date: string; time: string; straddle: Record<string, number | string> };
  assert.equal(e.date, "2026-11-17");
  assert.equal(e.time, "after_close");
  assert.equal(e.straddle.expiry, "2026-11-18", "the first expiry covering the 11-18 reaction");
  assert.equal(e.straddle.strike, 10);
  assert.ok(Math.abs((e.straddle.implied_move as number) - ((e.straddle.call_mid as number) + (e.straddle.put_mid as number)) / (e.straddle.spot as number)) < 1e-5);
  const sources = out.sources as Array<Record<string, string>>;
  assert.deepEqual(sources.map((s) => s.group), ["options", "market", "ivStanding", "earningsStraddle"]);
  assert.equal(sources[0]!.as_of, "2026-11-16T18:45:00.000Z");
  assert.equal(sources[0]!.url, "https://finance.yahoo.com/quote/SOUN/options");
  assert.ok(sources.every((s) => s.dataset && s.fetched_at));
  assert.ok(Math.abs((out.yahooIvCheck as { diffPts: number }).diffPts - 1) < 2.5);
});

test("ivTool, in session, Yahoo down, earnings tomorrow: Friday's stored row is flagged stale with a plain warning", async () => {
  mock({ yahooOptions: false });
  const out = (await ivTool({ ticker: "SOUN" }, { admin: false, now: () => NOW })) as Record<string, unknown>;
  assert.equal(out.stale, true);
  assert.equal(out.as_of, "2026-11-13T20:45:00.000Z");
  const warning = String((out.freshness as Record<string, unknown>).warning);
  assert.match(warning, /SOUN reports earnings on 2026-11-17 \(in 1 day\) and these options figures are from 2026-11-13 15:45 ET, before the 2026-11-16 open/);
  assert.match(warning, /Yahoo's delayed chain failed/);
  assert.equal((out.notes as string[])[0], warning);
});

test("ivTool, pre-market: Friday's stored 15:45 is current, Yahoo's chain is not read", async () => {
  mock({ yahooOptions: true });
  const out = (await ivTool({ ticker: "SOUN" }, { admin: false, now: () => ms("2026-11-16T13:00:00Z") })) as Record<string, unknown>;
  assert.equal(out.stale, false);
  assert.equal(out.data, "stored (free)");
  assert.ok(!calls.some((u) => /finance\/options/.test(u)));
});
