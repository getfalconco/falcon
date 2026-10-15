import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coMovement,
  dailyReturns,
  notableMoves,
  pearson,
  peerSide,
  shockVsShift,
  stdev,
  verdictOf,
  yearSigma,
  type Bar,
} from "./peer-dynamics";

/** Sessions from 2025-01-01, one per calendar day (the maths does not care about weekends). */
function day(i: number): string {
  return new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

/** Bars from a list of returns, starting at 100. */
function barsFrom(returns: readonly number[], offset = 0): Bar[] {
  const out: Bar[] = [{ d: day(offset), c: 100 }];
  let c = 100;
  returns.forEach((r, i) => {
    c *= 1 + r;
    out.push({ d: day(offset + i + 1), c });
  });
  return out;
}

/** A deterministic wiggle: small moves of both signs. */
function wiggle(n: number, seed: number, scale = 0.01): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    out.push(((x / 233280) * 2 - 1) * scale);
  }
  return out;
}

describe("dailyReturns", () => {
  it("sorts, drops bad closes and duplicate dates, and returns close-to-close moves", () => {
    const r = dailyReturns([
      { d: "2025-01-03", c: 110 },
      { d: "2025-01-01", c: 100 },
      { d: "2025-01-02", c: 0 },
      { d: "2025-01-03", c: 110 },
    ]);
    assert.deepEqual(r.map((x) => x.d), ["2025-01-03"]);
    assert.ok(Math.abs(r[0]!.r - 0.1) < 1e-12);
  });
});

describe("pearson and stdev", () => {
  it("gives 1 and -1 for perfectly matched and mirrored series", () => {
    assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1);
    assert.equal(pearson([1, 2, 3], [3, 2, 1]), -1);
  });
  it("is null for a flat series or mismatched lengths", () => {
    assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
    assert.equal(pearson([1, 2], [1, 2, 3]), null);
  });
  it("uses the sample deviation", () => {
    assert.ok(Math.abs(stdev([1, 2, 3, 4])! - 1.2909944) < 1e-6);
    assert.equal(stdev([1]), null);
  });
});

describe("coMovement", () => {
  const base = wiggle(300, 7);
  it("is near 1 for a peer that moves with the stock and near -1 for one against it", () => {
    const stock = barsFrom(base);
    const twin = barsFrom(base.map((r) => r * 1.5));
    const mirror = barsFrom(base.map((r) => -r));
    assert.ok(coMovement(stock, twin, 252, 120)! > 0.99);
    assert.ok(coMovement(stock, mirror, 63, 40)! < -0.99);
  });
  it("only counts the sessions both traded, and is null below the overlap floor", () => {
    const stock = barsFrom(base);
    const late = barsFrom(base.slice(0, 30), 270);
    assert.equal(coMovement(stock, late, 252, 120), null);
  });
});

describe("notableMoves", () => {
  it("finds the latest sessions two standard deviations out, newest first", () => {
    const returns = wiggle(300, 3, 0.005);
    returns[250] = 0.08;
    returns[290] = -0.07;
    const bars = barsFrom(returns);
    const moves = notableMoves(bars);
    assert.deepEqual(moves.map((m) => m.d), [day(291), day(251)]);
    assert.ok(moves[0]!.z < -2 && moves[1]!.z > 2);
  });
  it("needs sixty sessions to know what large is", () => {
    assert.equal(yearSigma(barsFrom(wiggle(40, 1))), null);
    assert.deepEqual(notableMoves(barsFrom(wiggle(40, 1))), []);
  });
});

describe("peerSide and verdictOf", () => {
  it("reads a peer's move in its own deviations", () => {
    assert.equal(peerSide(0.05, 0.02, 0.01), "same");
    assert.equal(peerSide(0.05, -0.02, 0.01), "opposite");
    assert.equal(peerSide(0.05, 0.005, 0.01), "flat");
    assert.equal(peerSide(-0.05, 0, 0.01), "flat");
  });
  it("calls half or more the same way a sector move", () => {
    assert.equal(verdictOf(2, 4), "sector");
    assert.equal(verdictOf(1, 3), "shift");
    assert.equal(verdictOf(0, 0), "shift");
  });
});

describe("shockVsShift", () => {
  const n = 300;
  const stockReturns = wiggle(n, 11, 0.005);
  const peerA = wiggle(n, 23, 0.005);
  const peerB = wiggle(n, 37, 0.005);
  // Session 280: the whole group falls (a sector move).
  stockReturns[280] = -0.06;
  peerA[280] = -0.04;
  peerB[280] = -0.03;
  // Session 295: the stock jumps and the peers slip (a share shift).
  stockReturns[295] = 0.07;
  peerA[295] = -0.02;
  peerB[295] = 0.001;

  it("labels a move the group shared as sector, and one it did not as a shift", () => {
    const rows = shockVsShift(barsFrom(stockReturns), [
      { ticker: "AAA", bars: barsFrom(peerA) },
      { ticker: "BBB", bars: barsFrom(peerB) },
    ]);
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const shift = byDate.get(day(296))!;
    const sector = byDate.get(day(281))!;
    assert.equal(sector.verdict, "sector");
    assert.equal(sector.same, 2);
    assert.equal(shift.verdict, "shift");
    assert.equal(shift.opposite, 1);
    assert.equal(shift.flat, 1);
    assert.ok(Math.abs(shift.peerMoves.AAA! + 0.02) < 1e-6);
    assert.equal(rows[0]!.date, day(296), "newest first");
  });

  it("leaves out a session no peer traded", () => {
    const rows = shockVsShift(barsFrom(stockReturns), [{ ticker: "AAA", bars: barsFrom(peerA.slice(0, 200)) }]);
    assert.deepEqual(rows, []);
  });

  it("marks a peer with no bar that day as null", () => {
    const bBars = barsFrom(peerB).filter((b) => b.d !== day(296));
    const rows = shockVsShift(barsFrom(stockReturns), [
      { ticker: "AAA", bars: barsFrom(peerA) },
      { ticker: "BBB", bars: bBars },
    ]);
    const shift = rows.find((r) => r.date === day(296))!;
    assert.equal(shift.peerMoves.BBB, null);
    assert.equal(shift.opposite + shift.same + shift.flat, 1);
  });
});
