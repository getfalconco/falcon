import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatRetryAfter,
  RESEARCH_WINDOW_MS,
  scoreResearchQuota,
} from "./research-quota.js";

const NOW = Date.parse("2026-08-29T20:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60_000;

describe("scoreResearchQuota", () => {
  it("allows the first research", () => {
    const q = scoreResearchQuota([], NOW);
    assert.equal(q.allowed, true);
    assert.equal(q.used, 0);
    assert.equal(q.remaining, 1);
    assert.equal(q.resetAt, null);
  });

  it("refuses a second one inside the window", () => {
    const q = scoreResearchQuota([ago(HOUR)], NOW);
    assert.equal(q.allowed, false);
    assert.equal(q.used, 1);
    assert.equal(q.remaining, 0);
  });

  it("allows again once the window has passed", () => {
    const q = scoreResearchQuota([ago(RESEARCH_WINDOW_MS + 1000)], NOW);
    assert.equal(q.allowed, true);
    assert.equal(q.used, 0);
  });

  it("counts from the OLDEST start, not the newest", () => {
    // Otherwise every new attempt would push the reset out and the account
    // could be locked indefinitely by its own refused requests.
    const q = scoreResearchQuota([ago(4 * HOUR), ago(1 * HOUR)], NOW);
    const expected = NOW - 4 * HOUR + RESEARCH_WINDOW_MS;
    assert.equal(Date.parse(q.resetAt!), expected);
    // One hour left, not four.
    assert.ok(q.retryAfterSeconds! <= HOUR / 1000 + 1);
  });

  it("counts a failed research too", () => {
    // The extraction was paid for either way; refunding failures would make a
    // retry loop free, which is the one case a spend cap exists for.
    const q = scoreResearchQuota([ago(HOUR)], NOW);
    assert.equal(q.used, 1);
  });

  it("ignores starts outside the window", () => {
    const q = scoreResearchQuota([ago(9 * HOUR), ago(7 * HOUR)], NOW);
    assert.equal(q.used, 0);
    assert.equal(q.allowed, true);
  });

  it("ignores unparseable timestamps rather than counting them", () => {
    const q = scoreResearchQuota(["not a date", ""], NOW);
    assert.equal(q.used, 0);
    assert.equal(q.allowed, true);
  });

  it("reports seconds that never go negative", () => {
    const q = scoreResearchQuota([ago(RESEARCH_WINDOW_MS - 1)], NOW);
    assert.ok((q.retryAfterSeconds ?? 0) >= 0);
  });

  it("honours a custom limit", () => {
    const three = scoreResearchQuota([ago(HOUR), ago(2 * HOUR)], NOW, 3);
    assert.equal(three.allowed, true);
    assert.equal(three.remaining, 1);
  });
});

describe("formatRetryAfter", () => {
  it("reads naturally at each scale", () => {
    assert.equal(formatRetryAfter(30), "under a minute");
    assert.equal(formatRetryAfter(60), "under a minute");
    assert.equal(formatRetryAfter(120), "2 minutes");
    assert.equal(formatRetryAfter(3600), "1 hour");
    assert.equal(formatRetryAfter(3600 * 4 + 1800), "4h 30m");
  });

  it("does not say '1 minutes'", () => {
    assert.equal(formatRetryAfter(61), "2 minutes");
    assert.equal(formatRetryAfter(3600 * 2), "2 hours");
  });
});
