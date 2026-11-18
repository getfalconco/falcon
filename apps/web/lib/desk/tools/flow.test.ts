// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/flow.test.ts
// Databento, Yahoo and Supabase are answered by a mocked fetch; nothing leaves the machine.
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { afterEach, beforeEach, test } from "node:test";
import { decodeRecords, requestKey } from "../../databento/client";
import { FLOW_NOTE, isEarlyClose, resetFlow, sessionBounds, summarizeSession } from "./flow";
import { deskToolLabel, runDeskTool } from "./index";
import { deskToolCommand } from "./command";
import { resetYahoo } from "./yahoo";

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

// Sunday 2026-11-15, 16:43 New York: Friday the 13th is the latest completed session.
const NOW = Date.parse("2026-11-15T21:43:00Z");
const ctx = { now: () => NOW, timeoutMs: 8_000 };

/** Yahoo daily bars for 2026-11-09 .. 2026-11-13 (closes 100, 101, 102, 103, 100). */
const DATES = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
const CHART = {
  chart: {
    result: [
      {
        meta: { symbol: "TST", currency: "USD", gmtoffset: -18000 },
        timestamp: DATES.map((d) => Date.parse(`${d}T14:30:00Z`) / 1000),
        indicators: {
          quote: [{ open: [100, 100, 101, 102, 103], high: [101, 102, 103, 104, 104], low: [99, 99, 100, 101, 99], close: [100, 101, 102, 103, 100], volume: [1e6, 1e6, 1e6, 1e6, 2e6] }],
          adjclose: [{ adjclose: [100, 101, 102, 103, 100] }],
        },
      },
    ],
  },
};

function trade(iso: string, side: "B" | "A" | "N", size: number, price: number) {
  return { ts_recv: iso, hd: { ts_event: iso, rtype: 0, publisher_id: 2, instrument_id: 38 }, action: "T", side, depth: 0, price: price.toFixed(9), size, flags: 0, ts_in_delta: 0, sequence: 1, symbol: "TST" };
}

/** One session's trades (date in EST, offset -5 h). */
function sessionTrades(date: string, k = 1) {
  return [
    trade(`${date}T14:30:00.400000000Z`, "N", 5_000 * k, 100), // opening cross
    trade(`${date}T14:45:00Z`, "B", 300 * k, 100.5),
    trade(`${date}T15:10:00Z`, "A", 100 * k, 100.2),
    trade(`${date}T17:00:00Z`, "B", 2_000 * k, 101), // the largest continuous print
    trade(`${date}T18:00:00Z`, "N", 50 * k, 101), // hidden-order execution, no side
    trade(`${date}T20:59:59Z`, "A", 400 * k, 100.1),
    trade(`${date}T21:00:00.100000000Z`, "N", 9_000 * k, 100), // closing cross
  ];
}

const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
const body = (rows: unknown[]): ArrayBuffer => {
  const raw = Buffer.from(lines(rows));
  const b = zstd ? zstd(raw) : raw;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

type Opts = { cost?: number; ledgerRows?: Array<{ caller: string; cost_usd: number }>; range?: Handler };
const posted: unknown[] = [];

function routes(o: Opts = {}): [RegExp, Handler][] {
  return [
    [/v8\/finance\/chart\/TST/, () => json(CHART)],
    [/metadata\.get_dataset_range/, () => json({ start: "2018-05-01T00:00:00Z", end: "2026-11-15T00:00:00Z", schema: { trades: { start: "2018-05-01T00:00:00Z", end: "2026-11-15T00:00:00Z" } } })],
    [/metadata\.get_cost/, () => json(o.cost ?? 0.02)],
    [
      /timeseries\.get_range/,
      o.range ??
        ((_url, init) => {
          const p = new URLSearchParams(String(init?.body));
          return new Response(body(sessionTrades(p.get("start")!.slice(0, 10))), { status: 200 });
        }),
    ],
    [
      /sb\.test\/rest\/v1\/options_spend/,
      (_url, init) => {
        if (init?.method === "POST") {
          posted.push(...(JSON.parse(String(init.body)) as unknown[]));
          return new Response(null, { status: 201 });
        }
        const rows = o.ledgerRows ?? [];
        return json(rows, 200, { "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" });
      },
    ],
  ];
}

beforeEach(() => {
  resetFlow();
  resetYahoo();
  posted.length = 0;
  process.env.DATABENTO_API_KEY = "db-test-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test-key";
  delete process.env.DESK_FLOW_MAX_PULL_USD;
  delete process.env.DESK_FLOW_MONTH_CAP_USD;
  delete process.env.OPTIONS_DAILY_MONTH_CAP_USD;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

const ranges = () => calls.filter((c) => /get_range/.test(c.url));

test("flow: without DATABENTO_API_KEY it says so and fetches nothing", async () => {
  delete process.env.DATABENTO_API_KEY;
  mockFetch(routes());
  const r = await runDeskTool("flow", { ticker: "TST", days: 2 }, ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(JSON.parse(r.content), { error: "Volume data isn't configured on this server" });
  assert.equal(calls.length, 0);
});

test("flow: days outside 1..5 refused before any request", async () => {
  mockFetch(routes());
  const r = await runDeskTool("flow", { ticker: "TST", days: 9 }, ctx);
  assert.match(JSON.parse(r.content).error, /days must be 1 to 5/);
  assert.equal(calls.length, 0);
});

test("session summary: aggressor side, crosses apart, 30-minute curve, largest prints", () => {
  const raw = sessionTrades("2026-11-13").map((t) => ({ tsMs: Date.parse(t.ts_recv), price: Number(t.price), size: t.size, side: t.side }));
  const s = summarizeSession("2026-11-13", raw);
  assert.equal(s.buyVolume, 2_300);
  assert.equal(s.sellVolume, 500);
  assert.equal(s.unsignedVolume, 14_050);
  assert.equal(s.openCross, 5_000);
  assert.equal(s.closeCross, 9_000);
  assert.equal(s.volume, 16_850);
  assert.equal(s.curve.length, 13);
  assert.deepEqual(s.curve[0], ["10:00", 300, 100.5]); // 09:45 buy only
  assert.deepEqual(s.curve[1], ["10:30", 200, 100.2]);
  assert.deepEqual(s.curve[12], ["16:00", 1_800, 100]); // closing cross in the last bucket, not in the delta
  assert.equal(s.largest[0]!.size, 2_000);
  assert.equal(s.largest[0]!.side, "buy");
  assert.equal(s.largest[0]!.time, "12:00:00");
  assert.ok(s.largest.every((p) => p.size < 5_000), "crosses are not large prints");
  assert.equal(s.lastPrice, 100);
});

test("early closes and session bounds in New York time", () => {
  assert.equal(isEarlyClose("2026-11-27"), true); // day after Thanksgiving (Nov 26)
  assert.equal(isEarlyClose("2026-11-26"), false);
  assert.equal(isEarlyClose("2026-12-24"), true);
  assert.equal(isEarlyClose("2026-07-03"), true);
  assert.equal(new Date(sessionBounds("2026-11-13").openMs).toISOString(), "2026-11-13T14:30:00.000Z");
  assert.equal(new Date(sessionBounds("2026-07-14").closeMs).toISOString(), "2026-07-14T20:00:00.000Z");
  assert.equal(new Date(sessionBounds("2026-11-27").closeMs).toISOString(), "2026-11-27T18:00:00.000Z");
});

test("flow: two sessions bought once, recorded as desk-flow, then served from cache", async () => {
  mockFetch(routes({ cost: 0.02 }));
  const r = await runDeskTool("flow", { ticker: "TST", days: 2 }, ctx);
  assert.equal(r.ok, true, r.content);
  const out = JSON.parse(r.content);
  assert.deepEqual(
    out.sessions.map((s: { date: string }) => s.date),
    ["2026-11-12", "2026-11-13"],
  );
  const last = out.sessions[1];
  assert.equal(last.delta, 1_800);
  assert.equal(last.deltaPctOfVolume, 10.68);
  assert.equal(last.deltaPctOfSigned, 64.29);
  assert.equal(last.close, 100);
  assert.equal(last.closeToClosePct, -2.91); // 103 -> 100, Yahoo closes
  assert.equal(last.nasdaqSharePct, 0.8); // 16,850 of 2M
  assert.equal(last.data, "bought $0.020");
  assert.equal(out.multiDay.delta, 3_600);
  assert.deepEqual(out.multiDay.cumulative, [
    ["2026-11-12", 1_800, 1_800],
    ["2026-11-13", 1_800, 3_600],
  ]);
  assert.equal(out.costUsd, 0.04);
  assert.equal(out.note, FLOW_NOTE);
  assert.ok(r.content.length < 12_000);
  // Requests: regular hours plus 5 s, JSON, one pull per session.
  const pulls = ranges();
  assert.equal(pulls.length, 2);
  const p = new URLSearchParams(pulls.find((c) => c.body.includes("2026-11-13"))!.body);
  assert.equal(p.get("dataset"), "XNAS.ITCH");
  assert.equal(p.get("schema"), "trades");
  assert.equal(p.get("symbols"), "TST");
  assert.equal(p.get("start"), "2026-11-13T14:30:00.000Z");
  assert.equal(p.get("end"), "2026-11-13T21:00:05.000Z");
  assert.equal(p.get("encoding"), "json");
  // Auth is Basic with the key; the key never shows up in the result.
  assert.ok(!r.content.includes("db-test-key"));
  // Ledger: two charge lines under desk-flow, before the pulls.
  assert.equal(posted.length, 2);
  for (const line of posted as Array<Record<string, unknown>>) {
    assert.equal(line.caller, "desk-flow");
    assert.equal(line.kind, "charge");
    assert.equal(line.dataset, "XNAS.ITCH");
    assert.equal(line.cost_usd, 0.02);
    assert.equal(line.symbols, 1);
  }
  const sb = calls.find((c) => /sb\.test/.test(c.url) && c.method === "GET")!;
  assert.match(sb.url, /at=gte\.2026-11-01/);

  // Same question again: nothing priced, bought or written.
  posted.length = 0;
  calls = [];
  const again = JSON.parse((await runDeskTool("flow", { ticker: "TST", days: 2 }, ctx)).content);
  assert.equal(again.costUsd, 0);
  assert.deepEqual(
    again.sessions.map((s: { data: string }) => s.data),
    ["cached", "cached"],
  );
  assert.equal(ranges().length, 0);
  assert.equal(calls.filter((c) => /get_cost/.test(c.url)).length, 0);
  assert.equal(posted.length, 0);
});

test("flow: a session priced over the per-request cap is not bought", async () => {
  mockFetch(routes({ cost: 0.52 }));
  const r = await runDeskTool("flow", { ticker: "TST", days: 1 }, ctx);
  assert.equal(r.ok, false);
  assert.match(JSON.parse(r.content).error, /session alone is priced at \$0\.52, over the \$0\.40 per-session limit; each session is priced on its own/);
  assert.equal(ranges().length, 0);
  assert.equal(posted.length, 0);
});

test("flow: the month cap over every caller in options_spend is respected", async () => {
  mockFetch(routes({ cost: 0.05, ledgerRows: [{ caller: "options-daily@2026-11-14T21:00Z", cost_usd: 109.97 }] }));
  const r = await runDeskTool("flow", { ticker: "TST", days: 1 }, ctx);
  assert.equal(r.ok, false);
  assert.match(JSON.parse(r.content).error, /monthly Databento budget \(\$110\.00\)/);
  assert.equal(ranges().length, 0);

  resetFlow();
  mockFetch(routes({ cost: 0.05, ledgerRows: [{ caller: "desk-flow", cost_usd: 9.97 }] }));
  const r2 = await runDeskTool("flow", { ticker: "TST", days: 1 }, ctx);
  assert.match(JSON.parse(r2.content).error, /Falcon AI's monthly volume-data budget \(\$10\.00\)/);
});

test("flow: a dropped body is fetched again (one charge); 206 is a success", async () => {
  let n = 0;
  mockFetch(
    routes({
      range: () => {
        n++;
        if (n === 1) return new Response("{\"ts_recv\":\"2026-11-13T14:4", { status: 200 });
        return new Response(body(sessionTrades("2026-11-13")), { status: 206, headers: { "x-warning": "some symbols did not resolve" } });
      },
    }),
  );
  const r = await runDeskTool("flow", { ticker: "TST", days: 1 }, ctx);
  assert.equal(r.ok, true, r.content);
  const out = JSON.parse(r.content);
  assert.equal(out.sessions[0].delta, 1_800);
  assert.match(out.sessions[0].partial, /did not resolve/);
  assert.equal(n, 2);
  assert.equal(posted.length, 1);
});

test("flow: Databento refusing the pull writes a refund line", async () => {
  mockFetch(routes({ range: () => json({ detail: "bad request" }, 400) }));
  const r = await runDeskTool("flow", { ticker: "TST", days: 1 }, ctx);
  assert.equal(r.ok, false);
  const kinds = (posted as Array<{ kind: string; cost_usd: number }>).map((l) => [l.kind, l.cost_usd]);
  assert.deepEqual(kinds, [
    ["charge", 0.02],
    ["refund", -0.02],
  ]);
});

test("decode: zstd and plain JSON lines; request keys are canonical", () => {
  const rows = [{ a: 1 }, { a: 2 }];
  assert.deepEqual(decodeRecords(Buffer.from(lines(rows))), rows);
  if (zstd) assert.deepEqual(decodeRecords(zstd(Buffer.from(lines(rows)))), rows);
  const a = requestKey({ dataset: "XNAS.ITCH", schema: "trades", symbols: ["B", "A"], start: "2026-11-13T14:30:00Z", end: "2026-11-13T21:00:05Z" });
  const b = requestKey({ dataset: "XNAS.ITCH", schema: "trades", symbols: ["A", "B"], start: "2026-11-13T14:30:00.000Z", end: "2026-11-13T21:00:05.000Z" });
  assert.equal(a, b);
});

test("flow: label and command", () => {
  assert.equal(deskToolLabel("flow", { ticker: "NVDA", days: 2 }, "running"), "Measuring NVDA volume delta over 2 sessions");
  assert.equal(deskToolLabel("flow", { ticker: "AAPL" }), "Measured AAPL volume delta");
  assert.equal(deskToolCommand("flow", { ticker: "NVDA", days: 2 }).cmd, "/flow NVDA 2");
});

test("flow: a download that outlives the tool's deadline finishes in the background and is not bought twice", async () => {
  mockFetch(
    routes({
      range: async () => {
        await new Promise((r) => setTimeout(r, 700));
        return new Response(body(sessionTrades("2026-11-13")), { status: 200 });
      },
    }),
  );
  const first = await runDeskTool("flow", { ticker: "TST", days: 1 }, { now: () => NOW, timeoutMs: 400 });
  assert.equal(first.ok, false);
  assert.match(JSON.parse(first.content).error, /Still downloading TST.*Call flow again/);
  await new Promise((r) => setTimeout(r, 500));
  const second = await runDeskTool("flow", { ticker: "TST", days: 1 }, ctx);
  assert.equal(second.ok, true, second.content);
  assert.equal(JSON.parse(second.content).sessions[0].data, "cached");
  assert.equal(ranges().length, 1);
  assert.equal(posted.length, 1);
});
