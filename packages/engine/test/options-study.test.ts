import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignBars,
  benjaminiHochberg,
  clusteredOls,
  clusteredSlope,
  definitionsFromRecords,
  impliedAbsMovePct,
  monthEndSessions,
  parseOsi,
  perNameCorrelations,
  ranks,
  recordsByRoot,
  seriesTest,
  snapshotIndexAfter,
  sortSpreads,
  spearman,
  summarizeH7,
  summarizeSort,
  terciles,
  trailingChange,
  trailingMedian,
  type H7Pair,
  type PanelRow,
} from "../src/options/study-options.ts";
import { measureEvent, nyInstantMs, nyseSessions } from "../src/study/abnormal.ts";

test("parseOsi reads padded and compact OCC symbols", () => {
  assert.deepEqual(parseOsi("KLAC  261120C00150000"), { root: "KLAC", expiration: "2026-11-20", right: "C", strike: 150 });
  assert.deepEqual(parseOsi("ON    250117P00012500"), { root: "ON", expiration: "2025-01-17", right: "P", strike: 12.5 });
  assert.deepEqual(parseOsi("KLAC1 261120C00150000")?.root, "KLAC1");
  assert.equal(parseOsi("KLAC"), null);
  assert.equal(parseOsi("KLAC  261320C00150000"), null);
});

test("definitionsFromRecords keeps the standard root, one per instrument", () => {
  const recs = [
    { hd: { instrument_id: 1 }, symbol: "KLAC  261120C00150000" },
    { hd: { instrument_id: 1 }, symbol: "KLAC  261120C00150000" },
    { hd: { instrument_id: 2 }, symbol: "KLAC  261120P00140000" },
    { hd: { instrument_id: 3 }, symbol: "KLAC1 261120P00140000" },
    { hd: { instrument_id: 4 }, symbol: "LRCX  261120P00140000" },
  ];
  const defs = definitionsFromRecords(recs, "KLAC");
  assert.equal(defs.length, 2);
  const put = defs.find((d) => d.instrumentId === 2)!;
  assert.equal(put.right, "P");
  assert.equal(put.strike, 140);
  assert.equal(put.expiration, "2026-11-20");
  assert.equal(put.multiplier, 100);
  const groups = recordsByRoot(recs);
  assert.deepEqual([...groups.keys()].sort(), ["KLAC", "KLAC1", "LRCX"]);
  assert.equal(groups.get("KLAC")!.length, 3);
});

test("alignBars: adjusted opens, unadjusted close and volume across a split", () => {
  const sessions = ["2024-06-07", "2024-06-10", "2024-06-11"];
  // 10-for-1 split effective 2024-06-10; Yahoo shows split-adjusted prices and volume.
  const y = {
    d: ["2024-06-07", "2024-06-10", "2024-06-11"],
    o: [120, 121, 122],
    c: [121, 122, 123],
    a: [120, 121, 123],
    v: [4_000_000, 3_000_000, 2_000_000],
    splits: [{ date: "2024-06-10", ratio: 10 }],
  };
  const s = alignBars(y, sessions);
  assert.equal(s.rawClose[0], 1210);
  assert.equal(s.rawVolume[0], 400_000);
  assert.equal(s.rawClose[1], 122);
  assert.equal(s.rawVolume[2], 2_000_000);
  assert.ok(Math.abs(s.open[0]! - 120 * (120 / 121)) < 1e-9);
  assert.equal(s.close[2], 123);
  assert.equal(s.first, 0);
  assert.equal(s.last, 2);
  assert.equal(trailingMedian([1, 2, 3, NaN, 5], 4, 4), 2);
  assert.equal(trailingMedian([NaN, NaN, NaN, 1], 3, 4), null);
});

test("monthEndSessions picks the last session of each month", () => {
  const sessions = nyseSessions("2019-10-01", "2019-12-31");
  assert.deepEqual(monthEndSessions(sessions, "2019-10", "2019-12"), ["2019-10-31", "2019-11-29", "2019-12-31"]);
});

test("terciles split by rank with deterministic ties", () => {
  const t = terciles([
    { ticker: "A", value: 3 },
    { ticker: "B", value: 1 },
    { ticker: "C", value: 2 },
    { ticker: "D", value: 2 },
    { ticker: "E", value: 9 },
    { ticker: "F", value: 0 },
  ]);
  assert.equal(t.get("F"), 1);
  assert.equal(t.get("B"), 1);
  assert.equal(t.get("C"), 2);
  assert.equal(t.get("D"), 2);
  assert.equal(t.get("A"), 3);
  assert.equal(t.get("E"), 3);
});

function row(date: string, ticker: string, x: number | null, y: number | null): PanelRow {
  return { date, ticker, x: { f: x }, y: { car: y } };
}

test("trailingChange uses only earlier snapshots of the same name", () => {
  const rows = [row("2020-01-31", "A", 1, 0), row("2020-02-28", "A", 2, 0), row("2020-03-31", "A", 3, 0), row("2020-04-30", "A", 10, 0), row("2020-04-30", "B", 5, 0)];
  const m = trailingChange(rows, "f", 6, 3);
  assert.equal(m.get("2020-03-31|A"), null); // only 2 prior
  assert.equal(m.get("2020-04-30|A"), 10 - 2);
  assert.equal(m.get("2020-04-30|B"), null);
  const lg = trailingChange(rows, "f", 2, 2, true);
  assert.ok(Math.abs(lg.get("2020-04-30|A")! - Math.log(10 / 2.5)) < 1e-12);
});

test("sortSpreads: long-short orientation and the date filter", () => {
  const rows: PanelRow[] = [];
  // Date 1: 9 names, outcome = -feature (low feature does better).
  for (let k = 0; k < 9; k++) rows.push(row("2020-01-31", `N${k}`, k, -k));
  // Date 2: only 3 names: skipped by minNames 9.
  for (let k = 0; k < 3; k++) rows.push(row("2020-02-28", `N${k}`, k, k));
  const low = sortSpreads(rows, { feature: (r) => r.x.f ?? null, outcome: (r) => r.y.car ?? null, sign: -1 });
  assert.equal(low.dates.length, 1);
  const d = low.dates[0]!;
  assert.equal(d.longN, 3);
  assert.equal(d.shortN, 3);
  assert.equal(d.longMean, -1); // names 0,1,2
  assert.equal(d.shortMean, -7); // names 6,7,8
  assert.equal(d.spread, 6);
  assert.equal(low.signed.length, 6);
  assert.equal(low.signed.reduce((s, o) => s + o.value, 0), -3 + 21);
  const high = sortSpreads(rows, { feature: (r) => r.x.f ?? null, outcome: (r) => r.y.car ?? null, sign: 1 });
  assert.equal(high.dates[0]!.spread, -6);
});

test("summarizeSort: Fama-MacBeth over dates, costs, split, recent", () => {
  const dates = Array.from({ length: 12 }, (_, i) => ({ date: `20${10 + i}-01-31`, names: 9, longN: 3, shortN: 3, longMean: 1, shortMean: 0, spread: i % 2 ? 2 : 0 }));
  const s = summarizeSort({ dates, signed: [] }, { recentDates: 4 });
  assert.equal(s.dates, 12);
  assert.equal(s.fm!.mean, 1);
  assert.equal(s.fm!.df, 11);
  assert.ok(Math.abs(s.netMean! - 0.6) < 1e-12);
  assert.equal(s.split.early!.n, 8);
  assert.equal(s.split.late!.n, 4);
  assert.equal(s.split.cut, "2018-01-31");
  assert.equal(s.recent.dates, 4);
  assert.equal(s.recent.from, "2018-01-31");
  assert.equal(s.byYear.length, 12);
  assert.equal(s.pooled, null);
});

test("seriesTest and one-sided p", () => {
  const t = seriesTest([1, 2, 3, 4, 5])!;
  assert.equal(t.mean, 3);
  assert.ok(t.t > 4);
  assert.ok(t.pOne < 0.01);
  assert.ok(Math.abs(t.pTwo - 2 * t.pOne) < 1e-12);
  assert.equal(seriesTest([1, 2]), null);
  const neg = seriesTest([-1, -2, -3])!;
  assert.ok(neg.pOne > 0.9);
});

test("ranks, Spearman and per-name correlations (signed)", () => {
  assert.deepEqual(ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  const rows: PanelRow[] = [];
  for (let k = 0; k < 30; k++) rows.push(row(`d${String(k).padStart(2, "0")}`, "A", k, -k));
  const res = perNameCorrelations(rows, (r) => r.x.f ?? null, (r) => r.y.car ?? null, -1);
  assert.equal(res.names.length, 1);
  assert.equal(res.names[0]!.rho, 1);
  assert.equal(res.positiveShare, 1);
});

test("Benjamini-Hochberg matches the step-up rule", () => {
  const adj = benjaminiHochberg([0.01, 0.04, 0.03, 0.2]);
  assert.deepEqual(
    adj.map((x) => Math.round(x * 1e6) / 1e6),
    [0.04, 0.053333, 0.053333, 0.2],
  );
});

test("impliedAbsMovePct removes the market part and scales by horizon", () => {
  const total = impliedAbsMovePct(0.5, 5);
  assert.ok(Math.abs(total - 0.5 * Math.sqrt(5 / 252) * Math.sqrt(2 / Math.PI) * 100) < 1e-12);
  const idio = impliedAbsMovePct(0.5, 5, 1.2, 0.2);
  assert.ok(Math.abs(idio - Math.sqrt(0.25 - 1.44 * 0.04) * Math.sqrt(5 / 252) * Math.sqrt(2 / Math.PI) * 100) < 1e-12);
  assert.equal(impliedAbsMovePct(0.1, 5, 1, 0.3), 0);
});

test("summarizeH7: exceed share among gap > 0 and the priced-in shares", () => {
  const p = (date: string, history: number, implied: number, realized: number): H7Pair => ({ date, event: "E", hit: "H", historyPct: history, historyN: 6, impliedPct: implied, realizedPct: realized });
  const pairs = [p("2024-01-02", 5, 3, 4), p("2024-01-02", 5, 3, 2), p("2024-02-01", 6, 3, 7), p("2024-03-01", 6, 2, 9), p("2024-04-01", 2, 3, 1)];
  const s = summarizeH7(pairs);
  assert.equal(s.pairs, 5);
  assert.equal(s.dates, 4);
  assert.equal(s.gapPositive, 4);
  assert.equal(s.exceedShare, 0.75);
  assert.equal(s.exceedShareGapNeg, 0);
  assert.equal(s.optionsAtLeastHistoryShare, 0.2);
  assert.equal(s.pricedInShare, 2 / 5);
  assert.equal(s.exceedTest!.clusters, 3);
  assert.ok(s.exceedTest!.mean > 0);
});

test("clusteredSlope recovers a slope and needs 3 clusters", () => {
  const x = [1, 2, 3, 4, 5, 6];
  const y = x.map((v, i) => 2 * v + (i % 2 ? 0.1 : -0.1));
  const r = clusteredSlope(x, y, ["a", "a", "b", "b", "c", "c"])!;
  assert.ok(Math.abs(r.beta - 2) < 0.05);
  assert.equal(r.df, 2);
  assert.equal(clusteredSlope(x, y, ["a", "a", "a", "b", "b", "b"]), null);
});

test("snapshot alignment: the first 15:45 after the public instant, entry at the next open", () => {
  const sessions = nyseSessions("2023-01-03", "2024-12-31");
  const snap = (d: string) => nyInstantMs(d, 15 * 60 + 45);
  // After-close release on 2024-05-22 (16:20 ET): snapshot 2024-05-23, entry 2024-05-24 open.
  const i = snapshotIndexAfter(sessions, nyInstantMs("2024-05-22", 16 * 60 + 20), snap)!;
  assert.equal(sessions[i], "2024-05-23");
  // A release at 15:50 is after that day's snapshot: the next session.
  assert.equal(sessions[snapshotIndexAfter(sessions, nyInstantMs("2024-05-22", 15 * 60 + 50), snap)!], "2024-05-23");
  // Before the open: the same day.
  assert.equal(sessions[snapshotIndexAfter(sessions, nyInstantMs("2024-05-22", 7 * 60), snap)!], "2024-05-22");
  // measureEvent with the snapshot as the public time enters at the next open.
  const n = sessions.length;
  const close = Float64Array.from({ length: n }, (_, k) => 100 * (1 + 0.001 * Math.sin(k)));
  const open = Float64Array.from(close);
  const mkt = { open: Float64Array.from({ length: n }, (_, k) => 400 * (1 + 0.002 * Math.cos(k))), close: Float64Array.from({ length: n }, (_, k) => 400 * (1 + 0.002 * Math.cos(k))) };
  const m = measureEvent({ sessions, stock: { open, close }, market: mkt, publicMs: snap(sessions[i]!), windows: [5] });
  assert.ok(m.ok);
  if (m.ok) {
    assert.equal(m.entryDate, "2024-05-24");
    assert.equal(m.drift[5]!.exitDate, sessions[i + 5]);
  }
});

test("clusteredOls recovers two slopes", () => {
  const a: number[] = [];
  const b: number[] = [];
  const y: number[] = [];
  const keys: string[] = [];
  for (let i = 0; i < 60; i++) {
    const x1 = Math.sin(i) * 3;
    const x2 = Math.cos(i * 1.7) * 2;
    a.push(x1);
    b.push(x2);
    y.push(1 + 0.5 * x1 - 2 * x2 + (i % 3 === 0 ? 0.01 : -0.005));
    keys.push(`d${i % 12}`);
  }
  const r = clusteredOls([a, b], y, keys)!;
  assert.ok(Math.abs(r.beta[0]! - 1) < 0.01);
  assert.ok(Math.abs(r.beta[1]! - 0.5) < 0.01);
  assert.ok(Math.abs(r.beta[2]! + 2) < 0.01);
  assert.equal(r.df, 11);
  assert.equal(clusteredOls([[1, 1, 1, 1]], [1, 2, 3, 4], ["a", "b", "c", "d"]), null);
});
