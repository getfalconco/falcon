import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";
import { DatabentoClient, type HttpFn, type HttpResponseLike } from "../src/options/client.ts";
import { memoryOptionsStore } from "../src/options/store.ts";
import { barsToRows, chunkSessions, detectSplits, pricesLine, redetectSplits, reverseDivisor, runPrices, toDatabentoSymbol } from "../src/prices/daily.ts";
import { memoryPricesStore, type DayBar } from "../src/prices/store.ts";

const zstd = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
const noSleep = async () => {};
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "falcon-prices-"));
const NOW = Date.parse("2026-11-16T22:00:00Z");

function response(status: number, body: string | Buffer): HttpResponseLike {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status,
    headers: { get: () => null },
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}

const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A fake Databento: dataset range ends `end`; get_range answers one bar per symbol per weekday in [start, end). */
function fakeDatabento(price: number, end = "2026-11-14", status: number | null = null) {
  const calls: Array<{ endpoint: string; method: string; start: string; end: string; symbols: string[] }> = [];
  const http: HttpFn = async (url, init) => {
    const endpoint = url.split("?")[0]!.split("/").pop()!;
    const p = new URLSearchParams(init.method === "GET" ? url.split("?")[1] ?? "" : init.body ?? "");
    const symbols = (p.get("symbols") ?? "").split(",").filter(Boolean);
    calls.push({ endpoint, method: init.method, start: p.get("start") ?? "", end: p.get("end") ?? "", symbols });
    if (endpoint === "metadata.get_dataset_range") return response(200, JSON.stringify({ start: "2024-07-01", end: `${end}T00:00:00Z`, schema: { "ohlcv-1d": { start: "2024-07-01", end: `${end}T00:00:00.000000000Z` } } }));
    if (endpoint === "metadata.get_cost") return response(200, JSON.stringify(price));
    if (status !== null) return response(status, '{"detail":"Insufficient credit: add a payment method"}');
    const lines: string[] = [];
    for (let d = p.get("start")!.slice(0, 10); d < p.get("end")!.slice(0, 10); d = addDay(d, 1)) {
      const w = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (w === 0 || w === 6) continue;
      symbols.forEach((sym, i) => {
        lines.push(JSON.stringify({ hd: { ts_event: `${d}T00:00:00.000000000Z`, rtype: 35, publisher_id: 90, instrument_id: i + 1 }, open: "10.5", high: "11", low: "10", close: "10.75", volume: "1000", symbol: sym }));
      });
    }
    return response(200, zstd(Buffer.from(lines.join("\n") + "\n")));
  };
  return { http, calls, ranges: () => calls.filter((c) => c.endpoint === "timeseries.get_range") };
}

const client = (http: HttpFn) => new DatabentoClient({ http, apiKey: "test", dir: tmpDir(), sleep: noSleep, totalBudgetUsd: 50 });

/** Bars with a steady price, then `jump` applied from `at` on, with that session's volume times `volX`. */
function series(n: number, at: number, jump: number, volX: number): DayBar[] {
  const out: DayBar[] = [];
  let d = "2025-03-03";
  for (let i = 0; i < n; i++) {
    while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDay(d, 1);
    const p = i >= at ? 100 * jump : 100;
    const v = i === at ? 1_000_000 * volX : 1_000_000;
    out.push({ date: d, open: p * 1.001, high: p * 1.01, low: p * 0.99, close: p, volume: v });
    d = addDay(d, 1);
  }
  return out;
}

describe("helpers", () => {
  it("symbols: graph form to Databento form", () => {
    assert.equal(toDatabentoSymbol("BRK-B"), "BRK.B");
    assert.equal(toDatabentoSymbol("NVDA"), "NVDA");
  });

  it("chunks: runs of consecutive sessions to fetch, at most `size` long", () => {
    const all = ["a", "b", "c", "d", "e", "f", "g"];
    assert.deepEqual(chunkSessions(all, new Set(["a", "b", "c", "e", "f", "g"]), 2), [["a", "b"], ["c"], ["e", "f"], ["g"]]);
    assert.deepEqual(chunkSessions(all, new Set(), 5), []);
    assert.deepEqual(chunkSessions(all, new Set(all), 1).length, 7);
  });

  it("rows: symbols mapped back, unknown symbols and bad bars dropped", () => {
    const bars = new Map([
      ["BRK.B", new Map([["2026-11-13", { open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]])],
      ["ZZZ", new Map([["2026-11-13", { open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]])],
      ["AAPL", new Map([["2026-11-13", { open: 1, high: 2, low: 0.5, close: 0, volume: 10 }]])],
    ]);
    const rows = barsToRows(bars, new Map([["BRK.B", "BRK-B"], ["AAPL", "AAPL"]]));
    assert.deepEqual(rows, [{ ticker: "BRK-B", date: "2026-11-13", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, source: "EQUS.SUMMARY" }]);
  });
});

describe("split detection", () => {
  it("finds a 10-for-1 and a 1-for-20 with ordinary dollar volume", () => {
    // 10-for-1: price / 10, share volume x 10 (dollar volume flat).
    const fwd = detectSplits("NVDA", series(30, 20, 0.1, 10));
    assert.equal(fwd.length, 1);
    assert.equal(fwd[0]!.ratio, 10);
    assert.equal(fwd[0]!.ticker, "NVDA");
    const rev = detectSplits("XYZ", series(30, 20, 20, 1 / 20));
    assert.equal(rev.length, 1);
    assert.equal(rev[0]!.ratio, 0.05);
  });

  it("a 2-for-1 is found, a 50% crash on heavy dollar volume is not", () => {
    assert.equal(detectSplits("A", series(30, 20, 0.5, 2))[0]?.ratio, 2);
    // Halving on 10x share volume = 5x dollar volume: a crash.
    assert.deepEqual(detectSplits("B", series(30, 20, 0.5, 10)), []);
  });

  it("reverse splits: sold hard still found, a genuine 5x jump on huge volume is not", () => {
    // 1-for-10, then sold off 25% on the day with 6x the usual dollar volume.
    const sold = series(30, 20, 10, 0.8).map((b, i) => (i === 20 ? { ...b, close: b.close * 0.75 } : b));
    assert.equal(detectSplits("R", sold)[0]?.ratio, 0.1);
    // +400% (biotech data) on 500x dollar volume.
    assert.deepEqual(detectSplits("J", series(30, 20, 5, 100)), []);
  });

  it("reverse ratios: the nearest when exact, else the roundest within tolerance", () => {
    assert.equal(reverseDivisor(Math.log(16.2), 0.12), 16);
    assert.equal(reverseDivisor(Math.log(9.46), 0.12), 10);
    assert.equal(reverseDivisor(Math.log(15.5), 0.12), 15);
    assert.equal(reverseDivisor(Math.log(3.6), 0.05), null);
  });

  it("ordinary moves, odd ratios and too little history are left alone", () => {
    assert.deepEqual(detectSplits("C", series(30, 20, 0.8, 1)), []);
    assert.deepEqual(detectSplits("D", series(30, 20, 0.43, 2.3)), []);
    assert.deepEqual(detectSplits("E", series(4, 2, 0.1, 10)), []);
  });
});

describe("runPrices", () => {
  it("daily: fetches each session not stored yet, one request each, POSTs get_cost, records spend", async () => {
    const fake = fakeDatabento(0.0025);
    const store = memoryPricesStore();
    const ledger = memoryOptionsStore();
    // 2026-11-12 is already stored for both tickers.
    await store.save(["AAPL", "BRK-B"].map((t) => ({ ticker: t, date: "2026-11-12", open: 1, high: 1, low: 1, close: 1, volume: 1, source: "EQUS.SUMMARY" })));
    const s = await runPrices({ client: client(fake.http), store, ledger, tickers: ["AAPL", "BRK-B"], mode: "daily", nowMs: NOW });
    assert.equal(s.to, "2026-11-13");
    assert.equal(s.from, "2026-11-03");
    assert.equal(s.stored, 1);
    assert.equal(s.bought, 8);
    assert.equal(fake.ranges().length, 8);
    assert.ok(fake.ranges().every((c) => c.symbols.includes("BRK.B")));
    assert.ok(fake.calls.filter((c) => c.endpoint === "metadata.get_cost").every((c) => c.method === "POST"));
    assert.equal(s.rows, 16);
    assert.ok(store.rows.has("BRK-B|2026-11-13"));
    assert.ok(Math.abs(s.spendUsd - 0.02) < 1e-9);
    assert.equal(ledger.spend.length, 8);
    assert.ok(ledger.spend.every((e) => e.caller.startsWith("prices-daily@")));
    assert.match(s.line, /8 of 9 sessions/);

    // A second run buys nothing.
    const again = await runPrices({ client: client(fake.http), store, ledger, tickers: ["AAPL", "BRK-B"], mode: "daily", nowMs: NOW });
    assert.equal(again.bought, 0);
    assert.equal(fake.ranges().length, 8);
  });

  it("backfill: chunks of sessions from the dataset start", async () => {
    const fake = fakeDatabento(0.15, "2024-10-01");
    const store = memoryPricesStore();
    const s = await runPrices({ client: client(fake.http), store, ledger: memoryOptionsStore(), tickers: ["AAPL"], mode: "backfill", nowMs: NOW, chunkSessions: 30 });
    assert.equal(s.from, "2024-07-01");
    assert.equal(s.to, "2024-09-30");
    assert.equal(fake.ranges().length, Math.ceil(s.sessions / 30));
    assert.equal(fake.ranges()[0]!.start, "2024-07-01");
    assert.equal(s.bought, s.sessions);
  });

  it("caps: the monthly cap in the ledger stops the run before any pull", async () => {
    const fake = fakeDatabento(0.0025);
    const ledger = memoryOptionsStore();
    await ledger.append([{ at: "2026-11-02T00:00:00.000Z", kind: "charge", dataset: "EQUS.SUMMARY", schema: "ohlcv-1d", symbols: { count: 1, first: ["A"] }, start: "", end: "", costUsd: 2, caller: "prices-daily@x", key: "k" }]);
    const s = await runPrices({ client: client(fake.http), store: memoryPricesStore(), ledger, tickers: ["AAPL"], mode: "daily", nowMs: NOW });
    assert.match(s.stopped ?? "", /monthly cap reached/);
    assert.equal(fake.ranges().length, 0);
  });

  it("caps: a request over the run cap is refused quietly", async () => {
    const fake = fakeDatabento(5);
    const s = await runPrices({ client: client(fake.http), store: memoryPricesStore(), ledger: memoryOptionsStore(), tickers: ["AAPL"], mode: "daily", nowMs: NOW });
    assert.match(s.stopped ?? "", /per-call cap/);
    assert.equal(s.bought, 0);
    assert.equal(fake.ranges().length, 0);
  });

  it("billing refusal stops quietly with the account error", async () => {
    const fake = fakeDatabento(0.0025, "2026-11-14", 402);
    const s = await runPrices({ client: client(fake.http), store: memoryPricesStore(), ledger: memoryOptionsStore(), tickers: ["AAPL"], mode: "daily", nowMs: NOW });
    assert.match(s.accountError ?? "", /billing/);
    assert.equal(s.rows, 0);
  });

  it("price only: nothing bought or stored", async () => {
    const fake = fakeDatabento(0.0025);
    const store = memoryPricesStore();
    const s = await runPrices({ client: client(fake.http), store, ledger: memoryOptionsStore(), tickers: ["AAPL"], mode: "daily", nowMs: NOW, priceOnly: true });
    assert.equal(fake.ranges().length, 0);
    assert.equal(store.rows.size, 0);
    assert.ok(Math.abs(s.pricedUsd - 0.0225) < 1e-9);
    assert.match(pricesLine(s, true), /would cost/);
  });

  it("detects a split in newly stored bars and keeps hand-entered rows", async () => {
    const store = memoryPricesStore();
    const bars = series(30, 25, 0.25, 4);
    await store.save(bars.slice(0, 25).map((b) => ({ ticker: "AAPL", ...b, source: "EQUS.SUMMARY" })));
    store.splits.set("MSFT|2026-01-02", { ticker: "MSFT", date: "2026-01-02", ratio: 1, detail: "", source: "manual" });
    await store.save(bars.slice(25).map((b) => ({ ticker: "AAPL", ...b, source: "EQUS.SUMMARY" })));
    const all = await store.bars("2025-01-01", "2026-12-31", ["AAPL"]);
    const found = detectSplits("AAPL", all.get("AAPL")!);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.ratio, 4);
    assert.equal(await store.saveSplits([...found, { ticker: "MSFT", date: "2026-01-02", ratio: 2, detail: "x" }]), 1);
    assert.equal(store.splits.get("MSFT|2026-01-02")!.ratio, 1);

    // Redetection replaces detected rows only.
    store.splits.set("ZZZ|2025-01-02", { ticker: "ZZZ", date: "2025-01-02", ratio: 3, detail: "", source: "detected" });
    const again = await redetectSplits(store, NOW);
    assert.deepEqual(again.map((s) => s.ticker), ["AAPL"]);
    assert.ok(!store.splits.has("ZZZ|2025-01-02"));
    assert.equal(store.splits.get("MSFT|2026-01-02")!.source, "manual");
  });
});
