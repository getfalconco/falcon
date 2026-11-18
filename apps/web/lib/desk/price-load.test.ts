// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/price-load.test.ts
// Big price loads for strategy tests (lib/desk/data.ts, lib/desk/strategy-run.ts): one call for "since 2016",
// bounded parallel loading that stops in time and carries on without redoing finished tickers, the streamed price
// file, the resume accounting that keeps a long load from eating the reply's hops, and the partial answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { Bar } from "@falcon/backtest/data";
import { yahooDailyBars } from "./data";
import { FREE_HOPS, LONG_FROM, PriceFileWriter, buildPriceFile, handOffCounts, parseLoadPrices, signResume, verifyResume } from "./strategy-run";
import { FINAL_NOTE, partialRunSummary, replyLanguage, runSteps } from "./partial";
import type { RunResult } from "./run-result";

const TODAY = "2026-11-17";
const bar = (date: string, close: number): Bar => ({ date, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 });
/** "SPY" and n made-up symbols: TAAA, TAAB, ... */
const sym = (i: number) => `T${String.fromCharCode(65 + Math.floor(i / 676) % 26, 65 + Math.floor(i / 26) % 26, 65 + (i % 26))}`;
const tickers = (n: number) => ["SPY", ...Array.from({ length: n }, (_, i) => sym(i))];

test("load_prices: since 2016 is one call for 1,500 event tickers; earlier starts keep the 10-year cap", () => {
  const many = tickers(1499).slice(1);
  const p = parseLoadPrices({ tickers: many, tickers_from_events: "events_ab12cd.csv.gz", start: "2016-01-01" }, TODAY);
  assert.equal(p.tickers.length, 1500);
  assert.equal(p.start, "2016-01-01");
  assert.equal(p.end, TODAY);
  assert.equal(p.from, "2014-11-27"); // 400 days of warm-up
  assert.equal(parseLoadPrices({ universe: "us_large_caps", start: LONG_FROM }, TODAY).start, LONG_FROM);
  assert.throws(() => parseLoadPrices({ universe: "us_large_caps", start: "2014-12-31" }, TODAY), /at most 10 years/);
  assert.equal(parseLoadPrices({ universe: "us_large_caps", start: "2005-01-03", end: "2014-12-31" }, TODAY).start, "2005-01-03");
});

/** A fake Yahoo source: a per-ticker cache like the real one, a delay per fetch, and counters. */
function fakeSource(delayMs: number, opts: { empty?: Set<string>; fail?: Set<string> } = {}) {
  const cache = new Map<string, Bar[]>();
  const stats = { fetches: 0, active: 0, maxActive: 0 };
  const src = {
    name: "fake",
    async dailyBars(t: string, from: string, to: string, signal?: AbortSignal): Promise<Bar[]> {
      const hit = cache.get(t);
      if (hit) return hit.filter((b) => b.date >= from && b.date <= to);
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      } finally {
        stats.active--;
      }
      stats.fetches++;
      if (opts.fail?.has(t)) throw new Error("HTTP 500");
      const bars = opts.empty?.has(t) ? [] : [bar("2016-01-04", 10), bar("2016-01-05", 11), bar("2026-11-16", 12)];
      cache.set(t, bars);
      return bars;
    },
  };
  return { src, stats };
}

test("bulk load: bounded parallel reads, stops at the signal, and the next call fetches only what was left", async () => {
  const list = tickers(300);
  const { src, stats } = fakeSource(5, { empty: new Set([sym(7)]), fail: new Set([sym(9)]) });
  const progress: number[] = [];
  // Cut short: some tickers loaded (and cached), the rest come back as notLoaded.
  const first = await yahooDailyBars(list, "2014-11-27", TODAY, AbortSignal.timeout(40), { onProgress: (p) => progress.push(p.loaded) }, src);
  assert.ok(first.notLoaded.length > 0, "the signal stops the load");
  assert.ok(first.bars.size > 0 && first.bars.size < list.length);
  assert.ok(stats.maxActive <= 24, `at most 24 at once (got ${stats.maxActive})`);
  const fetchedBefore = stats.fetches;
  // The same call again: finished tickers come from the cache, only the rest are fetched.
  const second = await yahooDailyBars(list, "2014-11-27", TODAY, AbortSignal.timeout(10_000), {}, src);
  assert.equal(second.notLoaded.length, 0);
  // (A ticker that failed is not cached: it is tried again.)
  assert.equal(stats.fetches - fetchedBefore, first.notLoaded.length + (first.missing.includes(sym(9)) ? 1 : 0), "no finished ticker is fetched again");
  assert.deepEqual(second.missing, [sym(7), sym(9)]);
  assert.equal(second.bars.size, list.length - 2);
  assert.equal(second.loaded.size, list.length - 2);
  assert.ok(progress.length > 0 && progress.every((n, i) => i === 0 || n >= progress[i - 1]!));
});

test("bulk load with a sink keeps no bars in memory; the price file streams per ticker", async () => {
  const list = tickers(50);
  const { src } = fakeSource(0);
  const w = new PriceFileWriter(["open", "close"]);
  const got = await yahooDailyBars(list, "2016-01-01", TODAY, undefined, { sink: (t, b) => w.add(t, b) }, src);
  assert.equal(got.bars.size, 0);
  assert.equal(got.loaded.size, list.length);
  const f = w.finish();
  assert.equal(f.rows, list.length * 3);
  assert.equal(f.first, "2016-01-04");
  assert.equal(f.last, "2026-11-16");
  // One gzip member per ticker plus the header: an ordinary gzip file that reads whole.
  const csv = gunzipSync(f.gz).toString("utf8").trim().split("\n");
  assert.equal(csv[0], "date,ticker,open,close");
  assert.equal(csv.length, 1 + list.length * 3);
  assert.equal(csv[1], "2016-01-04,SPY,9,10");
  // Alphabetical, whatever order the tickers arrived in.
  const seen = csv.slice(1).map((l) => l.split(",")[1]!);
  assert.deepEqual(seen, [...seen].sort());
  // Same as building from bars in memory.
  const again = buildPriceFile(new Map([["B", [bar("2020-01-02", 5)]], ["A", [bar("2020-01-02", 4)]]]), ["close", "volume"]);
  assert.equal(gunzipSync(again.gz).toString("utf8"), "date,ticker,close,volume\n2020-01-02,A,4,1000\n2020-01-02,B,5,1000\n");
});

test("resume accounting: waiting on a price load that makes progress is free, a stalled one counts, free hops are capped", () => {
  // Hop 1 ends waiting with 600 of 1,000 loaded: free.
  assert.equal(handOffCounts({ waitingOnPrices: true, loadedBefore: 0, loadedNow: 600, free: 0 }), false);
  // Hop 2 still waiting but no further (the source is down): counts, so it cannot loop forever.
  assert.equal(handOffCounts({ waitingOnPrices: true, loadedBefore: 600, loadedNow: 600, free: 1 }), true);
  // Any other hand-off counts.
  assert.equal(handOffCounts({ waitingOnPrices: false, loadedBefore: 0, loadedNow: 0, free: 0 }), true);
  assert.equal(handOffCounts({ waitingOnPrices: true, loadedBefore: 100, loadedNow: 900, free: FREE_HOPS }), true);

  // A reply simulated hop by hop: an event load, a cold price load over three requests, the test, the audit, the answer.
  const MAX_RESUMES = 12;
  let n = 0;
  let free = 0;
  let loadedBefore = 0;
  const hops: { waiting?: number }[] = [{}, { waiting: 400 }, { waiting: 800 }, {}, {}, {}, {}];
  for (const h of hops) {
    const counts = handOffCounts({ waitingOnPrices: h.waiting !== undefined, loadedBefore, loadedNow: h.waiting ?? 0, free });
    n += counts ? 1 : 0;
    free += counts ? 0 : 1;
    loadedBefore = h.waiting ?? 0;
  }
  assert.equal(n, 5);
  assert.equal(free, 2);
  assert.ok(n + 1 < MAX_RESUMES);

  // The counters ride in the signed token.
  const state = { tail: [], container: null, runId: "run_1", dataFiles: [], files: {}, n: 3, free: 2, waiting: { ids: ["toolu_1"], results: [], since: 5, loaded: 800 } };
  const back = verifyResume(signResume(state, "secret", null), "secret", null)!;
  assert.equal(back.n, 3);
  assert.equal(back.free, 2);
  assert.equal(back.waiting?.loaded, 800);
  assert.equal(verifyResume(signResume({ ...state, free: undefined, waiting: undefined }, "secret", null), "secret", null)!.free, undefined);
});

const result = {
  name: "Earnings jump",
  period: { start: "2016-01-04", end: "2026-11-14" },
  universe: "events",
  benchmark: "SPY",
  closed_trades: 812,
  metrics: { cagr: 0.051, vol: 0.2, sharpe: 0.42, max_dd: -0.31, total_return: 0.71, trades: 1624, win_rate: 0.52, turnover: 3, benchmark: { cagr: 0.12, sharpe: 0.8, max_dd: -0.34, total_return: 2.4 } },
} as unknown as RunResult;

test("partial answer: what ran, the numbers if the script finished, and what did not run", () => {
  const turns = [
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "load_events", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: JSON.stringify({ file: "events_x.csv.gz", rows: 4616 }) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "b", name: "load_prices", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: JSON.stringify({ file: "prices_x.csv.gz", tickers_loaded: 1012 }) }] },
    { role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "bash_code_execution", input: {} }, { type: "tool_use", id: "c", name: "audit_run", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: JSON.stringify({ error: "The audit continues in the next step." }), is_error: false }] },
  ];
  assert.deepEqual(runSteps(turns), { events: 4616, prices: 1012, commands: 1, audited: false });
  const en = partialRunSummary({ turns, result, lang: "en" });
  assert.match(en, /events loaded \(4,616 rows\)/);
  assert.match(en, /prices loaded \(1,012 tickers\)/);
  assert.match(en, /total return 71\.0% \(SPY: 240\.0%\)/);
  assert.match(en, /812 trades/);
  assert.match(en, /Did not run: the independent audit/);
  assert.match(en, /\*\*Unaudited\*\*/);
  const tr = partialRunSummary({ turns: turns.slice(0, 2), result: null, lang: "tr" });
  assert.match(tr, /olaylar yüklendi/);
  assert.match(tr, /Çalışmayanlar: fiyat yüklemesi; testin sonucu/);
  assert.match(tr, /Denetlenmedi/);
  assert.equal(replyLanguage("Tüm bilançolarda olay günü +%10'dan fazla yükselen hisseler"), "tr");
  assert.equal(replyLanguage("Test buying earnings gappers"), "en");
  assert.match(FINAL_NOTE, /no more tools can run/);
});
