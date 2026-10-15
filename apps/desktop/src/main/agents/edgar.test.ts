import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pruneKept, SUBMISSIONS_KEEP_MAX, SUBMISSIONS_KEEP_MS } from "./edgar";

describe("pruneKept (the kept EDGAR submissions indexes)", () => {
  const NOW = Date.parse("2026-10-16T12:00:00Z");

  it("drops indexes older than a day and keeps the rest", () => {
    const map = new Map([
      ["old", { at: NOW - SUBMISSIONS_KEEP_MS - 1 }],
      ["edge", { at: NOW - SUBMISSIONS_KEEP_MS }],
      ["fresh", { at: NOW - 60_000 }],
    ]);
    pruneKept(map, NOW);
    assert.deepEqual([...map.keys()], ["edge", "fresh"]);
  });

  it("keeps at most the cap, the oldest going first", () => {
    const map = new Map<string, { at: number }>();
    for (let i = 0; i < SUBMISSIONS_KEEP_MAX + 5; i++) map.set(`c${i}`, { at: NOW - (SUBMISSIONS_KEEP_MAX + 5 - i) * 1000 });
    pruneKept(map, NOW);
    assert.equal(map.size, SUBMISSIONS_KEEP_MAX);
    assert.equal(map.keys().next().value, "c5");
    assert.ok(map.has(`c${SUBMISSIONS_KEEP_MAX + 4}`));
  });
});
