import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitRows, packSpans, packTimed } from "./calendar-layout";

function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  return Object.fromEntries(list.map((x) => [x.id, x]));
}

describe("packTimed", () => {
  it("gives lone events the full width", () => {
    const p = byId(packTimed([{ id: "a", start: 60, end: 120 }, { id: "b", start: 120, end: 180 }]));
    assert.deepEqual(p.a, { id: "a", column: 0, columns: 1 });
    assert.deepEqual(p.b, { id: "b", column: 0, columns: 1 });
  });

  it("puts overlapping events side by side and reuses freed columns", () => {
    const p = byId(
      packTimed([
        { id: "a", start: 0, end: 120 },
        { id: "b", start: 30, end: 60 },
        { id: "c", start: 60, end: 90 },
        { id: "d", start: 100, end: 200 },
      ]),
    );
    assert.equal(p.a.column, 0);
    assert.equal(p.b.column, 1);
    assert.equal(p.c.column, 1); // b has ended by 60
    assert.equal(p.d.column, 1); // c has ended by 100, a is still running
    for (const id of ["a", "b", "c", "d"]) assert.equal(p[id].columns, 2);
  });

  it("chains a cluster through overlaps", () => {
    const p = byId(
      packTimed([
        { id: "a", start: 0, end: 60 },
        { id: "b", start: 50, end: 110 },
        { id: "c", start: 100, end: 160 },
        { id: "z", start: 300, end: 330 },
      ]),
    );
    assert.equal(p.a.columns, 2);
    assert.equal(p.c.columns, 2);
    assert.equal(p.c.column, 0);
    assert.equal(p.z.columns, 1);
  });

  it("counts a short event at its minimum span", () => {
    const p = byId(packTimed([{ id: "a", start: 0, end: 5 }, { id: "b", start: 10, end: 40 }], 30));
    assert.equal(p.a.columns, 2);
    assert.equal(p.b.column, 1);
  });

  it("puts the longer of two same-start events first", () => {
    const p = byId(packTimed([{ id: "short", start: 0, end: 30 }, { id: "long", start: 0, end: 90 }]));
    assert.equal(p.long.column, 0);
    assert.equal(p.short.column, 1);
  });
});

const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];

describe("packSpans", () => {
  it("stacks overlapping bars and clips them to the run", () => {
    const p = byId(
      packSpans(
        [
          { id: "one", start: "2026-10-06", end: "2026-10-06" },
          { id: "three", start: "2026-10-06", end: "2026-10-08" },
          { id: "before", start: "2026-10-01", end: "2026-10-05" },
          { id: "outside", start: "2026-10-20", end: "2026-10-21" },
          { id: "later", start: "2026-10-07", end: "2026-10-07" },
        ],
        WEEK,
      ),
    );
    assert.deepEqual(p.three, { id: "three", row: 0, startIndex: 1, span: 3 });
    assert.equal(p.one.row, 1);
    assert.deepEqual(p.before, { id: "before", row: 0, startIndex: 0, span: 1 });
    assert.equal(p.outside, undefined);
    assert.equal(p.later.row, 1);
  });

  it("packs a run with gaps (a week without its weekend)", () => {
    const days = WEEK.slice(0, 5);
    const p = byId(packSpans([{ id: "weekend", start: "2026-10-10", end: "2026-10-11" }, { id: "fri-mon", start: "2026-10-09", end: "2026-10-12" }], days));
    assert.equal(p.weekend, undefined);
    assert.deepEqual(p["fri-mon"], { id: "fri-mon", row: 0, startIndex: 4, span: 1 });
  });
});

describe("fitRows", () => {
  it("keeps every bar when there is room", () => {
    const placements = packSpans([{ id: "a", start: WEEK[0], end: WEEK[0] }], WEEK);
    const fit = fitRows(placements, 7, 3);
    assert.deepEqual([...fit.drawn], ["a"]);
    assert.deepEqual(fit.hidden, [0, 0, 0, 0, 0, 0, 0]);
  });

  it("gives the last row to the count on a crowded day", () => {
    const items = ["a", "b", "c", "d"].map((id) => ({ id, start: WEEK[2], end: WEEK[2] }));
    const fit = fitRows(packSpans(items, WEEK), 7, 3);
    assert.equal(fit.drawn.size, 2);
    assert.equal(fit.hidden[2], 2);
  });

  it("hides a long bar on every day it cannot fit on one of", () => {
    const items = [
      { id: "a", start: WEEK[0], end: WEEK[2] },
      { id: "b", start: WEEK[0], end: WEEK[2] },
      { id: "long", start: WEEK[1], end: WEEK[4] },
      { id: "c", start: WEEK[1], end: WEEK[1] },
    ];
    const fit = fitRows(packSpans(items, WEEK), 7, 3);
    assert.deepEqual([...fit.drawn].sort(), ["a", "b"]);
    assert.equal(fit.hidden[1], 2);
    assert.equal(fit.hidden[4], 1);
    assert.equal(fit.hidden[0], 0);
  });
});
