import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTEMPT_TTL_DAYS,
  MAX_REASON_CHARS,
  MemoryBackend,
  VerdictStore,
  type AttemptRecord,
} from "./store.js";
import type { Verdict } from "./types.js";

/**
 * Failure text is capped per row and healed at load. A provider's error body
 * stored whole, one per article, is what grew the classifier's dir to 194 MB
 * on the engine service and killed the container on every rewrite.
 */

const huge = "x".repeat(50_000);

function failed(articleKey: string, reason: string): Verdict {
  return {
    article_key: articleKey,
    prompt_version: "v1",
    model: "m",
    classified_at: "2026-09-01T00:00:00.000Z",
    status: "failed",
    failure_reason: reason,
  } as unknown as Verdict;
}

test("recordAttempt and put keep a bounded reason", () => {
  const store = new VerdictStore(new MemoryBackend());
  const rec = store.recordAttempt("a1", huge, "2026-09-07T00:00:00.000Z", 3);
  assert.equal(rec.last_error?.length, MAX_REASON_CHARS + 1);
  assert.ok(rec.last_error?.endsWith("…"));
  store.put(failed("a1", huge));
  assert.equal(store.latestFor("a1")?.failure_reason?.length, MAX_REASON_CHARS + 1);
  // A short reason is stored as it is.
  assert.equal(store.recordAttempt("a2", "timeout", "2026-09-07T00:00:00.000Z", 3).last_error, "timeout");
});

test("a store loaded with whole error bodies is clipped and written back once", () => {
  const backend = new MemoryBackend();
  const attempts: Record<string, AttemptRecord> = {
    a1: { article_key: "a1", attempts: 1, last_error: huge, last_attempt_at: "2026-09-06T00:00:00.000Z", permanent_failed: false },
    old: {
      article_key: "old",
      attempts: 2,
      last_error: "gone",
      last_attempt_at: new Date(Date.now() - (ATTEMPT_TTL_DAYS + 1) * 86_400_000).toISOString(),
      permanent_failed: true,
    },
  };
  backend.writeAttempts(attempts);
  backend.writeVerdicts({ "a1|v1|m": failed("a1", huge) });

  const store = new VerdictStore(backend);
  assert.equal(store.attemptsFor("a1")?.last_error?.length, MAX_REASON_CHARS + 1);
  assert.equal(store.attemptsFor("old"), null);
  assert.equal(store.latestFor("a1")?.failure_reason?.length, MAX_REASON_CHARS + 1);
  // Healed on disk too, not only in memory.
  assert.equal(backend.readAttempts().a1.last_error?.length, MAX_REASON_CHARS + 1);
  assert.equal(Object.keys(backend.readAttempts()).length, 1);
  assert.equal(Object.values(backend.readVerdicts())[0].failure_reason?.length, MAX_REASON_CHARS + 1);
});

test("failure grouping still reads the clipped text", () => {
  const store = new VerdictStore(new MemoryBackend());
  store.recordAttempt("a1", `HTTP 502 ${huge}`, "2026-09-07T00:00:00.000Z", 3);
  store.recordAttempt("a2", `HTTP 502 ${huge}`, "2026-09-07T00:00:00.000Z", 3);
  const reasons = store.failureReasons();
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].count, 2);
  assert.ok(reasons[0].reason.startsWith("HTTP 502"));
});
