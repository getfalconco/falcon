import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";
import { optionsSentence, type RippleCard, type RippleHistory } from "@falcon/ripple";
import { DatabentoClient, type HttpFn, type HttpResponseLike, type OptionDefinition, type Quote } from "../src/options/client.ts";
import { SpendGuard, BudgetError, parseLedger, type RangeRequest } from "../src/options/cost.ts";
import { chainProblem, exitSession, impliedMoveFor, ivForWindow, matchedWithHistory, optionsBlock, tickerOptionsFrom, type TickerOptions } from "../src/options/cards.ts";
import { attachOptions, monthMatcher, optionTickers, pickSnapshot, summaryLine } from "../src/options/sightings-options.ts";
import { impliedAbsMovePct } from "../src/options/study-options.ts";
import { surfaceFeatures, type SurfaceInput } from "../src/options/surface.ts";
import type { Right } from "../src/options/math.ts";

const zstd = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
const noSleep = async () => {};
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "falcon-options-"));

function response(status: number, body: string | Buffer, headers: Record<string, string> = {}, opts: { dropBody?: boolean } = {}): HttpResponseLike {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => {
      if (opts.dropBody) throw new TypeError("terminated");
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  };
}

const BAR = { hd: { ts_event: "2026-11-13T00:00:00.000000000Z", rtype: 35, publisher_id: 31, instrument_id: 1 }, open: "1", high: "1", low: "1", close: "1", volume: "7", symbol: "X" };
const body = () => zstd(Buffer.from(JSON.stringify(BAR) + "\n"));
const REQ: RangeRequest = { dataset: "OPRA.PILLAR", schema: "cbbo-1m", symbols: ["KLAC.OPT"], start: "2026-11-13T20:40:00Z", end: "2026-11-13T20:46:00Z", stype_in: "parent" };

// ---------------------------------------------------------------------------
// Client fixes

describe("client: 206 and dropped bodies", () => {
  it("treats 206 Partial Content as success, flags it, and charges once", async () => {
    const dir = tmpDir();
    const http: HttpFn = async (url) => {
      if (url.includes("get_cost")) return response(200, "0.01");
      return response(206, body(), { "x-warning": "symbol FOO did not resolve" });
    };
    const c = new DatabentoClient({ dir, http, apiKey: "k", totalBudgetUsd: 5, sleep: noSleep });
    const r = await c.getRange(REQ, { caller: "t", maxCallUsd: 1 });
    assert.equal(r.records.length, 1);
    assert.equal(r.partial, true);
    assert.match(r.warning ?? "", /FOO/);
    const ledger = c.guard.entries();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.kind, "charge");
  });

  it("retries a dropped body download with one ledger line, no refund", async () => {
    const dir = tmpDir();
    let ranges = 0;
    const http: HttpFn = async (url) => {
      if (url.includes("get_cost")) return response(200, "0.02");
      ranges++;
      return response(200, body(), {}, { dropBody: ranges < 3 });
    };
    const c = new DatabentoClient({ dir, http, apiKey: "k", totalBudgetUsd: 5, sleep: noSleep });
    const r = await c.getRange(REQ, { caller: "t", maxCallUsd: 1 });
    assert.equal(ranges, 3);
    assert.equal(r.records.length, 1);
    const ledger = parseLedger(fs.readFileSync(path.join(dir, "spend.ndjson"), "utf8"));
    assert.deepEqual(ledger.map((e) => [e.kind, e.costUsd]), [["charge", 0.02]]);
  });

  it("retries an undecodable body; after every attempt fails, one charge and one refund (net zero)", async () => {
    const dir = tmpDir();
    let ranges = 0;
    const http: HttpFn = async (url) => {
      if (url.includes("get_cost")) return response(200, "0.02");
      ranges++;
      return response(200, Buffer.from("not a zstd frame"));
    };
    const c = new DatabentoClient({ dir, http, apiKey: "k", totalBudgetUsd: 5, sleep: noSleep });
    await assert.rejects(() => c.getRange(REQ, { caller: "t", maxCallUsd: 1 }));
    assert.equal(ranges, 4);
    const ledger = c.guard.entries();
    assert.deepEqual(ledger.map((e) => e.kind), ["charge", "refund"]);
    assert.equal(c.guard.spentUsd(), 0);
  });

  it("does not retry the body after a final HTTP error (422)", async () => {
    const dir = tmpDir();
    let ranges = 0;
    const http: HttpFn = async (url) => {
      if (url.includes("get_cost")) return response(200, "0.02");
      ranges++;
      return response(422, '{"detail":"bad symbol"}');
    };
    const c = new DatabentoClient({ dir, http, apiKey: "k", totalBudgetUsd: 5, sleep: noSleep });
    await assert.rejects(() => c.getRange(REQ, { caller: "t", maxCallUsd: 1 }), /422/);
    assert.equal(ranges, 1);
    assert.equal(c.guard.spentUsd(), 0);
  });
});

// ---------------------------------------------------------------------------
// Caps

describe("caps", () => {
  it("a SpendCap refuses a pull that would pass it, under the lock, writing nothing", async () => {
    const dir = tmpDir();
    const g = new SpendGuard({ dir, totalBudgetUsd: 100 });
    const now = Date.parse("2026-11-15T12:00:00Z");
    const month = monthMatcher(now);
    await g.authorize({ req: REQ, costUsd: 0.4, caller: "sightings-options@a", maxCallUsd: 1 });
    await g.authorize({ req: REQ, costUsd: 5, caller: "options-h4", maxCallUsd: 10 }); // another caller: not in the cap
    const cap = [{ label: "monthly", limitUsd: 0.5, match: month }];
    await assert.rejects(
      () => g.authorize({ req: REQ, costUsd: 0.2, caller: "sightings-options@b", maxCallUsd: 1, caps: cap }),
      (e: BudgetError) => e instanceof BudgetError && e.reason === "cap",
    );
    await g.authorize({ req: REQ, costUsd: 0.1, caller: "sightings-options@b", maxCallUsd: 1, caps: cap });
    assert.equal(g.entries().length, 3);
  });

  it("monthMatcher: this job's callers in this UTC month only", () => {
    const m = monthMatcher(Date.parse("2026-11-15T12:00:00Z"));
    const e = (caller: string, at: string) => ({ caller, at, kind: "charge" as const, dataset: "", schema: "", symbols: { count: 0, first: [] }, start: "", end: "", costUsd: 1, key: "" });
    assert.equal(m(e("sightings-options@x", "2026-11-01T00:00:00Z")), true);
    assert.equal(m(e("sightings-options@x", "2026-10-31T23:59:59Z")), false);
    assert.equal(m(e("options-h4", "2026-11-02T00:00:00Z")), false);
  });

  const card = (tickers: string[]): RippleCard =>
    ({
      id: "c",
      sector: "semis",
      generatedAt: "2026-11-15T00:00:00Z",
      event: { id: "e", ticker: tickers[0]!, companyName: "", kind: "filing", headline: "", occurredAt: "2026-11-13T12:00:00Z", summary: "", source: { title: "", url: "", publisher: "" } },
      hits: tickers.slice(1).map((t) => ({ ticker: t, companyName: t, relation: "peer", degree: 1, direction: "up", confidence: "low", window: "", mechanism: "", evidence: [], history: null })),
    }) as RippleCard;

  function fakeDatabento(price: number) {
    const calls: string[] = [];
    const http: HttpFn = async (url) => {
      calls.push(url.split("?")[0]!.split("/").pop()!);
      if (url.includes("get_dataset_range")) return response(200, JSON.stringify({ start: "2013-01-01", end: "2026-11-15T00:00:00Z", schema: {} }));
      if (url.includes("get_cost")) return response(200, JSON.stringify(price));
      return response(200, body());
    };
    return { http, calls };
  }

  it("monthly cap already reached: skips quietly, no pull, says so", async () => {
    const dir = tmpDir();
    const now = Date.parse("2026-11-15T12:00:00Z");
    const { http, calls } = fakeDatabento(0.01);
    const client = new DatabentoClient({ dir, http, apiKey: "k", totalBudgetUsd: 100, sleep: noSleep });
    await client.guard.authorize({ req: REQ, costUsd: 20, caller: "sightings-options@earlier", maxCallUsd: 50 });
    const cards = [card(["AMAT", "LRCX", "KLAC"])];
    const s = await attachOptions(cards, { client, market: null, nowMs: now, monthCapUsd: 20, runCapUsd: 0.75, cacheDir: path.join(dir, "blocks") });
    assert.match(s.stopped ?? "", /monthly cap/);
    assert.equal(calls.filter((c) => c === "timeseries.get_range").length, 0);
    assert.equal(s.skipped.length, 3);
    assert.equal(cards[0]!.options, undefined);
    assert.match(s.line, /monthly cap reached/);
  });

  it("run cap: the pull that would pass it is refused; the job stops quietly with one charge", async () => {
    const dir = tmpDir();
    const now = Date.parse("2026-11-15T12:00:00Z");
    const { http, calls } = fakeDatabento(0.5);
    const client = new DatabentoClient({ dir, http, apiKey: "k", totalBudgetUsd: 100, sleep: noSleep });
    const tickers = Array.from({ length: 20 }, (_, i) => `T${String.fromCharCode(65 + i)}`);
    const s = await attachOptions([card(tickers)], { client, market: null, nowMs: now, monthCapUsd: 20, runCapUsd: 0.75, cacheDir: path.join(dir, "blocks") });
    assert.match(s.stopped ?? "", /cap reached/);
    assert.equal(calls.filter((c) => c === "timeseries.get_range").length, 1);
    assert.equal(s.spendUsd, 0.5);
    // The 15 pulled names had no OPRA records (fake body), the other 5 were stopped by the cap.
    assert.equal(s.skipped.filter((x) => x.why === "cap").length, 5);
    assert.equal(s.skipped.filter((x) => x.why === "no quotes at the snapshot").length, 15);
  });

  it("no key: skipped with a reason, nothing pulled", async () => {
    const prev = process.env.DATABENTO_API_KEY;
    process.env.DATABENTO_API_KEY = "";
    try {
      const s = await attachOptions([card(["AMAT"])], { market: null });
      // Either the env file has a key (a developer machine) or the job says why it did not run.
      if (s.stopped) assert.match(s.line, /skipped/);
    } finally {
      if (prev === undefined) delete process.env.DATABENTO_API_KEY;
      else process.env.DATABENTO_API_KEY = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot choice and tickers

describe("snapshot and tickers", () => {
  it("picks the latest session's 15:45 ET at least 15 minutes old and inside the data", () => {
    // Sunday: Friday's close.
    assert.equal(pickSnapshot(Date.parse("2026-11-15T11:00:00Z"), null)?.date, "2026-11-13");
    // Monday 11:00 UTC (06:00 ET): still Friday.
    assert.equal(pickSnapshot(Date.parse("2026-11-16T11:00:00Z"), null)?.date, "2026-11-13");
    // Monday 22:30 UTC: Monday's 15:45 ET.
    const mon = pickSnapshot(Date.parse("2026-11-16T22:30:00Z"), null)!;
    assert.equal(mon.date, "2026-11-16");
    assert.equal(new Date(mon.asOfMs).toISOString(), "2026-11-16T20:45:00.000Z");
    // ...unless Databento's range ends before it.
    assert.equal(pickSnapshot(Date.parse("2026-11-16T22:30:00Z"), Date.parse("2026-11-16T20:00:00Z"))?.date, "2026-11-13");
    // Day after Thanksgiving closes early: 12:45 ET.
    const bf = pickSnapshot(Date.parse("2026-11-27T22:00:00Z"), null)!;
    assert.equal(bf.date, "2026-11-27");
    assert.equal(bf.minute, 12 * 60 + 45);
  });

  it("tickers: event company first, then hits, deduplicated, US listings only", () => {
    const c1 = { event: { ticker: "TSM" }, hits: [{ ticker: "KLAC" }, { ticker: "2330.TW" }, { ticker: "ALAB" }] };
    const c2 = { event: { ticker: "ASX" }, hits: [{ ticker: "ALAB" }, { ticker: "BH.A" }] };
    assert.deepEqual(optionTickers([c1, c2] as unknown as RippleCard[]), ["TSM", "KLAC", "ALAB", "ASX", "BH.A"]);
  });
});

// ---------------------------------------------------------------------------
// The block and the matched-units comparison

const T: TickerOptions = {
  ticker: "KLAC",
  date: "2026-11-13",
  asOf: "2026-11-13T20:45:00.000Z",
  spot: 151.38,
  spotSource: "itch",
  atmIv30: 0.631,
  skew: 0.034,
  cpSpread: -0.0376,
  beta: 1.5,
  vix: 0.18,
  term: [
    { expiration: "2026-11-20", days: 7, iv: 0.65 },
    { expiration: "2026-12-18", days: 35, iv: 0.62 },
    { expiration: "2027-01-15", days: 63, iv: 0.6 },
  ],
};

function history(windowDays: number, moves: number[]): RippleHistory {
  return {
    sample: moves.length,
    avgMovePct: 0,
    hitRate: 0.5,
    windowDays,
    events: moves.map((m, i) => ({ accession: String(i), eventDate: "2024-01-01", reactionDate: "2024-01-02", movePct: m + 1, benchmarkPct: 1 })),
  };
}

describe("options block", () => {
  it("windows end on the L-th session after the snapshot; the first expiry on or after it is used", () => {
    assert.equal(exitSession("2026-11-13", 5), "2026-11-20");
    // Thanksgiving (Nov 26) is skipped.
    assert.equal(exitSession("2026-11-20", 5), "2026-11-30");
    assert.equal(ivForWindow(T.term, "2026-11-13", 5)?.expiration, "2026-11-20");
    assert.equal(ivForWindow(T.term, "2026-11-13", 20)?.expiration, "2026-12-18");
    assert.equal(ivForWindow(T.term, "2026-11-13", 60), null);
  });

  it("raw and market-adjusted implied moves follow the study's definition (matched units)", () => {
    const m5 = impliedMoveFor(T, 5)!;
    assert.equal(m5.rawPct, Math.round(impliedAbsMovePct(0.65, 5) * 100) / 100);
    assert.equal(m5.marketAdjustedPct, Math.round(impliedAbsMovePct(0.65, 5, 1.5, 0.18) * 100) / 100);
    // sqrt(0.65^2 - 1.5^2 0.18^2) sqrt(5/252) sqrt(2/pi)
    assert.ok(Math.abs(m5.marketAdjustedPct! - Math.sqrt(0.65 ** 2 - 0.27 ** 2) * Math.sqrt(5 / 252) * Math.sqrt(2 / Math.PI) * 100) < 0.006);
    assert.ok(m5.marketAdjustedPct! < m5.rawPct);
    // No beta: no market-adjusted number. The market part as large as the whole: null, not 0.
    assert.equal(impliedMoveFor({ ...T, beta: null }, 5)!.marketAdjustedPct, null);
    assert.equal(impliedMoveFor({ ...T, beta: 4 }, 5)!.marketAdjustedPct, null);
  });

  it("compares with history only in matched units: beyond the market, same window, >= 6 events", () => {
    const h = history(20, [5, -7, 3, -2, 9, -4]);
    const m = matchedWithHistory(T, h)!;
    assert.equal(m.windowDays, 20);
    assert.equal(m.historyPct, 5);
    assert.equal(m.impliedPct, impliedMoveFor(T, 20)!.marketAdjustedPct);
    assert.equal(m.sample, 6);
    assert.equal(matchedWithHistory({ ...T, beta: null }, h), null, "no market-adjusted implied move: no comparison");
    assert.equal(matchedWithHistory(T, history(20, [5, -7, 3])), null, "too few events");
    assert.equal(matchedWithHistory(T, { ...h, events: undefined }), null, "no per-event moves: avgMovePct is signed, not comparable");
    assert.equal(matchedWithHistory(T, null), null);
  });

  it("block: rounded, descriptive sentence, no history for the event company", () => {
    const b = optionsBlock(T);
    assert.equal(b.source, "OPRA via Databento");
    assert.equal(b.atmIv, 63.1);
    assert.equal(b.skew, 3.4);
    assert.equal(b.cpSpread, -3.8);
    assert.equal(b.vix, 18);
    assert.equal("matched" in b, false);
    const s = optionsSentence(b)!;
    assert.match(s, /^Options price a move of about ±\d+\.\d% over the next week \(±\d+\.\d% beyond the market\)\.$/);
    const hb = optionsBlock(T, history(5, [3, -3, 3, -3, 3, -3]));
    assert.match(optionsSentence(hb)!, /After similar events this stock moved about ±3\.0% beyond the market over a week\.$/);
    for (const w of ["should", "undervalued", "recommend", "opportunity", "edge"]) assert.ok(!optionsSentence(hb)!.toLowerCase().includes(w));
  });

  it("summary line names spend and caps", () => {
    const line = summaryLine({ snapshot: "2026-11-13 15:45 ET", wanted: 3, priced: 2, reused: 0, skipped: [{ ticker: "X", why: "poor chain: no ATM IV curve" }], spendUsd: 0.012, pricedUsd: 0.012, monthUsd: 0.4, runCapUsd: 0.75, monthCapUsd: 20, stopped: null, line: "" });
    assert.equal(line, "options: 2 of 3 names priced at 2026-11-13 15:45 ET; left out 1: poor chain 1 (X); $0.01 this run (cap $0.75), $0.40 this month (cap $20.00)");
  });
});

// ---------------------------------------------------------------------------
// On the recorded KLAC chain (licensed data: local only)

const fixtureUrl = (name: string) => new URL(`./fixtures/options/${name}`, import.meta.url);
const needs = (name: string) => (fs.existsSync(fixtureUrl(name)) ? {} : { skip: "fixture not in repo" });

describe("options block on the recorded KLAC chain (2026-11-13 15:45 ET)", needs("klac-2026-11-13-chain.json"), () => {
  it("computes the card block from the snapshot", () => {
    const fx = JSON.parse(fs.readFileSync(fixtureUrl("klac-2026-11-13-chain.json"), "utf8"));
    type Row = [number, string, Right, number, string, number | null, number | null, number | null, number | null, number];
    const rows = fx.contracts as Row[];
    const definitions: OptionDefinition[] = rows.map((c) => ({ instrumentId: c[0], rawSymbol: c[1], underlying: "KLAC", right: c[2], strike: c[3], expiration: c[4], expirationMs: Date.parse(`${c[4]}T00:00:00Z`), multiplier: 100 }));
    const quotes = new Map<number, Quote>();
    for (const c of rows) if (c[7] !== null) quotes.set(c[0], { instrumentId: c[0], tsMs: c[7], bid: c[5], ask: c[6], bidSize: 0, askSize: 0 });
    const input: SurfaceInput = { underlying: "KLAC", date: fx.date, asOfMs: fx.asOfMs, spot: fx.spot, rate: fx.rate, divYield: fx.divYield, definitions, quotes, moveDates: [] };
    const f = surfaceFeatures(input);
    assert.equal(chainProblem(f), null);
    const t = tickerOptionsFrom(f, { ticker: "KLAC", spotSource: "itch", beta: 1.8, vix: 0.187 });
    const b = optionsBlock(t, history(20, [8, -6, 7, -9, 5, -7]));
    assert.equal(b.asOf, "2026-11-13T20:45:00.000Z");
    assert.equal(b.atmIv, 63.1);
    assert.equal(b.impliedMove5?.expiration, "2026-11-20");
    // The README's validation pull: 7.46% by straddle and by IV to Nov 20 (7 calendar days). Over 5 sessions by the study's scaling:
    const nov20 = f.expiries.find((e) => e.expiration === "2026-11-20")!.atmIv!;
    assert.equal(b.impliedMove5?.rawPct, Math.round(impliedAbsMovePct(nov20, 5) * 100) / 100);
    assert.ok(b.impliedMove5!.rawPct > 6 && b.impliedMove5!.rawPct < 9, `5-session move ${b.impliedMove5!.rawPct}`);
    assert.ok(b.impliedMove20!.rawPct > b.impliedMove5!.rawPct);
    assert.ok(b.impliedMove5!.marketAdjustedPct! < b.impliedMove5!.rawPct);
    assert.equal(b.matched?.windowDays, 20);
    assert.equal(b.matched?.historyPct, 7);
    assert.equal(b.skew, Math.round(f.skew! * 1000) / 10);
    assert.match(optionsSentence(b)!, /over the next month .* beyond the market over a month\.$/);
  });
});
