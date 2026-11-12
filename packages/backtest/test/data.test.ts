import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DeadlineError,
  JsonCache,
  PoliteFetcher,
  YahooPriceSource,
  backtest,
  mergeEarnings,
  parseChart,
  parseEarningsCalendar,
  parseQuoteSummaryEarnings,
  type PriceSource,
} from "../src/data/index";
import { makeBars, strategy, weekdays } from "./helpers";

const chart = {
  chart: {
    result: [
      {
        meta: { gmtoffset: -18000, currentTradingPeriod: { regular: { start: 1704292200, end: 1704315600 } } },
        timestamp: [1704119400, 1704205800, 1704292200],
        indicators: {
          quote: [{ open: [null, 100, 101], high: [1, 102, 103], low: [1, 99, 100], close: [1, 101, 102], volume: [0, 10, 20] }],
          adjclose: [{ adjclose: [1, 50.5, 51] }],
        },
      },
    ],
    error: null,
  },
};

test("parseChart: scales OHLC by adjclose/close, skips broken rows, drops a bar still trading", () => {
  const after = parseChart(chart, 1704400000);
  assert.deepEqual(after.map((b) => b.date), ["2024-01-02", "2024-01-03"]);
  assert.deepEqual(after[0], { date: "2024-01-02", open: 50, high: 51, low: 49.5, close: 50.5, volume: 10 });
  const during = parseChart(chart, 1704300000);
  assert.deepEqual(during.map((b) => b.date), ["2024-01-02"]);
  assert.deepEqual(parseChart({ chart: { result: null, error: { code: "Not Found" } } }), []);
});

const calendar = {
  finance: {
    result: [
      {
        documents: [
          {
            columns: [
              { id: "ticker" },
              { id: "eventname" },
              { id: "startdatetime" },
              { id: "startdatetimetype" },
              { id: "epsestimate" },
              { id: "epsactual" },
              { id: "epssurprisepct" },
              { id: "gmtOffsetMilliSeconds" },
            ],
            rows: [
              ["NVDA", " Annual Shareholders Meeting", "2025-06-26T16:00:00.000Z", "TAS", 5.57, null, null, -14400000],
              ["NVDA", null, "2025-05-28T20:20:00.000Z", "TAS", 0.93, 0.96, 2.84, -14400000],
              ["NVDA", null, "2025-02-26T12:00:00.000Z", "TAS", 0.84, 0.89, 5.5, -18000000],
              ["NVDA", null, "2025-08-27T20:20:00.000Z", "TAS", 1.01, null, null, -14400000],
            ],
          },
        ],
      },
    ],
  },
};

test("earnings: calendar rows with local date and time, quote summary rows, merged by quarter", () => {
  const cal = parseEarningsCalendar(calendar);
  assert.deepEqual(cal, [
    { date: "2025-02-26", time: "before_open", epsActual: 0.89, epsEstimate: 0.84, surprisePct: 5.95 },
    { date: "2025-05-28", time: "after_close", epsActual: 0.96, epsEstimate: 0.93, surprisePct: 3.23 },
  ]);
  const qs = parseQuoteSummaryEarnings({
    quoteSummary: {
      result: [
        {
          earnings: {
            earningsChart: {
              quarterly: [
                { date: "1Q2026", reportedDate: { fmt: "2025-05-29" }, actual: { raw: 0.96 }, estimate: { raw: 0.93 } },
                { date: "3Q2026", reportedDate: { fmt: "2025-11-19" }, actual: { raw: 1.3 }, estimate: { raw: 1.25 } },
              ],
            },
          },
        },
      ],
    },
  });
  assert.equal(qs.length, 2);
  const merged = mergeEarnings(cal, qs);
  assert.deepEqual(merged.map((e) => e.date), ["2025-02-26", "2025-05-28", "2025-11-19"]);
  assert.equal(merged[2]!.surprisePct, 4);
});

test("JsonCache: memory and disk, with expiry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-cache-"));
  const a = new JsonCache(dir);
  await a.set("k/1", { x: 1 }, 1_000);
  const b = new JsonCache(dir);
  assert.deepEqual(await b.get("k/1", 10_000, 5_000), { x: 1 });
  assert.equal(await b.get("k/1", 1_000, 5_000), null);
  assert.equal(await new JsonCache(null).get("k/1", 10_000), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("YahooPriceSource: one fetch serves later calls; an earlier start re-fetches the span", async () => {
  let calls = 0;
  const fake = {
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify(chart), { status: 200 });
    },
  } as unknown as PoliteFetcher;
  const src = new YahooPriceSource(new JsonCache(null), fake);
  const one = await src.dailyBars("AAA", "2024-01-01", "2024-12-31");
  await src.dailyBars("AAA", "2024-01-02", "2024-01-02");
  assert.equal(calls, 1);
  assert.equal(one.length, 2);
  await src.dailyBars("AAA", "2023-01-01", "2024-12-31");
  assert.equal(calls, 2);
});

test("PoliteFetcher: caps concurrency, retries a 429 once, stops at the deadline", async () => {
  const realFetch = globalThis.fetch;
  let active = 0;
  let peak = 0;
  let n = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    if (String(url).includes("busy") && n++ === 0) return new Response("", { status: 429, headers: { "retry-after": "0" } });
    if (String(url).includes("slow")) await new Promise((r) => setTimeout(r, 400));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const f = new PoliteFetcher({ concurrency: 2, minGapMs: 0, timeoutMs: 5_000, retries: 1 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => f.fetch(`https://x.test/${i}`)));
    assert.equal(peak, 2);
    const busy = await f.fetch("https://x.test/busy");
    assert.equal(busy.status, 200);
    assert.equal(n, 2); // the 429, then one retry
    await assert.rejects(f.fetch("https://x.test/slow", {}, AbortSignal.timeout(50)), DeadlineError);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("backtest(): validates input, runs on injected sources, reports a deadline as 504", async () => {
  const dates = weekdays("2024-01-01", 80);
  const bars = makeBars(dates, dates.map((_, i) => 100 + i));
  const prices: PriceSource = { name: "fake", dailyBars: async (_t, from, to) => bars.filter((b) => b.date >= from && b.date <= to) };
  const sources = { prices, earnings: null, ripple: null };
  const now = new Date("2024-06-01T00:00:00Z");

  const bad = await backtest({ strategy: { nope: true } }, { sources, now });
  assert.ok(!bad.ok && bad.status === 400);

  const ok = await backtest({ strategy: strategy({ universe: ["aaa"] }), config: { start: dates[0], end: dates.at(-1) } }, { sources, now });
  assert.ok(ok.ok, JSON.stringify(!ok.ok && ok.errors));
  assert.equal(ok.result.sources.prices, "fake");
  assert.equal(ok.result.period.sessions, 80);

  const slow: PriceSource = {
    name: "slow",
    dailyBars: (_t, _f, _to, signal) =>
      new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new DeadlineError()), { once: true })),
  };
  const late = await backtest(
    { strategy: strategy(), config: { start: dates[0], end: dates.at(-1) } },
    { sources: { prices: slow, earnings: null, ripple: null }, timeoutMs: 30, now },
  );
  assert.ok(!late.ok && late.status === 504);
});
