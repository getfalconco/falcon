// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/iv-history.test.ts
// Supabase, Databento and Yahoo are answered by a mocked fetch; nothing leaves the machine.
// Option quotes are synthetic (Black-Scholes prices at a known volatility per session), never Databento data.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { bsmPrice } from "../../../../../packages/engine/src/options/math.ts";
import { expiryInstantMs } from "../../../../../packages/engine/src/options/surface.ts";
import { nyInstantMs } from "../../../../../packages/engine/src/study/abnormal.ts";
import { normalizeChart } from "../chart-spec";
import {
  OPRA_HISTORY_START,
  computePoint,
  dayInputs,
  HEDGE_AFTER_MS,
  RECORDS_PER_CONTRACT,
  USD_PER_RECORD,
  fitToCap,
  hedged,
  historyDates,
  historyExpiries,
  historyRequest,
  historyStrikes,
  osiSymbol,
  historySettled,
  maxCostUsd,
  resetHistory,
  servedCostUsd,
  shapeHistory,
  strikeStep,
  thirdFriday,
} from "./iv-history";
import { discountToContinuous, ivTool, resetIv, snapshotMinute } from "./iv";
import { ToolPending } from "./util";
import { resetYahoo, type ChartResult } from "./yahoo";

/* ------------------------------------------------------------------ sampling */

test("historyDates: daily up to 3 months, weekly for a year, about 130 points since 2013", () => {
  const m3 = historyDates("3m", "2026-11-13");
  assert.equal(m3.step, 1);
  assert.ok(m3.dates.length >= 60 && m3.dates.length <= 67, `${m3.dates.length}`);
  assert.equal(m3.dates[m3.dates.length - 1], "2026-11-13");
  const y1 = historyDates("1y", "2026-11-13");
  assert.equal(y1.step, 5);
  assert.ok(y1.dates.length >= 50 && y1.dates.length <= 52, `${y1.dates.length}`);
  assert.equal(y1.dates[y1.dates.length - 1], "2026-11-13");
  assert.ok(y1.dates.every((d, i) => i === 0 || d > y1.dates[i - 1]!));
  const max = historyDates("max", "2026-11-13");
  assert.ok(max.step >= 25 && max.dates.length <= 130, `${max.step} ${max.dates.length}`);
  assert.ok(max.dates[0]! >= OPRA_HISTORY_START);
  assert.equal(max.dates[max.dates.length - 1], "2026-11-13");
});

test("historyExpiries: Fridays either side of 30 days, the monthlies, a holiday Friday moves to Thursday", () => {
  assert.equal(thirdFriday("2026-11-05"), "2026-11-20");
  assert.equal(thirdFriday("2026-05-30"), "2026-05-15");
  assert.deepEqual(historyExpiries("2026-11-13"), ["2026-11-20", "2026-12-11", "2026-12-18"]);
  // 30 days after 2026-03-04 is Good Friday 2026-04-03 (market closed): that week's expiry is Thursday.
  assert.ok(historyExpiries("2026-03-04").includes("2026-04-02"));
  assert.ok(!historyExpiries("2026-03-04").includes("2026-04-03"));
  // Every expiry is at least a week out.
  for (const d of ["2026-11-19", "2024-06-14", "2014-01-02"]) assert.ok(historyExpiries(d).every((e) => e >= d && (Date.parse(e) - Date.parse(d)) / 86_400_000 >= 7));
});

test("strikes and symbols: grid by price, band 93% to 105%, OSI format", () => {
  assert.equal(strikeStep(12), 0.5);
  assert.equal(strikeStep(272), 0.5);
  assert.equal(strikeStep(672), 1);
  assert.equal(strikeStep(5000), 10);
  const ks = historyStrikes(100);
  assert.equal(ks[0], 93);
  assert.equal(ks[ks.length - 1], 105);
  assert.equal(ks.length, 25);
  assert.equal(osiSymbol("AAPL", "2026-12-18", "C", 272.5), "AAPL  261218C00272500");
  assert.equal(osiSymbol("BRKB", "2026-12-18", "P", 480), "BRKB  261218P00480000");
  const r = historyRequest("BRK-B", "2026-11-13", 480);
  assert.equal(r.stype_in, "raw_symbol");
  assert.equal(r.start, "2026-11-13T20:40:00.000Z");
  assert.equal(r.end, "2026-11-13T20:46:00.000Z");
  assert.ok(r.symbols.length <= 2000 && r.symbols.every((s) => s.startsWith("BRKB  ")));
  // Early close (day after Thanksgiving): 12:45.
  assert.equal(historyRequest("AAPL", "2026-11-27", 270).start, "2026-11-27T17:40:00.000Z");
});

test("fitToCap keeps the newest points within the limit", () => {
  const pts = ["2026-01-02", "2026-01-09", "2026-01-16", "2026-01-23"].map((date) => ({ date, costUsd: 0.2 }));
  const f = fitToCap(pts, 0.5);
  assert.deepEqual(f.buy.map((p) => p.date), ["2026-01-16", "2026-01-23"]);
  assert.equal(f.dropped, 2);
  assert.ok(Math.abs(f.totalUsd - 0.4) < 1e-9);
  assert.equal(fitToCap(pts, 1).dropped, 0);
});

test("dayInputs undoes later splits (strikes trade in the prices of the day) and reads the bill rate", () => {
  const day = (d: string) => Date.parse(`${d}T14:30:00Z`) / 1000;
  const c = {
    meta: { gmtoffset: -18000 },
    timestamp: [day("2020-08-28"), day("2020-08-31"), day("2020-09-01")],
    indicators: { quote: [{ close: [125, 129, 134] }] },
    events: { splits: { x: { date: day("2020-08-31"), numerator: 4, denominator: 1 } }, dividends: { y: { date: day("2020-08-07"), amount: 0.205 } } },
  } as unknown as ChartResult;
  const irx = { meta: { gmtoffset: -18000 }, timestamp: [day("2020-08-27")], indicators: { quote: [{ close: [0.1] }] } } as unknown as ChartResult;
  const m = dayInputs(c, irx);
  assert.equal(m.get("2020-08-28")!.close, 500);
  assert.equal(m.get("2020-08-28")!.adjClose, 125);
  assert.equal(m.get("2020-08-31")!.close, 129);
  assert.ok(Math.abs(m.get("2020-09-01")!.rate - discountToContinuous(0.1)) < 1e-12);
  assert.equal(m.get("2020-09-01")!.dividends.length, 1);
});

/* ------------------------------------------------------------------ synthetic quotes */

const IRX_PCT = 3.9;
const RATE = discountToContinuous(IRX_PCT);
const SPOT = 50;
/** The volatility each session is priced at: a slow wave between 25% and 45%. */
const sigmaOn = (date: string) => 0.35 + 0.1 * Math.sin(Date.parse(date) / (86_400_000 * 40));

/** cbbo-1m records for the requested OSI symbols at a session's snapshot, priced at sigmaOn(date). */
function quotesFor(symbols: string[], date: string, spot = SPOT): string {
  const asOfMs = nyInstantMs(date, snapshotMinute(date));
  const iso = new Date(asOfMs - 30_000).toISOString();
  let id = 1;
  const out: string[] = [];
  for (const sym of symbols) {
    const m = /^(.{6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym)!;
    const exp = `20${m[2]}-${m[3]}-${m[4]}`;
    const K = Number(m[6]) / 1000;
    const right = m[5] as "C" | "P";
    // A grid of $1 strikes only, as a $50 stock lists: the half-dollar candidates do not exist (cost nothing, no records).
    if (!Number.isInteger(K)) continue;
    const T = (expiryInstantMs(exp) - asOfMs) / (365 * 86_400_000);
    const px = bsmPrice({ S: spot, K, T, r: RATE, q: 0, sigma: sigmaOn(date), right });
    out.push(JSON.stringify({ ts_recv: iso, hd: { ts_event: iso, rtype: 177, publisher_id: 20, instrument_id: id++ }, symbol: sym, levels: [{ bid_px: (px * 0.995).toFixed(4), ask_px: (px * 1.005).toFixed(4), bid_sz: 10, ask_sz: 10 }] }));
  }
  return out.join("\n");
}

test("computePoint recovers the volatility a session was priced at (engine surface.ts and cards.ts)", () => {
  const date = "2026-06-10";
  const req = historyRequest("SOUN", date, SPOT);
  const records = quotesFor(req.symbols, date).split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const p = computePoint("SOUN", date, records, { close: SPOT, adjClose: SPOT, rate: RATE, dividends: [] })!;
  assert.ok(Math.abs(p.atmIv - sigmaOn(date) * 100) <= 1, `${p.atmIv} vs ${sigmaOn(date) * 100}`);
  assert.ok(p.move20 !== null && p.move20 > 0);
  assert.ok(p.skew !== null && Math.abs(p.skew) < 0.5, `${p.skew}`); // a flat smile has no put skew
  // The close is 2% off the quotes: the parity spot corrects it.
  const q = computePoint("SOUN", date, records, { close: SPOT * 1.02, adjClose: SPOT * 1.02, rate: RATE, dividends: [] })!;
  assert.ok(Math.abs(q.spot - SPOT) < 0.2, `${q.spot}`);
  assert.equal(computePoint("SOUN", date, [], { close: SPOT, adjClose: SPOT, rate: RATE, dividends: [] }), null);
});

test("shapeHistory: chart for show_chart, percentile and rank from the series", () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ date: `2026-0${1 + Math.floor(i / 10)}-${String(1 + (i % 10)).padStart(2, "0")}`, atmIv: 20 + i, skew: 2, move20: 5, spot: 10 }));
  points.push({ date: "2026-04-01", atmIv: 35, skew: 3, move20: 6, spot: 11 });
  const out = shapeHistory({ ticker: "SOUN", range: "1y", step: 5, asked: 33, points, costUsd: 0.0123, fromCache: 0, notes: [] });
  assert.equal(out.points, 31);
  assert.equal(out.current.atmIv30Pct, 35);
  assert.equal(out.ivStanding.percentile, 52); // 15 below, 1 equal of 30: 15.5 / 30
  assert.equal(out.ivStanding.rank, 52); // (35 - 20) / (49 - 20)
  assert.match(out.notes!.join(" "), /2 of 33 sampled sessions/);
  assert.equal(out.data, "on demand, $0.0123");
  const spec = normalizeChart(out.chart);
  assert.ok(spec.ok, spec.ok ? "" : spec.error);
  assert.throws(() => shapeHistory({ ticker: "SOUN", range: "1y", step: 5, asked: 3, points: [], costUsd: 0, fromCache: 0, notes: [] }), /No usable ATM IV/);
});

/* ------------------------------------------------------------------ the tool, end to end (mocked fetch) */

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
const saved = { ...process.env };
let calls: Array<{ url: string; body: string }> = [];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const params = (url: string, init?: RequestInit) => new URLSearchParams(typeof init?.body === "string" ? init.body : url.split("?")[1] ?? "");
const dateOf = (p: URLSearchParams) => new Date(Date.parse(p.get("start")!) - 5 * 3_600_000).toISOString().slice(0, 10);

/** Two years of weekday closes at SPOT to 2026-11-13. */
function dailyChart(close: number) {
  const ts: number[] = [];
  for (let d = Date.parse("2026-11-13T14:30:00Z"); d > Date.parse("2024-10-01T00:00:00Z"); d -= 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) ts.unshift(d / 1000);
  }
  return { chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: ts, indicators: { quote: [{ close: ts.map(() => close) }] } }] } };
}

/** Symbols the synthetic chain lists (integer strikes): one record each in quotesFor. */
const listed = (symbols: string[]) => symbols.filter((s) => Number(s.slice(-8)) % 1000 === 0).length;

function mockFetch(o: { month?: { deskIv: number; total: number }; refuse?: (date: string) => boolean; delayMs?: number } = {}) {
  calls = [];
  const month = o.month ?? { deskIv: 0.5, total: 20 };
  const routes: Array<[RegExp, Handler]> = [
    [/sb\.test\/rest\/v1\/options_daily/, () => json([])],
    [/sb\.test\/rest\/v1\/options_spend\?select/, () => json([{ caller: "desk-iv", cost_usd: month.deskIv }, { caller: "options-daily", cost_usd: month.total - month.deskIv }], 200, { "content-range": "0-1/2" })],
    [/sb\.test\/rest\/v1\/options_spend\?on_conflict/, () => new Response(null, { status: 201 })],
    [/metadata\.get_dataset_range/, () => json({ end: "2026-11-16T14:30:00Z", schema: { "cbbo-1m": { end: "2026-11-16T14:30:00Z" } } })],
    [/metadata\.get_cost/, (url, init) => json(listed(params(url, init).get("symbols")!.split(",")) * USD_PER_RECORD)],
    [
      /timeseries\.get_range/,
      (url, init) => {
        const p = params(url, init);
        const date = dateOf(p);
        if (o.refuse?.(date)) return json({ detail: "refused" }, 403);
        const body = quotesFor(p.get("symbols")!.split(","), date);
        return o.delayMs ? new Promise<Response>((r) => setTimeout(() => r(new Response(body)), o.delayMs)) : new Response(body);
      },
    ],
    [/chart\/SOUN\?range=/, () => json(dailyChart(SPOT))],
    [/chart\/%5EIRX\?range=/, () => json(dailyChart(IRX_PCT))],
  ];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

// Monday 2026-11-16 14:00 New York; Databento's OPRA range ends at today's open.
const NOW = Date.parse("2026-11-16T19:00:00Z");
const run = (input: Record<string, unknown>) => ivTool({ ticker: "SOUN", detail: "history", ...input }, { admin: false, now: () => NOW, timeoutMs: 60_000 }) as Promise<ReturnType<typeof shapeHistory>>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.DATABENTO_API_KEY = "db-test-key";
  process.env.OPTIONS_DISPLAY = "all";
  delete process.env.DESK_IV_MAX_HISTORY_USD;
  delete process.env.DESK_IV_MONTH_CAP_USD;
  resetIv();
  resetHistory();
  resetYahoo();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

const ledgerLines = () => calls.filter((c) => /options_spend\?on_conflict/.test(c.url)).flatMap((c) => JSON.parse(c.body) as Array<{ caller: string; kind: string; cost_usd: number; schema: string }>);
const rangeCalls = () => calls.filter((c) => /get_range/.test(c.url)).map((c) => params(c.url, { body: c.body }));

test("history 1y: one ledger charge at most before any download, settled to what was served, IVs recovered, bought once", async () => {
  mockFetch();
  const out = await run({ range: "1y" });
  await historySettled();
  assert.ok(out.points >= 50, `${out.points}`);
  assert.equal(out.sampling, "weekly (every 5th session)");
  assert.equal(out.to, "2026-11-13");
  for (const [date, iv] of out.chart.series[0]!.points as Array<[string, number]>) assert.ok(Math.abs(iv - sigmaOn(date) * 100) <= 1.5, `${date}: ${iv} vs ${sigmaOn(date) * 100}`);
  assert.ok(out.ivStanding.percentile !== null && out.ivStanding.rank !== null);
  // Nothing priced point by point: one get_cost (the rate check of the newest point).
  assert.equal(calls.filter((c) => /get_cost/.test(c.url)).length, 1);
  const ranges = rangeCalls();
  assert.ok(ranges.every((p) => p.get("stype_in") === "raw_symbol"));
  const symbols = ranges.map((p) => p.get("symbols")!.split(","));
  const most = symbols.reduce((a, s) => a + s.length * RECORDS_PER_CONTRACT * USD_PER_RECORD, 0);
  const served = symbols.reduce((a, s) => a + listed(s) * USD_PER_RECORD, 0);
  const lines = ledgerLines();
  assert.deepEqual(
    lines.map((l) => l.kind),
    ["charge", "refund"],
  );
  assert.ok(lines.every((l) => l.caller === "desk-iv" && l.schema === "cbbo-1m"));
  assert.ok(Math.abs(lines[0]!.cost_usd - most) < 1e-9, `${lines[0]!.cost_usd} vs ${most}`);
  assert.ok(Math.abs(lines[0]!.cost_usd + lines[1]!.cost_usd - served) < 1e-9);
  assert.equal(out.data, `on demand, $${served.toFixed(4)}`);
  const firstRange = calls.findIndex((c) => /get_range/.test(c.url));
  const charge = calls.findIndex((c) => /options_spend\?on_conflict/.test(c.url));
  assert.ok(charge >= 0 && charge < firstRange);

  // Again (and the 3m range, whose weekly sessions are already bought): nothing bought twice.
  calls = [];
  const again = await run({ range: "1y" });
  assert.equal(again.points, out.points);
  assert.ok(!calls.some((c) => /get_cost|get_range|on_conflict/.test(c.url)));
  calls = [];
  const m3 = await run({ range: "3m" });
  assert.equal(m3.sampling, "daily");
  const bought3m = rangeCalls().length;
  assert.ok(bought3m > 0 && bought3m <= m3.points - 10, `${bought3m} of ${m3.points}`);
});

test("history: the per-pull limit (on each point's most) drops the oldest points; month caps refuse before anything is bought", async () => {
  process.env.DESK_IV_MAX_HISTORY_USD = "0.002";
  const { dates } = historyDates("1y", "2026-11-13");
  const fits = fitToCap(
    dates.map((date) => ({ date, costUsd: maxCostUsd(historyRequest("SOUN", date, SPOT)) })),
    0.002,
  ).buy.length;
  assert.ok(fits > 5 && fits < dates.length, `${fits}`);
  mockFetch();
  const out = await run({ range: "1y" });
  assert.equal(out.points, fits);
  assert.equal(out.to, "2026-11-13");
  assert.match(out.notes!.join(" "), /oldest sessions were left out/);

  delete process.env.DESK_IV_MAX_HISTORY_USD;
  resetHistory();
  mockFetch({ month: { deskIv: 9.999, total: 50 } });
  await assert.rejects(run({ range: "1y" }), /monthly budget for on-demand options data/);
  assert.ok(!calls.some((c) => /get_range|on_conflict/.test(c.url)));

  resetHistory();
  mockFetch({ month: { deskIv: 1, total: 109.999 } });
  await assert.rejects(run({ range: "1y" }), /monthly Databento budget/);
  assert.ok(!calls.some((c) => /get_range|on_conflict/.test(c.url)));
});

test("history: a download Databento refuses is not charged (settled out of the ledger) and left out", async () => {
  mockFetch({ refuse: (d) => d === "2026-11-13" });
  const out = await run({ range: "1m" });
  await historySettled();
  assert.notEqual(out.to, "2026-11-13");
  const served = rangeCalls()
    .filter((p) => dateOf(p) !== "2026-11-13")
    .reduce((a, p) => a + listed(p.get("symbols")!.split(",")) * USD_PER_RECORD, 0);
  const lines = ledgerLines();
  assert.deepEqual(
    lines.map((l) => l.kind),
    ["charge", "refund"],
  );
  assert.ok(Math.abs(lines[0]!.cost_usd + lines[1]!.cost_usd - served) < 1e-9);
});

test("history: past the tool's budget it is still loading (ToolPending with progress); asked again it waits on the same pull", async () => {
  mockFetch({ delayMs: 400 });
  const seen: Array<{ loaded: number; total: number }> = [];
  const err = await ivTool({ ticker: "SOUN", detail: "history", range: "1m" }, { admin: false, now: () => NOW, timeoutMs: 200, onProgress: (p) => seen.push(p) }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ToolPending, String(err));
  assert.ok(err.progress.total >= 20 && err.progress.loaded < err.progress.total, JSON.stringify(err.progress));
  const out = (await ivTool({ ticker: "SOUN", detail: "history", range: "1m" }, { admin: false, now: () => NOW, timeoutMs: 60_000, onProgress: (p) => seen.push(p) })) as ReturnType<typeof shapeHistory>;
  await historySettled();
  assert.ok(out.points >= 20);
  assert.ok(seen.length >= 1 && seen.every((p) => p.total === err.progress.total));
  // One pull: every session downloaded once, one charge.
  assert.equal(new Set(rangeCalls().map(dateOf)).size, rangeCalls().length);
  assert.equal(ledgerLines().filter((l) => l.kind === "charge").length, 1);
});

test("hedged: a slow attempt is asked again once and the first answer wins; a refusal ends it at once", async () => {
  let started = 0;
  let hedges = 0;
  const slowThenFast = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const n = ++started;
      const t = setTimeout(() => resolve(`attempt ${n}`), n === 1 ? 10_000 : 20);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });
  assert.equal(await hedged(slowThenFast, 30, () => hedges++), "attempt 2");
  assert.equal(hedges, 1);
  hedges = 0;
  const { DatabentoError } = await import("../../databento/client");
  await assert.rejects(
    hedged(() => Promise.reject(new DatabentoError(403, "refused")), 30, () => hedges++),
    /refused/,
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(hedges, 0);
  // A network failure is tried again when the hedge time comes.
  let n = 0;
  assert.equal(await hedged(() => (++n === 1 ? Promise.reject(new Error("reset")) : Promise.resolve("ok")), 20, () => hedges++), "ok");
  assert.ok(HEDGE_AFTER_MS >= 3_000);
});

test("servedCostUsd: records at the rate, hedged twice, refused free, unanswered at most", () => {
  const rate = 1e-6;
  assert.equal(servedCostUsd([{ records: 100, refused: false, hedged: false, maxUsd: 1 }], rate), 100 * rate);
  assert.equal(servedCostUsd([{ records: 100, refused: false, hedged: true, maxUsd: 1 }], rate), 200 * rate);
  assert.equal(servedCostUsd([{ records: null, refused: true, hedged: false, maxUsd: 1 }], rate), 0);
  assert.equal(servedCostUsd([{ records: null, refused: false, hedged: false, maxUsd: 0.5 }], rate), 0.5);
});

test("history: OPTIONS_DISPLAY is respected", async () => {
  process.env.OPTIONS_DISPLAY = "off";
  mockFetch();
  await assert.rejects(run({ range: "1y" }), /not shown/);
  assert.ok(!calls.some((c) => /get_cost|get_range/.test(c.url)));
});
