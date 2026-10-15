import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nyWallMs, nyYmdOf, reactionSession, releaseThresholdMs, timeOfRelease, weekStartOf } from "./earnings-time";

const iso = (ms: number) => new Date(ms).toISOString();

describe("New York wall time", () => {
  it("follows daylight saving", () => {
    assert.equal(iso(nyWallMs("2026-10-30", 9, 30)), "2026-10-30T13:30:00.000Z");
    // Clocks went back on November 1st.
    assert.equal(iso(nyWallMs("2026-11-02", 9, 30)), "2026-11-02T14:30:00.000Z");
    assert.equal(nyYmdOf(Date.parse("2026-10-16T03:00:00Z")), "2026-10-15");
  });
});

describe("when a report counts as out", () => {
  it("before the open: from the open; after the close or unknown: from the close", () => {
    assert.equal(iso(releaseThresholdMs("2026-10-15", "bmo")), "2026-10-15T13:30:00.000Z");
    assert.equal(iso(releaseThresholdMs("2026-10-15", "amc")), "2026-10-15T20:00:00.000Z");
    assert.equal(iso(releaseThresholdMs("2026-10-15", "unknown")), "2026-10-15T20:00:00.000Z");
    assert.equal(iso(releaseThresholdMs("2026-10-15", "dmh")), "2026-10-15T20:00:00.000Z");
  });

  it("an early close moves the close: the day after Thanksgiving closes at 13:00", () => {
    assert.equal(iso(releaseThresholdMs("2026-11-27", "amc")), "2026-11-27T18:00:00.000Z");
  });

  it("a day the market does not open keeps the wall times", () => {
    // Thanksgiving 2026.
    assert.equal(iso(releaseThresholdMs("2026-11-26", "bmo")), "2026-11-26T14:30:00.000Z");
    assert.equal(iso(releaseThresholdMs("2026-11-26", "amc")), "2026-11-26T21:00:00.000Z");
  });
});

describe("the session that first trades a report", () => {
  it("after the close is the next session, anything else the same one", () => {
    assert.equal(reactionSession("2026-10-15", "amc"), "2026-10-16");
    assert.equal(reactionSession("2026-10-15", "bmo"), "2026-10-15");
    assert.equal(reactionSession("2026-10-15", "unknown"), "2026-10-15");
    // Friday after the close is Monday.
    assert.equal(reactionSession("2026-10-16", "amc"), "2026-10-19");
  });

  it("a report on a holiday is first traded the next session", () => {
    assert.equal(reactionSession("2026-11-26", "bmo"), "2026-11-27");
    assert.equal(reactionSession("2026-12-25", "amc"), "2026-12-28");
  });

  it("the release instant decides when it is on record", () => {
    // TSM at 02:08 New York.
    assert.equal(reactionSession("2026-10-15", "amc", Date.parse("2026-10-15T06:08:27Z")), "2026-10-15");
    // 12:30 on the early-close day is inside the session; 13:30 is after it.
    assert.equal(reactionSession("2026-11-27", "unknown", Date.parse("2026-11-27T17:30:00Z")), "2026-11-27");
    assert.equal(reactionSession("2026-11-27", "unknown", Date.parse("2026-11-27T18:30:00Z")), "2026-11-30");
    // Released on a Saturday.
    assert.equal(reactionSession("2026-10-17", "unknown", Date.parse("2026-10-17T14:00:00Z")), "2026-10-19");
  });

  it("reads the hour bucket of a release instant", () => {
    assert.equal(timeOfRelease(Date.parse("2026-10-15T06:08:27Z")), "bmo");
    assert.equal(timeOfRelease(Date.parse("2026-11-19T21:20:00Z")), "amc");
    assert.equal(timeOfRelease(Date.parse("2026-10-15T15:00:00Z")), "dmh");
  });
});

describe("the week", () => {
  it("starts on Monday; a weekend belongs to the week just ending", () => {
    assert.equal(weekStartOf("2026-10-15"), "2026-10-12");
    assert.equal(weekStartOf("2026-10-12"), "2026-10-12");
    assert.equal(weekStartOf("2026-10-18"), "2026-10-12");
    assert.equal(weekStartOf("2026-11-01"), "2026-10-26");
  });
});
