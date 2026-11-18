// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/tools/putcall.test.ts
// Synthetic records only (shaped like Databento's JSON), never Databento data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { choosePieces } from "./iv";
import { largestOi, oiFromStatistics, putCallPlan, putCallTotals, shapePutCall, volumeFromOhlcv } from "./putcall";

const osi = (root: string, exp: string, right: "C" | "P", strike: number) => `${root.padEnd(6, " ")}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${right}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
const stat = (id: number, symbol: string, quantity: number, opts: { type?: number; pub?: number; ts?: string } = {}) => ({
  ts_recv: opts.ts ?? "2026-11-16T11:30:00.598483219Z",
  hd: { ts_event: opts.ts ?? "2026-11-16T11:30:00.598281199Z", rtype: 24, publisher_id: opts.pub ?? 61, instrument_id: id },
  price: null,
  quantity,
  stat_type: opts.type ?? 9,
  symbol,
});
const bar = (id: number, symbol: string, volume: number, pub: number) => ({ hd: { ts_event: "2026-11-13T00:00:00.000000000Z", rtype: 35, publisher_id: pub, instrument_id: id }, open: "1.0", high: "1.0", low: "1.0", close: "1.0", volume: String(volume), symbol });

test("putCallPlan: open interest of the latest pre-open, volume of the latest whole session", () => {
  // Monday 2026-11-16 14:00 New York: statistics to today's open, ohlcv-1d through Friday.
  const p = putCallPlan("BRK-B", Date.parse("2026-11-16T19:00:00Z"), Date.parse("2026-11-16T14:30:00Z"), Date.parse("2026-11-14T00:00:00Z"));
  assert.equal(p.oi?.date, "2026-11-16");
  assert.equal(p.oi?.after, "2026-11-13");
  assert.deepEqual(p.oi?.req, { dataset: "OPRA.PILLAR", schema: "statistics", symbols: ["BRKB.OPT"], stype_in: "parent", start: "2026-11-16T11:29:30.000Z", end: "2026-11-16T11:31:00.000Z" });
  assert.deepEqual([p.oi?.wide?.start, p.oi?.wide?.end], ["2026-11-16T05:00:00.000Z", "2026-11-16T14:30:00.000Z"]);
  // Summer time: 06:30 New York is 10:30 UTC.
  assert.equal(putCallPlan("AAPL", Date.parse("2026-07-15T18:00:00Z"), null, null).oi?.req.start, "2026-07-15T10:29:30.000Z");
  // 08:00 New York with statistics to now: today's 06:30 broadcast, no whole pre-open yet.
  const morning = putCallPlan("AAPL", Date.parse("2026-11-16T13:00:00Z"), Date.parse("2026-11-16T13:00:00Z"), null);
  assert.deepEqual([morning.oi?.date, morning.oi?.wide], ["2026-11-16", null]);
  assert.equal(p.volume?.session, "2026-11-13");
  assert.deepEqual(p.volume?.req, { dataset: "OPRA.PILLAR", schema: "ohlcv-1d", symbols: ["BRKB.OPT"], stype_in: "parent", start: "2026-11-13", end: "2026-11-14" });
  assert.equal(p.key, "BRK-B|oi:2026-11-16|vol:2026-11-13");
  // Monday 07:00 New York, statistics only through Friday's open: Friday's pre-open (positions after Thursday).
  const early = putCallPlan("AAPL", Date.parse("2026-11-16T12:00:00Z"), Date.parse("2026-11-14T00:00:00Z"), Date.parse("2026-11-14T00:00:00Z"));
  assert.deepEqual([early.oi?.date, early.oi?.after, early.volume?.session], ["2026-11-13", "2026-11-12", "2026-11-13"]);
  // No ranges known: the clock decides (Friday's bar from Saturday 12:00 UTC).
  const sat = putCallPlan("AAPL", Date.parse("2026-11-14T13:00:00Z"), null, null);
  assert.deepEqual([sat.oi?.date, sat.volume?.session], ["2026-11-13", "2026-11-13"]);
  const fri = putCallPlan("AAPL", Date.parse("2026-11-13T22:00:00Z"), null, null);
  assert.equal(fri.volume?.session, "2026-11-12");
});

test("oiFromStatistics: open interest only, one per contract (latest of the exchanges), standard root only", () => {
  const c = osi("AAPL", "2026-11-20", "C", 230);
  const p = osi("AAPL", "2026-11-20", "P", 220);
  const recs = [
    stat(1, c, 900, { pub: 20, ts: "2026-11-16T11:30:00.1Z" }),
    stat(1, c, 1000, { pub: 21, ts: "2026-11-16T11:30:00.2Z" }),
    stat(2, p, 1500),
    stat(2, p, 777, { type: 6 }), // cleared volume, not open interest
    stat(3, osi("AAPL1", "2026-11-20", "P", 220), 50), // adjusted contract
    stat(4, osi("AAPL", "2026-12-18", "P", 200), 2147483647), // sentinel
    stat(5, "garbage", 10),
  ];
  const rows = oiFromStatistics(recs, "AAPL");
  assert.deepEqual(
    rows.sort((a, b) => a.strike - b.strike),
    [
      { expiration: "2026-11-20", strike: 220, right: "P", n: 1500 },
      { expiration: "2026-11-20", strike: 230, right: "C", n: 1000 },
    ],
  );
});

test("volumeFromOhlcv sums the exchanges' bars per contract", () => {
  const c = osi("SOUN", "2026-11-27", "C", 5.5);
  const p = osi("SOUN", "2026-11-27", "P", 5);
  const rows = volumeFromOhlcv([bar(1, c, 13, 35), bar(1, c, 2, 22), bar(2, p, 7, 20), bar(3, osi("SOUN", "2026-11-27", "P", 6), 0, 20)], "SOUN");
  const t = putCallTotals(rows);
  assert.deepEqual(t, { calls: 15, puts: 7, ratio: 0.47 });
  assert.deepEqual(putCallTotals([]), { calls: 0, puts: 0, ratio: null });
  assert.deepEqual(putCallTotals([{ expiration: "2026-11-20", strike: 5, right: "P", n: 3 }]).ratio, null, "no calls: no ratio");
});

test("largestOi: the three biggest, compact", () => {
  const rows = [
    { expiration: "2026-12-18", strike: 600, right: "P" as const, n: 120_000 },
    { expiration: "2026-11-20", strike: 680, right: "C" as const, n: 90_000 },
    { expiration: "2026-11-20", strike: 650, right: "P" as const, n: 120_000 },
    { expiration: "2027-01-15", strike: 700, right: "C" as const, n: 10 },
    { expiration: "2027-01-15", strike: 710, right: "C" as const, n: 0 },
  ];
  assert.deepEqual(largestOi(rows), [["2026-11-20", 650, "P", 120000], ["2026-12-18", 600, "P", 120000], ["2026-11-20", 680, "C", 90000]]);
});

test("choosePieces: chain first, then open interest, then volume, within one per-pull limit and the month caps", () => {
  const caps = { maxPullUsd: 0.25, callerMonthUsd: 10, totalMonthUsd: 110 };
  const m = { callerUsd: 1, totalUsd: 50 };
  // SPY-like: chain 0.019 + OI 0.163 fit; volume 1.25 does not.
  const spy = choosePieces([{ what: "chain", costUsd: 0.019 }, { what: "oi", costUsd: 0.163 }, { what: "volume", costUsd: 1.25 }], m, caps);
  assert.deepEqual(spy.buy, ["chain", "oi"]);
  assert.match(spy.refused.volume!, /\$1\.25 of OPRA data \(\$1\.43 with the rest of this pull\), over the \$0\.25 limit/);
  // Volume alone would fit, but not with the rest: refused, the message says so.
  const mid = choosePieces([{ what: "oi", costUsd: 0.1 }, { what: "volume", costUsd: 0.2 }], m, caps);
  assert.deepEqual(mid.buy, ["oi"]);
  assert.match(mid.refused.volume!, /\(\$0\.30 with the rest/);
  // Small name: all three.
  assert.deepEqual(choosePieces([{ what: "chain", costUsd: 0.0004 }, { what: "oi", costUsd: 0.005 }, { what: "volume", costUsd: 0.035 }], m, caps).buy, ["chain", "oi", "volume"]);
  // The chain keeps its own message; the month caps count the pieces before.
  assert.match(choosePieces([{ what: "chain", costUsd: 0.3 }], m, caps).refused.chain!, /this chain alone is priced at \$0\.30/);
  const month = choosePieces([{ what: "chain", costUsd: 0.01 }, { what: "oi", costUsd: 0.01 }], { callerUsd: 9.985, totalUsd: 20 }, caps);
  assert.deepEqual(month.buy, ["chain"]);
  assert.match(month.refused.oi!, /monthly budget for on-demand options data/);
  assert.match(choosePieces([{ what: "oi", costUsd: 0.01 }], { callerUsd: 0, totalUsd: 109.995 }, caps).refused.oi!, /monthly Databento budget/);
  assert.match(choosePieces([{ what: "oi", costUsd: 0.01 }], null, caps).refused.oi!, /ledger could not be read/);
  assert.match(choosePieces([{ what: "volume", costUsd: Number.NaN }], m, caps).refused.volume!, /could not price/);
});

test("shapePutCall: dates, ratio, meaning; nothing when neither piece came", () => {
  const out = shapePutCall({
    oi: { calls: 1000, puts: 1500, ratio: 1.5, date: "2026-11-16", after: "2026-11-13", largest: [["2026-11-20", 220, "P", 1500]] },
    volume: null,
    costUsd: 0.0431,
    notes: ["Put/call volume not bought: it would cost $0.34 of OPRA data"],
  }) as Record<string, unknown>;
  assert.equal((out.openInterest as { asOf: string }).asOf, "2026-11-16 pre-open (positions after the 2026-11-13 close)");
  assert.equal((out.openInterest as { ratio: number }).ratio, 1.5);
  assert.equal(out.volume, null);
  assert.equal(out.data, "on demand, $0.0431");
  assert.match(String(out.meaning), /hedging/);
  assert.match(String(out.meaning), /not necessarily a bearish bet/);
  assert.deepEqual(shapePutCall({ oi: null, volume: null, costUsd: 0, notes: ["x"] }), { volume: null, openInterest: null, notes: ["x"] });
});
