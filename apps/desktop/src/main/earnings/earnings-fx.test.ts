import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFx, fxBarDay, fxCloses, rateOn, toUsd } from "./earnings-fx";

// Yahoo's TWDUSD=X daily bars, stamped at London midnight (23:00 UTC in summer).
const POINTS = [
  { t: Date.parse("2026-10-08T23:00:00Z"), v: 0.03132302 },
  { t: Date.parse("2026-10-11T23:00:00Z"), v: 0.03133215 },
  { t: Date.parse("2026-10-12T23:00:00Z"), v: 0.03132067 },
  { t: Date.parse("2026-10-13T23:00:00Z"), v: 0.0311478 },
  { t: Date.parse("2026-10-14T23:00:00Z"), v: 0 },
  { t: Date.parse("2026-10-15T00:00:00Z"), v: 0.03087373 },
];

describe("dated rates", () => {
  it("dates a bar by the day it is for, not the UTC day of its stamp", () => {
    assert.equal(fxBarDay(Date.parse("2026-10-11T23:00:00Z")), "2026-10-12");
    assert.equal(fxBarDay(Date.parse("2026-10-15T00:00:00Z")), "2026-10-15");
    assert.equal(fxBarDay(Date.parse("2026-01-14T00:00:00Z")), "2026-01-14");
  });

  it("keeps one close per day and drops empty prints", () => {
    const closes = fxCloses(POINTS);
    assert.deepEqual(
      closes.map((c) => c.d),
      ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"],
    );
    assert.equal(closes.find((c) => c.d === "2026-10-15")!.rate, 0.03087373);
  });

  it("takes the last close on or before the day, never a later one", () => {
    const closes = fxCloses(POINTS);
    assert.deepEqual(rateOn(closes, "2026-10-15"), { d: "2026-10-15", rate: 0.03087373 });
    // A weekend day takes Friday's close.
    assert.deepEqual(rateOn(closes, "2026-10-11"), { d: "2026-10-09", rate: 0.03132302 });
    assert.equal(rateOn(closes, "2026-10-01"), null);
  });

  it("converts at the rate and rounds to the dollar", () => {
    assert.equal(toUsd(1_494_243_000_000, { currency: "TWD", rate: 0.03087373, asOf: "2026-10-15" }), 46_132_854_936);
    assert.equal(toUsd(null, { currency: "TWD", rate: 0.03, asOf: "2026-10-15" }), null);
    assert.equal(toUsd(1, null), null);
  });
});

describe("the rate service", () => {
  const NOW = Date.parse("2026-10-15T18:00:00Z");

  it("reads a currency once per day and answers with the dated close", async () => {
    const asked: string[] = [];
    const fx = createFx({ fetchDaily: async (symbol) => (asked.push(symbol), POINTS), now: () => NOW });
    assert.deepEqual(await fx.rate("TWD", "2026-10-15"), { currency: "TWD", rate: 0.03087373, asOf: "2026-10-15" });
    assert.deepEqual(await fx.rate("TWD", "2026-10-13"), { currency: "TWD", rate: 0.03132067, asOf: "2026-10-13" });
    assert.deepEqual(asked, ["TWDUSD=X"]);
  });

  it("asks nothing for dollars or a code that is not one", async () => {
    const asked: string[] = [];
    const fx = createFx({ fetchDaily: async (symbol) => (asked.push(symbol), POINTS), now: () => NOW });
    assert.equal(await fx.rate("USD", "2026-10-15"), null);
    assert.equal(await fx.rate(null, "2026-10-15"), null);
    assert.equal(await fx.rate("twd", "2026-10-15"), null);
    assert.deepEqual(asked, []);
  });

  it("answers null when the pair cannot be read, and does not ask again at once", async () => {
    let calls = 0;
    const fx = createFx({
      fetchDaily: async () => {
        calls++;
        throw new Error("down");
      },
      now: () => NOW,
    });
    assert.equal(await fx.rate("EUR", "2026-10-15"), null);
    assert.equal(await fx.rate("EUR", "2026-10-15"), null);
    assert.equal(calls, 1);
  });
});
