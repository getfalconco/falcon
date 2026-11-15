import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";
import type { RippleCard } from "@falcon/ripple";
import { DatabentoClient, DatabentoError, type HttpFn, type HttpResponseLike } from "../src/options/client.ts";
import { optionsBlock, type TickerOptions } from "../src/options/cards.ts";
import { accountProblem, mapPool, priceChains, type KnownEntry, type Snapshot } from "../src/options/chains.ts";
import { DAILY_CALLER_PREFIX, dailyLine, runDaily, universeTickers } from "../src/options/daily.ts";
import { attachOptions } from "../src/options/sightings-options.ts";
import { fromMetrics, ivPercentile, memoryOptionsStore, monthBounds, toMetrics, trimTerm, MIN_IV_DAYS } from "../src/options/store.ts";

const zstd = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
const noSleep = async () => {};
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "falcon-options-daily-"));
const NOW = Date.parse("2026-11-15T12:00:00Z");
const SNAP: Snapshot = { date: "2026-11-13", minute: 945, asOfMs: Date.parse("2026-11-13T20:45:00Z"), label: "2026-11-13 15:45 ET" };

function response(status: number, body: string | Buffer): HttpResponseLike {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status,
    headers: { get: () => null },
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}

/** An empty-ish body: one ohlcv record, which carries no OPRA quotes (every name ends "no quotes at the snapshot"). */
const BAR = { hd: { ts_event: "2026-11-13T00:00:00.000000000Z", rtype: 35, publisher_id: 31, instrument_id: 1 }, open: "1", high: "1", low: "1", close: "1", volume: "7", symbol: "X" };
const body = () => zstd(Buffer.from(JSON.stringify(BAR) + "\n"));

type Call = { endpoint: string; symbols: string[]; schema: string };

/** A fake Databento: get_cost answers `price` (per request), get_range answers `rangeStatus(symbols)` or the empty body. */
function fakeDatabento(price: number, rangeStatus: (symbols: string[]) => number | null = () => null) {
  const calls: Call[] = [];
  const http: HttpFn = async (url, init) => {
    const endpoint = url.split("?")[0]!.split("/").pop()!;
    const params = new URLSearchParams(init.method === "GET" ? url.split("?")[1] ?? "" : init.body ?? "");
    const symbols = (params.get("symbols") ?? "").split(",").filter(Boolean);
    calls.push({ endpoint, symbols, schema: params.get("schema") ?? "" });
    if (endpoint === "metadata.get_dataset_range") return response(200, JSON.stringify({ start: "2013-01-01", end: "2026-11-15T00:00:00Z", schema: {} }));
    if (endpoint === "metadata.get_cost") return response(200, JSON.stringify(price));
    const st = rangeStatus(symbols);
    if (st !== null) return response(st, st === 402 ? '{"detail":"Insufficient credit: add a payment method"}' : "<html>504 Gateway Time-out</html>");
    return response(200, body());
  };
  const quotePulls = () => calls.filter((c) => c.endpoint === "timeseries.get_range" && c.schema === "cbbo-1m");
  return { http, calls, quotePulls };
}

const T = (ticker: string, iv = 0.4): TickerOptions => ({
  ticker,
  date: "2026-11-13",
  asOf: "2026-11-13T20:45:00.000Z",
  spot: 100,
  spotSource: "itch",
  atmIv30: iv,
  skew: 0.03,
  cpSpread: -0.01,
  beta: 1.2,
  vix: 0.18,
  term: [
    { expiration: "2026-11-20", days: 7, iv },
    { expiration: "2026-12-18", days: 35, iv },
    { expiration: "2027-03-19", days: 126, iv },
    { expiration: "2027-06-18", days: 217, iv },
  ],
});

const tickers = (n: number) => Array.from({ length: n }, (_, i) => `T${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);

describe("universe and helpers", () => {
  it("universe: the graph's US listings, sorted, without preferreds", () => {
    assert.deepEqual(universeTickers({ names: { NVDA: "", "BRK-B": "", "PCG-PE": "", "SCE-PG": "", aapl: "", "MOG-A": "", TOOLONGX: "" } }), ["AAPL", "BRK-B", "MOG-A", "NVDA"]);
  });

  it("mapPool keeps input order and the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([5, 1, 3, 2, 4], 2, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, x));
      active--;
      return x * 10;
    });
    assert.deepEqual(out, [50, 10, 30, 20, 40]);
    assert.equal(peak, 2);
  });

  it("account problems: 401/402/403 and billing words, not a 504 or a 422", () => {
    assert.match(accountProblem(new DatabentoError(402, "Databento timeseries.get_range HTTP 402: payment required"))!, /billing/);
    assert.match(accountProblem(new DatabentoError(401, "x"))!, /API key/);
    assert.match(accountProblem(new DatabentoError(400, "Databento HTTP 400: insufficient credit balance"))!, /billing/);
    assert.equal(accountProblem(new DatabentoError(504, "gateway time-out")), null);
    assert.equal(accountProblem(new DatabentoError(422, "symbol did not resolve")), null);
    assert.equal(accountProblem(new Error("payment")), null);
  });
});

describe("store: IV percentile, metrics, reuse", () => {
  it("IV percentile: null under 20 days, ties count half", () => {
    assert.equal(ivPercentile(Array(MIN_IV_DAYS - 1).fill(0.3), 0.5), null);
    const h = Array.from({ length: 20 }, (_, i) => 0.2 + i * 0.01); // 0.20 .. 0.39
    assert.equal(ivPercentile(h, 0.5), 100);
    assert.equal(ivPercentile(h, 0.1), 0);
    assert.equal(ivPercentile(h, 0.295), 50);
    assert.equal(ivPercentile(Array(20).fill(0.3), 0.3), 50);
  });

  it("term trimmed after the first expiry past 120 days; metrics round-trip to the same card block", () => {
    assert.deepEqual(trimTerm(T("A").term).map((p) => p.days), [7, 35, 126]);
    const t = T("KLAC", 0.631);
    const m = toMetrics(t, []);
    assert.equal(m.ivPct, null);
    assert.equal(m.block.atmIv, 63.1);
    const back = fromMetrics("KLAC", "2026-11-13", JSON.parse(JSON.stringify(m)));
    assert.deepEqual(optionsBlock(back), optionsBlock(t));
    const m2 = toMetrics(t, Array(25).fill(0.5));
    assert.equal(m2.ivPct, 100);
    assert.equal(m2.block.ivPct, 100);
    assert.equal(optionsBlock(fromMetrics("KLAC", "2026-11-13", m2)).ivPct, 100);
  });

  it("memory store: saves records with their percentile from earlier days, skips, and prunes", async () => {
    const s = memoryOptionsStore();
    for (let i = 0; i < 25; i++) {
      const d = new Date(Date.parse("2026-09-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      await s.save(d, new Map([["NVDA", { ...T("NVDA", 0.3 + i * 0.001), date: d }]]), "daily");
    }
    await s.save("2026-11-13", new Map<string, KnownEntry>([["NVDA", T("NVDA", 0.9)], ["BF-B", { skip: "poor chain: only 7 contracts with an IV" }]]), "daily");
    const known = await s.known("2026-11-13", ["NVDA", "BF-B", "AMD"]);
    assert.equal(known.size, 2);
    assert.deepEqual(known.get("BF-B"), { skip: "poor chain: only 7 contracts with an IV" });
    assert.equal((known.get("NVDA") as TickerOptions).ivPct, 100);
    assert.equal(await s.prune("2026-11-13", 60), 13); // before 2026-09-14
    assert.equal(await s.prune("2026-11-13", 30), 12);
  });

  it("month bounds are UTC calendar months", () => {
    assert.deepEqual(monthBounds(Date.parse("2026-12-31T23:59:00Z")), { start: "2026-12-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" });
  });
});

describe("priceChains: batching", () => {
  it("splits into batches of the given size, in flight at most pullConcurrency", async () => {
    const { http, quotePulls } = fakeDatabento(0.001);
    const client = new DatabentoClient({ dir: tmpDir(), http, apiKey: "k", totalBudgetUsd: 100, sleep: noSleep });
    const out = await priceChains(tickers(10), { client, market: null, snapshot: SNAP, batchSize: 4, pullConcurrency: 3, pull: { caller: "options-daily@t", maxCallUsd: 1, maxCallerUsd: 7 } });
    assert.deepEqual(quotePulls().map((c) => c.symbols.length), [4, 4, 2]);
    assert.equal(out.batches, 3);
    // The fake answers no OPRA records: every name is a data skip, kept for the store.
    assert.equal(out.skipped.filter((s) => s.why === "no quotes at the snapshot").length, 10);
    assert.equal(out.fresh.size, 10);
    // Parent symbology, one OPRA root per name.
    assert.ok(quotePulls().every((c) => c.symbols.every((s) => s.endsWith(".OPT"))));
  });

  it("a failed batch (gateway timeout) is retried name by name", async () => {
    const { http, quotePulls } = fakeDatabento(0.001, (symbols) => (symbols.length > 1 ? 504 : null));
    const client = new DatabentoClient({ dir: tmpDir(), http, apiKey: "k", totalBudgetUsd: 100, sleep: noSleep });
    const out = await priceChains(tickers(3), { client, market: null, snapshot: SNAP, batchSize: 3, pull: { caller: "c", maxCallUsd: 1 } });
    assert.deepEqual(quotePulls().map((c) => c.symbols.length).sort(), [1, 1, 1, 3]); // the batch once (no retry of a timeout), then 3 singles
    assert.equal(out.fresh.size, 3);
    assert.equal(out.stopped, null);
    // The failed batch was charged and refunded: net zero for it.
    assert.ok(Math.abs(client.guard.spentUsd() - 0.003) < 1e-9);
  });

  it("known entries are reused and never pulled", async () => {
    const { http, quotePulls } = fakeDatabento(0.001);
    const client = new DatabentoClient({ dir: tmpDir(), http, apiKey: "k", totalBudgetUsd: 100, sleep: noSleep });
    const known = new Map<string, KnownEntry>([["AAA", T("AAA")], ["BBB", { skip: "poor chain: x" }]]);
    const out = await priceChains(["AAA", "BBB", "CCC"], { client, market: null, snapshot: SNAP, known, pull: { caller: "c", maxCallUsd: 1 } });
    assert.equal(out.reused, 1);
    assert.deepEqual(quotePulls().map((c) => c.symbols), [["CCC.OPT"]]);
    assert.ok(out.result.has("AAA"));
  });

  it("a billing refusal stops quietly with the account error; nothing throws", async () => {
    const { http, quotePulls } = fakeDatabento(0.001, () => 402);
    const client = new DatabentoClient({ dir: tmpDir(), http, apiKey: "k", totalBudgetUsd: 100, sleep: noSleep });
    const out = await priceChains(tickers(12), { client, market: null, snapshot: SNAP, batchSize: 4, pull: { caller: "c", maxCallUsd: 1 } });
    assert.match(out.accountError ?? "", /billing/);
    assert.equal(out.stopped, out.accountError);
    assert.equal(quotePulls().length, 1);
    assert.equal(out.skipped.filter((s) => s.why === "Databento refused").length, 12);
    assert.equal(client.guard.spentUsd(), 0); // charged, then refunded
  });

  it("the deadline starts no new batch", async () => {
    const { http, quotePulls } = fakeDatabento(0.001);
    const client = new DatabentoClient({ dir: tmpDir(), http, apiKey: "k", totalBudgetUsd: 100, sleep: noSleep });
    const out = await priceChains(tickers(8), { client, market: null, snapshot: SNAP, batchSize: 4, deadlineMs: Date.now() - 1, pull: { caller: "c", maxCallUsd: 1 } });
    assert.equal(quotePulls().length, 0);
    assert.equal(out.stopped, "time limit reached");
    assert.equal(out.skipped.filter((s) => s.why === "time limit").length, 8);
  });
});

describe("runDaily: caps, store, ledger", () => {
  const setup = (price: number) => {
    const fake = fakeDatabento(price);
    const client = new DatabentoClient({ dir: tmpDir(), http: fake.http, apiKey: "k", totalBudgetUsd: 1000, sleep: noSleep });
    const store = memoryOptionsStore();
    return { ...fake, client, store };
  };

  it("names already stored for the session are not bought; data skips and ledger lines are stored", async () => {
    const { client, store, quotePulls } = setup(0.002);
    await store.save("2026-11-13", new Map([["TAA", T("TAA")]]), "sightings");
    const s = await runDaily({ client, market: null, store, ledger: store, tickers: tickers(6), nowMs: NOW, batchSize: 4, runCapUsd: 7, monthCapUsd: 110 });
    assert.equal(s.stored, 1);
    assert.equal(s.wanted, 5);
    assert.deepEqual(quotePulls().flatMap((c) => c.symbols).sort(), ["TAB.OPT", "TAC.OPT", "TAD.OPT", "TAE.OPT", "TAF.OPT"]);
    assert.equal((await store.known("2026-11-13", tickers(6))).size, 6);
    assert.ok(store.spend.length >= 2 && store.spend.every((e) => e.caller.startsWith(DAILY_CALLER_PREFIX)));
    assert.ok(Math.abs(s.spendUsd - store.spend.reduce((a, e) => a + e.costUsd, 0)) < 1e-9);
    assert.match(s.line, /^options-daily: 0 of 5 names priced at 2026-11-13 15:45 ET; universe 6, already stored 1/);

    // A second run the same session buys nothing.
    const again = await runDaily({ client, market: null, store, ledger: store, tickers: tickers(6), nowMs: NOW + 3_600_000, runCapUsd: 7, monthCapUsd: 110 });
    assert.equal(again.wanted, 0);
    assert.equal(again.spendUsd, 0);
  });

  it("monthly cap already reached in the persistent ledger: nothing bought, said quietly", async () => {
    const { client, store, quotePulls } = setup(0.002);
    await store.append([{ at: "2026-11-03T22:00:00.000Z", kind: "charge", dataset: "OPRA.PILLAR", schema: "cbbo-1m", symbols: { count: 4, first: [] }, start: "", end: "", costUsd: 110, caller: "options-daily@2026-11-03T22:00Z", key: "k" }]);
    // Last month's spend does not count.
    await store.append([{ at: "2026-10-30T22:00:00.000Z", kind: "charge", dataset: "OPRA.PILLAR", schema: "cbbo-1m", symbols: { count: 4, first: [] }, start: "", end: "", costUsd: 500, caller: "options-daily@2026-10-30T22:00Z", key: "k" }]);
    const s = await runDaily({ client, market: null, store, ledger: store, tickers: tickers(4), nowMs: NOW, runCapUsd: 7, monthCapUsd: 110 });
    assert.match(s.stopped ?? "", /monthly cap reached \(\$110\.00 of \$110\.00\)/);
    assert.equal(quotePulls().length, 0);
  });

  it("the month's remainder caps this run: the pull that would pass it is refused, the job stops quietly", async () => {
    const { client, store, quotePulls } = setup(0.5);
    await store.append([{ at: "2026-11-03T22:00:00.000Z", kind: "charge", dataset: "OPRA.PILLAR", schema: "cbbo-1m", symbols: { count: 4, first: [] }, start: "", end: "", costUsd: 109, caller: "options-daily@2026-11-03T22:00Z", key: "k" }]);
    const s = await runDaily({ client, market: null, store, ledger: store, tickers: tickers(12), nowMs: NOW, batchSize: 4, runCapUsd: 7, monthCapUsd: 110 });
    assert.match(s.stopped ?? "", /cap reached/);
    assert.equal(quotePulls().length, 2); // $0.50 + $0.50 fit in the $1 left; the third is refused before pulling
    assert.equal(s.spendUsd, 1);
    assert.equal(s.skipped.filter((x) => x.why === "cap").length, 4);
  });

  it("the per-run cap stops the run quietly", async () => {
    const { client, store } = setup(3);
    const s = await runDaily({ client, market: null, store, ledger: store, tickers: tickers(12), nowMs: NOW, batchSize: 4, runCapUsd: 7, monthCapUsd: 110 });
    assert.equal(s.spendUsd, 6);
    assert.match(s.stopped ?? "", /cap reached/);
    assert.match(dailyLine(s), /\$6\.00 this run \(cap \$7\.00\), \$6\.00 this month \(cap \$110\.00\)/);
  });

  it("price only: get_cost for every batch, nothing charged or stored", async () => {
    const { client, store, calls } = setup(0.01);
    const s = await runDaily({ client, market: null, store, ledger: store, tickers: tickers(9), nowMs: NOW, batchSize: 4, priceOnly: true, runCapUsd: 7, monthCapUsd: 110 });
    assert.equal(calls.filter((c) => c.endpoint === "timeseries.get_range").length, 0);
    assert.ok(Math.abs(s.pricedUsd - 0.03) < 1e-9);
    assert.equal(store.rows.size, 0);
    assert.equal(store.spend.length, 0);
    assert.match(s.line, /price only/);
  });

  it("no store outside price-only mode: does not start", async () => {
    const { client } = setup(0.01);
    const s = await runDaily({ client, market: null, store: null, ledger: null, tickers: tickers(2), nowMs: NOW });
    assert.match(s.stopped ?? "", /DATABASE_URL/);
  });
});

describe("Sightings reuses the store", () => {
  const card = (ts: string[]): RippleCard =>
    ({
      id: "c",
      sector: "semis",
      generatedAt: "2026-11-15T00:00:00Z",
      event: { id: "e", ticker: ts[0]!, companyName: "", kind: "filing", headline: "", occurredAt: "2026-11-13T12:00:00Z", summary: "", source: { title: "", url: "", publisher: "" } },
      hits: ts.slice(1).map((t) => ({ ticker: t, companyName: t, relation: "peer", degree: 1, direction: "up", confidence: "low", window: "", mechanism: "", evidence: [], history: null })),
    }) as RippleCard;

  it("card tickers priced by the daily job are read from the store, not bought; the rest are bought and stored", async () => {
    const dir = tmpDir();
    const { http, quotePulls } = fakeDatabento(0.001);
    const client = new DatabentoClient({ dir, http, apiKey: "k", totalBudgetUsd: 100, sleep: noSleep });
    const store = memoryOptionsStore();
    await store.save("2026-11-13", new Map([["AMAT", T("AMAT")], ["KLAC", T("KLAC", 0.63)]]), "daily");
    const cards = [card(["AMAT", "KLAC", "LRCX"])];
    const s = await attachOptions(cards, { client, market: null, store, nowMs: NOW, runCapUsd: 0.75, monthCapUsd: 20, cacheDir: path.join(dir, "blocks") });
    assert.equal(s.reused, 2);
    assert.deepEqual(quotePulls().map((c) => c.symbols), [["LRCX.OPT"]]);
    assert.equal(cards[0]!.options?.atmIv, 40);
    assert.equal(cards[0]!.hits[0]!.options?.atmIv, 63);
    assert.equal(cards[0]!.hits[1]!.options, undefined);
    // LRCX had no quotes in the fake: stored as a skip, so the daily job will not buy it again.
    assert.deepEqual((await store.known("2026-11-13", ["LRCX"])).get("LRCX"), { skip: "no quotes at the snapshot" });
    assert.match(s.line, /2 already priced this session/);
  });
});
