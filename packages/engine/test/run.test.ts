import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffMs, retryableStatus } from "../src/http.ts";
import { EXIT, runExitCode, summaryLines, unreadableTickers } from "../src/summary.ts";
import { staleCutoff } from "../src/supabase.ts";
import type { RunResult } from "../src/pipeline.ts";

describe("retries", () => {
  it("retries timeouts, rate limits and server errors only", () => {
    for (const s of [408, 425, 429, 500, 502, 503]) assert.equal(retryableStatus(s), true, String(s));
    for (const s of [400, 401, 403, 404]) assert.equal(retryableStatus(s), false, String(s));
  });

  it("backs off exponentially with jitter, capped", () => {
    const none = () => 0;
    assert.equal(backoffMs(0, null, 1000, 20_000, none), 1000);
    assert.equal(backoffMs(1, null, 1000, 20_000, none), 2000);
    assert.equal(backoffMs(2, null, 1000, 20_000, none), 4000);
    assert.equal(backoffMs(10, null, 1000, 20_000, none), 20_000);
    assert.equal(backoffMs(0, null, 1000, 20_000, () => 1), 1250);
  });

  it("honours a longer Retry-After, within the cap", () => {
    assert.equal(backoffMs(0, "5", 1000, 20_000, () => 0), 5000);
    assert.equal(backoffMs(0, "120", 1000, 20_000, () => 0), 20_000);
    assert.equal(backoffMs(2, "1", 1000, 20_000, () => 0), 4000);
  });
});

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    feed: { generatedAt: "2026-11-12T11:00:00.000Z", cards: [], meta: { engine: "ripple-v0", judge: "x", sector: "semis", since: "a", until: "b" } },
    events: [],
    requests: [],
    rejected: [],
    tickers: ["NVDA", "AMD", "TSM"],
    sourceProblems: [],
    yahooProblems: [],
    judgeFailures: [],
    history: { hits: 0, measured: 0, problems: [] },
    ranking: { cards: [], capped: [], dropped: [], droppedCards: [], coverage: {} },
    ...over,
  };
}

describe("exit codes", () => {
  it("is OK with partial source failures", () => {
    const r = run({ sourceProblems: [{ ticker: "AMD", scope: "ticker", message: "submissions unreadable" }] });
    assert.deepEqual(unreadableTickers(r), ["AMD"]);
    assert.equal(runExitCode(r, 2, { state: "dry-run" }), EXIT.OK);
  });

  it("fails when no company could be read", () => {
    const r = run({ sourceProblems: ["NVDA", "AMD", "TSM"].map((ticker) => ({ ticker, scope: "ticker" as const, message: "down" })) });
    assert.equal(runExitCode(r, 0, { state: "dry-run" }), EXIT.NO_SOURCES);
  });

  it("fails when every judge call failed, not when some did", () => {
    const one = [{ eventId: "e1", message: "401" }];
    assert.equal(runExitCode(run({ judgeFailures: one }), 1, { state: "dry-run" }), EXIT.JUDGE_FAILED);
    assert.equal(runExitCode(run({ judgeFailures: one }), 3, { state: "dry-run" }), EXIT.OK);
    assert.equal(runExitCode(run(), 0, { state: "dry-run" }), EXIT.OK);
  });

  it("fails when the Supabase write failed", () => {
    assert.equal(runExitCode(run(), 2, { state: "failed", error: "x" }), EXIT.PUBLISH_FAILED);
  });

  it("summarises events and cards written", () => {
    const lines = summaryLines({ run: run(), judged: 0, judgeName: "file", publish: { state: "written", result: { upserted: 3, markedStale: 1, fresh: 6 } }, exitCode: EXIT.OK });
    assert.ok(lines.some((l) => l === "events found: 0"));
    assert.ok(lines.some((l) => l.startsWith("supabase: 3 cards written, 1 marked stale")));
  });
});

describe("staleness", () => {
  it("cuts off keepDays before now", () => {
    assert.equal(staleCutoff(Date.parse("2026-11-12T11:00:00Z"), 7).toISOString(), "2026-11-05T11:00:00.000Z");
  });
});
