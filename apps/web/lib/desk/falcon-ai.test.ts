// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/falcon-ai.test.ts
// Falcon AI robustness: error mapping and retry (errors.ts), the daily budget (limits.ts) and title cleanup (title.ts). No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { classify, firstEventWithRetry, isRetryable, retryDelayMs, startFailure, streamFailure } from "./errors";
import { FOUNDER_USERS, MemoryUsage, budgetFromEnv, checkBudget, limitsOff, nyDay, overBudget, recordUsage, unlimitedUser } from "./limits";
import { cleanTitle, titlePrompt } from "./title";

const apiError = (status: number, headers: Record<string, string> = {}) => Anthropic.APIError.generate(status, { error: { type: "x", message: "upstream detail claude-opus" } }, "upstream detail", new Headers(headers));

test("retryable: 429, 5xx, 529 and dropped connections; not 400, timeouts or aborts", () => {
  assert.equal(isRetryable(apiError(429)), true);
  assert.equal(isRetryable(apiError(500)), true);
  assert.equal(isRetryable(apiError(529)), true);
  assert.equal(isRetryable(new Anthropic.APIConnectionError({ message: "reset" })), true);
  assert.equal(isRetryable(apiError(400)), false);
  assert.equal(isRetryable(apiError(401)), false);
  assert.equal(isRetryable(new Anthropic.APIConnectionTimeoutError()), false);
  assert.equal(isRetryable(new Anthropic.APIUserAbortError()), false);
  assert.equal(isRetryable(new Error("x")), false);
});

test("backoff grows, has jitter, honours retry-after and is capped", () => {
  assert.equal(retryDelayMs(0, undefined, () => 0.5), 700);
  assert.equal(retryDelayMs(1, undefined, () => 0.5), 1400);
  assert.equal(retryDelayMs(10, undefined, () => 0.5), 4000);
  assert.ok(retryDelayMs(0, undefined, () => 0) < retryDelayMs(0, undefined, () => 1));
  assert.equal(retryDelayMs(0, apiError(429, { "retry-after": "2" })), 2000);
  assert.equal(retryDelayMs(0, apiError(429, { "retry-after": "60" })), 4000);
});

test("errors map to Falcon AI messages with no model or provider names", () => {
  assert.equal(classify(apiError(400)), "unreadable");
  assert.equal(classify(apiError(429)), "busy");
  assert.equal(classify(apiError(529)), "overloaded");
  assert.equal(classify(apiError(503)), "overloaded");
  assert.equal(classify(new Error("x"), true), "timeout");
  assert.equal(classify(new Error("x")), "unavailable");
  assert.equal(startFailure("busy").status, 429);
  assert.equal(startFailure("unreadable").status, 400);
  const all = [...(["busy", "overloaded", "timeout", "unreadable", "unavailable"] as const).flatMap((k) => [startFailure(k).error, streamFailure(k, true), streamFailure(k, false)])];
  for (const m of all) {
    assert.match(m, /Falcon AI|cut off/);
    assert.doesNotMatch(m, /claude|anthropic|opus|sonnet|haiku|desk/i);
  }
});

async function* events(n: number) {
  for (let i = 0; i < n; i++) yield i;
}

test("a failed start is retried, then succeeds", async () => {
  let calls = 0;
  const retried: number[] = [];
  const r = await firstEventWithRetry(
    () => {
      calls++;
      if (calls < 3) return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(apiError(529)) }) } as AsyncIterable<number>;
      return events(2);
    },
    { signal: new AbortController().signal, timeLeftMs: () => 60_000, minLeftMs: 0, onRetry: (a) => retried.push(a) },
  );
  assert.equal(calls, 3);
  assert.equal(r.retries, 2);
  assert.deepEqual(retried, [1, 2]);
  assert.deepEqual(r.first, { value: 0, done: false });
});

test("a bad request, too little time or an abort is not retried", async () => {
  let calls = 0;
  const failing = (e: unknown) => () => {
    calls++;
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(e) }) } as AsyncIterable<number>;
  };
  await assert.rejects(firstEventWithRetry(failing(apiError(400)), { signal: new AbortController().signal, timeLeftMs: () => 60_000 }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(firstEventWithRetry(failing(apiError(529)), { signal: new AbortController().signal, timeLeftMs: () => 5_000 }));
  assert.equal(calls, 1);
  calls = 0;
  const c = new AbortController();
  c.abort();
  await assert.rejects(firstEventWithRetry(failing(apiError(529)), { signal: c.signal, timeLeftMs: () => 60_000, minLeftMs: 0 }));
  assert.equal(calls, 1);
});

test("budget defaults, env overrides and caps", () => {
  assert.deepEqual(budgetFromEnv({}), { dailyUsd: 5, dailyRequests: 300 });
  assert.deepEqual(budgetFromEnv({ DESK_DAILY_USD: "2.5", DESK_DAILY_REQUESTS: "0" }), { dailyUsd: 2.5, dailyRequests: 0 });
  assert.deepEqual(budgetFromEnv({ DESK_DAILY_USD: "abc" }), { dailyUsd: 5, dailyRequests: 300 });
  const b = { dailyUsd: 5, dailyRequests: 300 };
  assert.equal(overBudget({ usd: 4.99, requests: 10 }, b), null);
  assert.equal(overBudget({ usd: 5, requests: 10 }, b), "usd");
  assert.equal(overBudget({ usd: 0, requests: 300 }, b), "requests");
  assert.equal(overBudget({ usd: 999, requests: 999 }, { dailyUsd: 0, dailyRequests: 0 }), null);
  assert.equal(unlimitedUser("u1", { DESK_UNLIMITED_USERS: "u0, u1" }), true);
  assert.equal(unlimitedUser("u2", { DESK_UNLIMITED_USERS: "u0, u1" }), false);
  assert.equal(unlimitedUser(null, { DESK_UNLIMITED_USERS: "" }), false);
});

test("the founder's account is never capped; local dev has no limits, production keeps them", () => {
  for (const id of FOUNDER_USERS) assert.equal(unlimitedUser(id, {}), true);
  assert.equal(unlimitedUser("56b7a75c-ac79-4e42-8286-26596d02622d", {}), true);
  assert.equal(limitsOff({ NODE_ENV: "development" }), true);
  assert.equal(limitsOff({ NODE_ENV: "production" }), false);
  assert.equal(limitsOff({ NODE_ENV: "test" }), false);
  assert.equal(limitsOff({}), false);
});

test("New York day and in-memory usage (only today's rows kept)", () => {
  assert.equal(nyDay(Date.UTC(2026, 10, 16, 3, 0)), "2026-11-15");
  assert.equal(nyDay(Date.UTC(2026, 10, 16, 6, 0)), "2026-11-16");
  const m = new MemoryUsage();
  m.add("a", "2026-11-15", 1, 1);
  m.add("a", "2026-11-16", 0.5, 1);
  m.add("a", "2026-11-16", 0.25, 1);
  assert.deepEqual(m.get("a", "2026-11-16"), { usd: 0.75, requests: 2 });
  assert.deepEqual(m.get("a", "2026-11-15"), { usd: 0, requests: 0 });
});

test("checkBudget blocks after the cap, never blocks the admin, falls back to memory without Supabase", async () => {
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const key = "11111111-2222-3333-4444-555555555555";
    const b = { dailyUsd: 1, dailyRequests: 0 };
    assert.deepEqual(await checkBudget(key, false, b), { ok: true });
    await recordUsage(key, 0.6);
    assert.deepEqual(await checkBudget(key, false, b), { ok: true });
    await recordUsage(key, 0.6);
    const r = await checkBudget(key, false, b);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Falcon AI limit/);
    assert.deepEqual(await checkBudget(key, true, b), { ok: true });
  } finally {
    if (saved.url) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
});

test("titles: first line, no label, quotes, Markdown or end punctuation, at most 5 words", () => {
  assert.equal(cleanTitle('"NVDA margin trend."'), "NVDA margin trend");
  assert.equal(cleanTitle("Title: **AAPL dividend history**\nmore"), "AAPL dividend history");
  assert.equal(cleanTitle("Başlık: Tesla'nın nakit akışı analizi"), "Tesla'nın nakit akışı analizi");
  assert.equal(cleanTitle("one two three four five six seven"), "one two three four five");
  assert.equal(cleanTitle("   \n\n  "), "");
  assert.equal(cleanTitle("«Microsoft bulut büyümesi»!"), "Microsoft bulut büyümesi");
  assert.ok(cleanTitle("a".repeat(100)).length <= 48);
  assert.match(titlePrompt("q".repeat(5000), "a"), /^Question:\nq{1200}\n/);
});

test("title language follows the question", () => {
  assert.match(titlePrompt("What is MSFT trading at?", "MSFT closed at $523.88"), /Write the title in English\./);
  assert.match(titlePrompt("sen hangi modelsin?", "Ben Falcon AI'yım"), /Write the title in Turkish\./);
  assert.match(titlePrompt("AAPL temettü geçmişi", ""), /Turkish/);
  assert.match(titlePrompt("Quelle est la marge de NVDA ?", ""), /English|same language/);
});
