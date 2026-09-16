/**
 * §15.3 — service layer: cache, validation retry, transport retry, breaker,
 * addendum merge (first-writer-wins + disagreement), attempt ledger, metrics.
 * All against fixture callers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeClassifierConfig } from "./config.js";
import {
  ClassifierService,
  estimateSpendUsd,
  mergeAddendum,
  percentile,
  uncoveredTickers,
} from "./service.js";
import { MemoryBackend, VerdictStore, isExpired } from "./store.js";
import {
  AT,
  AVGO,
  BROADCOM_HEADLINE,
  META,
  NVDA,
  RECORDED,
  fixtureCaller,
  newsRequest,
  sequenceCaller,
} from "./test-fixtures.js";
import { ClassifierBreakerOpenError, type ModelCaller } from "./types.js";

const CONFIG = mergeClassifierConfig({ retryBackoffMs: 0 });

function makeService(callModel: ModelCaller, overrides: Partial<typeof CONFIG> = {}, clock?: { now: string }) {
  const store = new VerdictStore(new MemoryBackend());
  const service = new ClassifierService({
    config: { ...CONFIG, ...overrides },
    store,
    callModel,
    now: () => clock?.now ?? AT,
    sleep: async () => {},
  });
  return { service, store };
}

describe("classify — lead, cache, addendum", () => {
  it("multi-ticker lead: one call, per-ticker directions, cached on repeat", async () => {
    const log: Array<{ user: string }> = [];
    const { service, store } = makeService(
      fixtureCaller([{ match: "Broadcom", output: RECORDED.broadcom }], log as never),
    );
    const req = newsRequest("brc", BROADCOM_HEADLINE, [AVGO, NVDA]);
    const first = await service.classify(req);
    assert.equal(first.source, "model");
    assert.equal(first.verdict.event_type, "contract_partnership");
    assert.equal(first.verdict.tickers.length, 2);
    assert.equal(log.length, 1);

    const again = await service.classify(req);
    assert.equal(again.source, "cache");
    assert.equal(log.length, 1, "cache hit must not call the model");
    assert.equal(store.getMetrics().cache_hits, 1);
    assert.equal(store.getMetrics().verdicts_ok, 1);
  });

  it("follower on an uncovered ticker → addendum call restricted to the new ticker; first-writer-wins + disagreement", async () => {
    const log: Array<{ user: string }> = [];
    const { service, store } = makeService(
      fixtureCaller(
        [
          { match: "This is an addendum", output: RECORDED.broadcom_addendum_meta },
          { match: "Broadcom", output: RECORDED.broadcom },
        ],
        log as never,
      ),
    );
    const lead = newsRequest("brc", BROADCOM_HEADLINE, [AVGO, NVDA]);
    await service.classify(lead);

    const follower = newsRequest("brc", BROADCOM_HEADLINE, [META, NVDA]); // NVDA already covered
    const out = await service.classify(follower);
    assert.equal(out.source, "merged");
    assert.equal(log.length, 2);
    // Only META went to the model.
    assert.ok(log[1].user.includes("META ·"));
    assert.ok(!log[1].user.includes("NVDA ·"));
    // First-writer-wins on article-level fields; META merged in.
    assert.equal(out.verdict.event_type, "contract_partnership");
    assert.equal(out.verdict.event_label, "Broadcom commits $100B financing to challenge Nvidia");
    assert.deepEqual(
      out.verdict.tickers.map((t) => t.ticker),
      ["AVGO", "NVDA", "META"],
    );
    const m = store.getMetrics();
    assert.equal(m.addenda, 1);
    assert.equal(m.verdict_disagreements, 1, "macro_sector vs contract_partnership");

    // The merged verdict is what the store now returns for all three.
    const all = newsRequest("brc", BROADCOM_HEADLINE, [AVGO, NVDA, META]);
    const cached = await service.classify(all);
    assert.equal(cached.source, "cache");
    assert.equal(log.length, 2);
  });

  it("mergeAddendum is pure and keeps the lead's classified_at", () => {
    const lead = {
      schema_version: 1,
      prompt_version: "cls-1.0",
      model: "m",
      article_key: "id:x",
      kind: "news" as const,
      event_type: "legal" as const,
      event_label: "lead label",
      syndication_scope: 3,
      tickers: [{ ticker: "META", relevance: "direct" as const, materiality: "high" as const, direction: "negative" as const }],
      unassessed_tickers: ["NVDA", "TSM"],
      status: "ok" as const,
      metadata_missing: false,
      classified_at: "2026-08-20T10:00:00.000Z",
      failure_reason: null,
    };
    const r = mergeAddendum(
      lead,
      {
        event_type: "legal",
        event_label: "other label",
        tickers: [
          { ticker: "NVDA", relevance: "none" },
          { ticker: "META", relevance: "none" }, // already covered → ignored
        ],
      },
      "2026-08-20T11:00:00.000Z",
    );
    assert.equal(r.disagreement, false);
    assert.deepEqual(r.added, ["NVDA"]);
    assert.equal(r.verdict.event_label, "lead label");
    assert.equal(r.verdict.classified_at, lead.classified_at);
    assert.deepEqual(r.verdict.unassessed_tickers, ["TSM"]);
    assert.equal(r.verdict.tickers.length, 2);
    // Input untouched.
    assert.equal(lead.tickers.length, 1);
  });

  it("uncoveredTickers treats a failed verdict as covering nothing", () => {
    const req = newsRequest("x", "x", [NVDA, META]);
    assert.deepEqual(uncoveredTickers(null, req), ["NVDA", "META"]);
  });

  it("overflow: unassessed tickers are carried through untouched and counted", async () => {
    const { service, store } = makeService(fixtureCaller([{ match: "Broadcom", output: RECORDED.broadcom }]));
    const req = newsRequest("ovf", BROADCOM_HEADLINE, [AVGO, NVDA], {
      unassessed_tickers: ["TSM", "AMD"],
      syndication_scope: 4,
    });
    const out = await service.classify(req);
    assert.deepEqual(out.verdict.unassessed_tickers, ["TSM", "AMD"]);
    assert.equal(out.verdict.syndication_scope, 4);
    assert.equal(store.getMetrics().overflows, 1);
  });
});

describe("classify — validation retries (§7)", () => {
  it("retries up to 2 times, appending the validator error on the second retry, then succeeds", async () => {
    const log: Array<{ user: string }> = [];
    const { service, store } = makeService(
      sequenceCaller([RECORDED.bad_enum, RECORDED.not_json, RECORDED.gabelli], log),
    );
    const out = await service.classify(newsRequest("g", "Gabelli 13F", [NVDA]));
    assert.equal(out.source, "model");
    assert.equal(out.attempts, 3);
    assert.equal(log.length, 3);
    assert.ok(!log[1].user.includes("failed validation"), "first retry is a clean re-ask");
    assert.ok(log[2].user.includes("Your previous response failed validation"));
    assert.ok(log[2].user.includes("parse:"));
    assert.equal(store.getMetrics().validation_failures, 2);
    assert.equal(store.getMetrics().retries, 2);
  });

  it("persistent validation failure → status failed, no fabricated labels, attempt ledger advanced", async () => {
    const { service, store } = makeService(sequenceCaller([RECORDED.bad_conditional]));
    const req = newsRequest("bad", "x", [NVDA]);
    const out = await service.classify(req);
    assert.equal(out.source, "failed");
    assert.equal(out.verdict.status, "failed");
    assert.deepEqual(out.verdict.tickers, []);
    assert.deepEqual(out.verdict.unassessed_tickers, ["NVDA"]);
    assert.ok(out.verdict.failure_reason?.startsWith("validation:"));
    assert.equal(out.attempts, 3);
    const ledger = store.attemptsFor("id:bad");
    assert.equal(ledger?.attempts, 1);
    assert.equal(ledger?.permanent_failed, false);
    assert.equal(store.getMetrics().verdicts_failed, 1);
  });

  it("a failed article is retried on later cycles up to 3 attempts, then skipped as permanent-failed (§9)", async () => {
    const outputs = [RECORDED.not_json, RECORDED.not_json, RECORDED.not_json];
    const { service, store } = makeService(
      sequenceCaller([...outputs, ...outputs, ...outputs, RECORDED.gabelli]),
      { validationRetries: 2 },
    );
    const req = newsRequest("perm", "x", [NVDA]);
    assert.equal((await service.classify(req)).source, "failed");
    assert.equal((await service.classify(req)).source, "failed");
    const third = await service.classify(req);
    assert.equal(third.source, "failed");
    assert.equal(store.attemptsFor("id:perm")?.permanent_failed, true);
    const fourth = await service.classify(req);
    assert.equal(fourth.source, "skipped", "no further calls after permanent failure");
    assert.equal(fourth.attempts, 0);
    assert.equal(store.permanentFailures().length, 1);
  });

  it("a success after a failure clears the attempt ledger", async () => {
    const { service, store } = makeService(
      sequenceCaller([RECORDED.not_json, RECORDED.not_json, RECORDED.not_json, RECORDED.gabelli]),
    );
    const req = newsRequest("rec", "Gabelli", [NVDA]);
    await service.classify(req);
    assert.equal(store.attemptsFor("id:rec")?.attempts, 1);
    const out = await service.classify(req);
    assert.equal(out.source, "model");
    assert.equal(store.attemptsFor("id:rec"), null);
  });
});

describe("classify — transport (§9)", () => {
  it("retries transport errors with backoff and succeeds", async () => {
    const { service, store } = makeService(
      sequenceCaller([new Error("ECONNRESET"), new Error("503"), RECORDED.gabelli]),
    );
    const out = await service.classify(newsRequest("t", "x", [NVDA]));
    assert.equal(out.source, "model");
    assert.equal(out.attempts, 3);
    assert.equal(store.getMetrics().transport_failures, 2);
    assert.equal(service.getBreakerState().consecutive_failures, 0, "success resets the streak");
  });

  it("a timeout is a transport failure", async () => {
    let calls = 0;
    const caller: ModelCaller = (input) =>
      new Promise((resolve, reject) => {
        calls += 1;
        if (calls >= 2) {
          resolve({ text: RECORDED.gabelli, input_tokens: 1, output_tokens: 1 });
          return;
        }
        input.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { service, store } = makeService(caller, { timeoutMs: 5 });
    const out = await service.classify(newsRequest("to", "x", [NVDA]));
    assert.equal(out.source, "model");
    assert.equal(store.getMetrics().transport_failures, 1);
  });

  it("a 4xx (non-429) is not retried", async () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const log: Array<{ user: string }> = [];
    const { service } = makeService(sequenceCaller([err], log));
    const out = await service.classify(newsRequest("auth", "x", [NVDA]));
    assert.equal(out.source, "failed");
    assert.equal(log.length, 1);
    assert.ok(out.verdict.failure_reason?.includes("bad request"));
  });

  it("circuit breaker opens after k consecutive transport failures and holds the queue", async () => {
    const clock = { now: AT };
    const { service, store } = makeService(sequenceCaller([new Error("down")]), { transportRetries: 0 }, clock);
    const k = CONFIG.breaker.consecutiveFailures;
    for (let i = 0; i < k; i++) {
      const out = await service.classify(newsItemN(i));
      assert.equal(out.source, "failed");
    }
    const state = service.getBreakerState();
    assert.equal(state.status, "open");
    assert.equal(state.trips, 1);
    assert.equal(state.open_until, new Date(Date.parse(AT) + CONFIG.breaker.cooldownMs).toISOString());
    assert.equal(store.getMetrics().breaker_trips, 1);

    await assert.rejects(() => service.classify(newsItemN(99)), ClassifierBreakerOpenError);

    // Cooldown elapses → closed again, calls resume.
    clock.now = new Date(Date.parse(AT) + CONFIG.breaker.cooldownMs + 1).toISOString();
    assert.equal(service.getBreakerState().status, "closed");
    const out = await service.classify(newsItemN(100));
    assert.equal(out.source, "failed"); // still down, but it was attempted
    assert.equal(service.getBreakerState().consecutive_failures, 1);
  });

  it("a rejected credential opens the breaker on the first failure and says so", async () => {
    const err = Object.assign(new Error("API key is invalid."), { status: 401 });
    const { service } = makeService(sequenceCaller([err]), { transportRetries: 2 });
    const out = await service.classify(newsRequest("auth1", "x", [NVDA]));
    assert.equal(out.attempts, 1, "an auth failure is not retried");
    assert.ok(out.verdict.failure_reason?.startsWith("auth:"));
    assert.ok(out.verdict.failure_reason?.includes("ANTHROPIC_BASE_URL"));
    assert.equal(service.getBreakerState().status, "open");
    assert.equal(service.getBreakerState().trips, 1);
  });

  it("an auth failure does not charge the article's attempt ledger, so it is retried once the credential is fixed", async () => {
    const err = Object.assign(new Error("API key is invalid."), { status: 401 });
    const clock = { now: AT };
    const { service, store } = makeService(
      sequenceCaller([err, err, err, RECORDED.gabelli]),
      { transportRetries: 0 },
      clock,
    );
    const req = newsRequest("cfg", "Gabelli 13F", [NVDA]);
    for (let i = 0; i < 3; i++) {
      assert.equal((await service.classify(req)).source, "failed");
      // Each attempt trips the breaker immediately; step past the cooldown.
      clock.now = new Date(Date.parse(clock.now) + CONFIG.breaker.cooldownMs + 1).toISOString();
    }
    assert.equal(store.attemptsFor("id:cfg"), null, "no ledger row for a credential failure");
    assert.equal(store.permanentFailures().length, 0);
    // Credential fixed: the article is classified rather than skipped.
    const out = await service.classify(req);
    assert.equal(out.source, "model");
    assert.equal(out.verdict.status, "ok");
  });

  it("a batch against a dead key stops after the calls already in flight — the budget is not burned", async () => {
    let calls = 0;
    const err = Object.assign(new Error("API key is invalid."), { status: 401 });
    const caller: ModelCaller = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 1));
      throw err;
    };
    const { service, store } = makeService(caller, { transportRetries: 2, concurrency: 4 });
    const results = await service.classifyBatch(Array.from({ length: 40 }, (_, i) => newsItemN(i)));
    // The first 401 opens the breaker; only the calls already in flight
    // alongside it can also land. Everything still queued must not call.
    assert.ok(calls >= 1 && calls <= 4, `expected 1..4 calls before the breaker held the queue, got ${calls}`);
    assert.equal(results.filter((r) => r.outcome?.source === "failed").length, calls);
    assert.equal(results.filter((r) => r.error?.includes("breaker")).length, 40 - calls);
    assert.equal(store.getMetrics().verdicts_failed, calls);
    assert.equal(service.getBreakerState().status, "open");
  });

  it("classifyBatch respects the concurrency cap and halts on breaker-open", async () => {
    let active = 0;
    let peak = 0;
    const caller: ModelCaller = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
      return { text: RECORDED.gabelli, input_tokens: 1, output_tokens: 1 };
    };
    const { service } = makeService(caller, { concurrency: 2 });
    const results = await service.classifyBatch(Array.from({ length: 6 }, (_, i) => newsItemN(i)));
    assert.equal(results.filter((r) => r.outcome?.source === "model").length, 6);
    assert.ok(peak <= 2, `peak concurrency ${peak}`);
  });
});

describe("store + metrics helpers", () => {
  it("verdict TTL: expired rows are misses and pruned", () => {
    const store = new VerdictStore(new MemoryBackend());
    const v = {
      schema_version: 1,
      prompt_version: "cls-1.0",
      model: "m",
      article_key: "id:old",
      kind: "news" as const,
      event_type: "other" as const,
      event_label: "",
      syndication_scope: 1,
      tickers: [],
      unassessed_tickers: [],
      status: "ok" as const,
      metadata_missing: false,
      classified_at: "2026-08-01T00:00:00.000Z",
      failure_reason: null,
    };
    store.put(v);
    assert.ok(isExpired(v, "2026-08-09T00:00:00.000Z", 7));
    assert.equal(store.get("id:old", "cls-1.0", "m", "2026-08-09T00:00:00.000Z", 7), null);
    assert.equal(store.get("id:old", "cls-1.0", "m", "2026-08-05T00:00:00.000Z", 7)?.article_key, "id:old");
    // prompt_version bump is a cache miss.
    assert.equal(store.get("id:old", "cls-1.1", "m", "2026-08-05T00:00:00.000Z", 7), null);
    assert.equal(store.prune("2026-08-09T00:00:00.000Z", 7), 1);
    assert.equal(store.size(), 0);
  });

  it("pruneCredentialFailures clears auth-caused rows and leaves genuine failures alone", () => {
    const store = new VerdictStore(new MemoryBackend());
    const failed = (key: string, reason: string) => ({
      schema_version: 1,
      prompt_version: "cls-1.0",
      model: "m",
      article_key: key,
      kind: "news" as const,
      event_type: "other" as const,
      event_label: "",
      syndication_scope: 1,
      tickers: [],
      unassessed_tickers: ["NVDA"],
      status: "failed" as const,
      metadata_missing: false,
      classified_at: AT,
      failure_reason: reason,
    });
    // The shape the old code wrote before auth failures stopped being charged.
    store.put(failed("id:a", 'transport: 401 {"type":"error","error":{"message":"API key is invalid."}}'));
    store.put(failed("id:b", "validation: enum: event_type \"rumor\" not in taxonomy"));
    store.recordAttempt("id:a", 'transport: 401 {"error":"API key is invalid."}', AT, 1);
    store.recordAttempt("id:b", "validation: boom", AT, 1);
    assert.equal(store.permanentFailures().length, 2);

    const pruned = store.pruneCredentialFailures();
    assert.deepEqual(pruned, { attempts: 1, verdicts: 1 });
    assert.equal(store.attemptsFor("id:a"), null, "the auth-poisoned article can be retried");
    assert.equal(store.attemptsFor("id:b")?.permanent_failed, true, "a real failure is untouched");
    assert.equal(store.latestFor("id:a"), null);
    assert.equal(store.latestFor("id:b")?.status, "failed");
  });

  it("percentiles and spend estimate", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([100, 200, 300, 400], 50), 200);
    assert.equal(percentile([100, 200, 300, 400], 95), 400);
    assert.ok(Math.abs(estimateSpendUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }) - 6) < 1e-9);
  });

  it("metrics by_cell is keyed event_type|relevance|materiality", async () => {
    const { service, store } = makeService(fixtureCaller([{ match: "3 Funds", output: RECORDED.listicle }]));
    await service.classify(newsRequest("lst", "3 Funds For The Technologies", [NVDA, META]));
    assert.deepEqual(store.getMetrics().by_cell, { "macro_sector|none|-": 2 });
  });
});

function newsItemN(i: number) {
  return newsRequest(`n${i}`, `headline ${i}`, [NVDA]);
}

describe("classifyBatch billable flag", () => {
  it("marks a breaker-open refusal as not billable", async () => {
    // The bug this exists for: Promise.all starts every request before the
    // first can set `halted`, so the rest reach an already-open breaker and
    // fail without ever making a call. Charging those to the daily cap drained
    // 531 units of budget on 8 real failures.
    const { service } = makeService(
      async () => {
        throw Object.assign(new Error("upstream exploded"), { status: 500 });
      },
      { concurrency: 1, breaker: { consecutiveFailures: 1, cooldownMs: 60_000 } },
    );

    const out = await service.classifyBatch(Array.from({ length: 5 }, (_, i) => newsItemN(i)));

    const billable = out.filter((r) => r.billable).length;
    const refused = out.filter((r) => r.error && !r.billable).length;

    assert.ok(billable >= 1, "the call that tripped the breaker was paid for");
    assert.ok(refused >= 1, "the ones refused behind an open breaker were not");
    assert.ok(billable < out.length, "not every request should be charged");
  });

  it("marks a call that reached the provider billable, even when it fails", async () => {
    // A transport failure spent money; only a refusal that never left does not.
    const { service } = makeService(async () => {
      throw Object.assign(new Error("upstream exploded"), { status: 500 });
    });
    const out = await service.classifyBatch([newsItemN(0)]);
    assert.equal(out[0]!.billable, true);
  });
});
