import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidateRefs } from "./schema.js";
import { PropagationService } from "./service.js";
import { NO_QUANT, runStage1, summarize } from "./stage1.js";
import { MemoryBackend, PropagationRunStore } from "./store.js";
import {
  NOW,
  configFixture,
  eventFixture,
  failingCaller,
  jsonCaller,
  quantSource,
  requestFixture,
  sequenceCaller,
  snapshot,
  syntheticGraph,
} from "./test-fixtures.js";
import type { ModelCaller, PropagationRun } from "./types.js";

const QUANT = quantSource({
  TSM: snapshot({ ticker: "TSM", lastPrice: 99.8 }), // open
  MU: snapshot({ ticker: "MU", lastPrice: 97.0 }), // priced (−3% vs 2% strong)
  MSFT: snapshot({ ticker: "MSFT", lastPrice: 99.0 }), // partial
});

function service(callModel: ModelCaller | null, overrides: Partial<Parameters<typeof configFixture>[0]> = {}) {
  const store = new PropagationRunStore(new MemoryBackend());
  const svc = new PropagationService({
    config: configFixture(overrides),
    store,
    graph: () => syntheticGraph(),
    quant: QUANT,
    callModel,
    now: () => NOW,
    sleep: async () => {},
  });
  return { svc, store };
}

/** A stage-2 answer that confirms every ref, resolving unclear competitors to positive. */
function confirmAll(run: PropagationRun) {
  return {
    targets: candidateRefs(run.targets).map((r) => ({
      ref: r.ref,
      verdict: "confirmed",
      direction: r.direction === "unclear" ? "positive" : null,
      mechanism: `Mechanism for ${r.target}.`,
      rationale: null,
    })),
  };
}

describe("stage-1 runner", () => {
  it("NVDA earnings run: traversal → matrix → pricing → template mechanism, deterministic", async () => {
    const run = await runStage1({ graph: syntheticGraph(), request: requestFixture(), config: configFixture(), quant: QUANT, now: NOW });
    assert.equal(run.root_ticker, "NVDA");
    assert.equal(run.status, "stage1_only");
    assert.deepEqual(run.graph_version, { generatedAt: "2026-08-13T22:38:11.325Z", pipelineVersion: 5 });
    assert.equal(run.reachable, 9);
    // earnings_results: every role transmits (supplier yes, customer weak, competitor yes/unclear,
    // partner weak, dependency yes, depended_on_by weak) → all 9 reachable survive the matrix.
    assert.equal(run.non_transmitting, 0);
    // 8, not 9: MSFT is reached as both a customer and a competitor, and one
    // entity gets one call (§4a). The competitor cell reads unclear here, so
    // there is no sign to disagree with — the customer direction stands.
    assert.equal(run.targets.length, 8);
    const msft = run.targets.find((t) => t.target === "MSFT")!;
    assert.equal(msft.relationship.role, "customer");
    assert.deepEqual(msft.transmission.also_roles, ["competitor"]);
    assert.equal(msft.transmission.role_conflict, false);
    assert.equal(msft.transmission.direction, "negative");
    assert.equal(run.overflow, 0);

    const byKey = new Map(run.targets.map((t) => [`${t.target}|${t.relationship.role}`, t]));
    const tsm = byKey.get("TSM|supplier")!;
    assert.equal(tsm.tracked, true);
    assert.equal(tsm.transmission.tier, "moderate"); // important × high
    assert.equal(tsm.transmission.direction, "negative");
    assert.equal(tsm.pricing.status, "open");
    assert.match(tsm.mechanism, /^NVDA Q2 revenue miss; data-center guide below consensus\. TSM is an important supplier of NVDA \(wafer fabrication, per NVDA filing\)\. Transmits negative\.$/);

    const mu = byKey.get("MU|supplier")!;
    assert.equal(mu.transmission.tier, "strong"); // critical × high
    assert.equal(mu.pricing.status, "priced");

    const amd = byKey.get("AMD|competitor")!;
    assert.equal(amd.transmission.direction, "unclear");
    assert.equal(amd.tracked, false); // not in the quant source
    assert.equal(amd.pricing.status, "unknown");
    assert.match(amd.mechanism, /Transmits with unclear sign\./);
    assert.match(amd.mechanism, /per AMD filing/); // the reverse edge outranked → asserted in AMD's filing

    const msftCust = byKey.get("MSFT|customer")!;
    assert.equal(msftCust.transmission.transmits, "weak");
    assert.equal(msftCust.pricing.status, "partial");
    assert.match(msftCust.mechanism, /Transmits weakly negative/);

    const samsung = byKey.get("name:samsung electronics|supplier")!;
    assert.equal(samsung.tracked, false);
    assert.equal(samsung.ticker, null);
    assert.equal(samsung.pricing.status, "unknown");

    // MSFT appears twice (customer partial, competitor priced on magnitude — weak tier, unclear sign).
    assert.deepEqual(run.summary, { targets: 8, open: 1, partial: 1, priced: 1, contradicted: 0, stale: 0, untracked: 5, vetoed: 0, no_edge: false });
    assert.equal(run.trigger.priority_band, "P0");

    const again = await runStage1({ graph: syntheticGraph(), request: requestFixture(), config: configFixture(), quant: QUANT, now: NOW });
    assert.deepEqual(again, run);
  });

  it("caps after the matrix with overflow counted", async () => {
    const run = await runStage1({ graph: syntheticGraph(), request: requestFixture(), config: configFixture({ maxTargets: 3 }), quant: QUANT, now: NOW });
    assert.equal(run.targets.length, 3);
    assert.equal(run.overflow, 5); // 8 after the entity collapse, minus the 3 kept
    assert.equal(run.targets[0].relationship.tier, "critical");
  });

  it("a non-transmitting event type yields a complete no-edge run", async () => {
    const req = requestFixture({ event: eventFixture({ type: "analyst_action" }) });
    const run = await runStage1({ graph: syntheticGraph(), request: req, config: configFixture(), quant: QUANT, now: NOW });
    assert.equal(run.targets.length, 0);
    assert.equal(run.non_transmitting, 9);
    assert.equal(run.summary.no_edge, true);
  });

  it("legal event: suppliers/customers drop, competitor/partner/dependency weak", async () => {
    const req = requestFixture({ event: eventFixture({ type: "legal", direction: "negative", materiality: "standard" }) });
    const run = await runStage1({ graph: syntheticGraph(), request: req, config: configFixture(), quant: QUANT, now: NOW });
    const roles = run.targets.map((t) => t.relationship.role);
    assert.ok(!roles.includes("supplier") && !roles.includes("customer"));
    assert.ok(roles.includes("competitor"));
    assert.equal(run.non_transmitting, 4);
  });

  it("a root outside the graph → no-edge run with zero reachable", async () => {
    const run = await runStage1({ graph: syntheticGraph(), request: requestFixture({ root_ticker: "ZZZZ" }), config: configFixture(), quant: NO_QUANT, now: NOW });
    assert.equal(run.reachable, 0);
    assert.equal(run.summary.no_edge, true);
  });

  it("5. a target that moved the wrong way is counted as contradicted, never as priced", async () => {
    // NVDA supplier thesis is positive (contract_partnership); TSM moved down
    // 2.5% against a 2% expected scale → contradicted, and the run keeps its
    // open target, so the counters do not fold into one another.
    const req = requestFixture({ event: eventFixture({ type: "contract_partnership", direction: "positive" }) });
    const quant = quantSource({
      TSM: snapshot({ ticker: "TSM", lastPrice: 97.5 }), // −2.5% against a positive thesis
      MU: snapshot({ ticker: "MU", lastPrice: 102.5 }), // +2.5% with the thesis
      MSFT: snapshot({ ticker: "MSFT", lastPrice: 99.95 }), // flat → open
    });
    const run = await runStage1({ graph: syntheticGraph(), request: req, config: configFixture(), quant, now: NOW });
    const byKey = new Map(run.targets.map((t) => [`${t.target}|${t.relationship.role}`, t]));
    assert.equal(byKey.get("TSM|supplier")!.pricing.status, "contradicted");
    assert.equal(byKey.get("MU|supplier")!.pricing.status, "priced");
    assert.equal(byKey.get("MSFT|customer")!.pricing.status, "open");
    assert.equal(run.summary.contradicted, 1);
    assert.equal(run.summary.priced, 1);
    assert.equal(run.summary.open, 1); // MSFT is flat, and appears once (§4a entity collapse)
    // The contradicted target is neither an edge nor an absorption.
    assert.equal(run.summary.contradicted + run.summary.open + run.summary.partial + run.summary.priced + run.summary.untracked, run.summary.targets);
    assert.equal(run.summary.no_edge, false);
  });

  it("a run whose only tracked target is contradicted has no edge left to trade", () => {
    const t = (status: string) => ({ tracked: true, pricing: { status }, stage2: null }) as never;
    const s = summarize([t("contradicted"), t("priced")]);
    assert.equal(s.contradicted, 1);
    assert.equal(s.priced, 1);
    assert.equal(s.no_edge, true);
    assert.equal(summarize([t("contradicted"), t("open")]).no_edge, false);
  });

  it("everything priced → no_edge true", () => {
    const t = (status: "priced" | "open", vetoed = false) =>
      ({ tracked: true, pricing: { status }, stage2: vetoed ? { verdict: "vetoed" } : null }) as never;
    assert.equal(summarize([t("priced"), t("priced")]).no_edge, true);
    assert.equal(summarize([t("priced"), t("open")]).no_edge, false);
    // A vetoed open target does not count.
    const s = summarize([t("priced"), t("open", true)]);
    assert.equal(s.no_edge, true);
    assert.equal(s.vetoed, 1);
    assert.equal(s.targets, 1);
  });
});

describe("service (§2, §7, §11)", () => {
  it("stage-1 + stage-2 → status ok; mechanisms replaced; pricing untouched; budget consumed", async () => {
    const stage1 = await runStage1({ graph: syntheticGraph(), request: requestFixture(), config: configFixture(), quant: QUANT, now: NOW });
    const { svc, store } = service(jsonCaller(confirmAll(stage1)));
    const out = await svc.run(requestFixture(), { stage2: true });
    assert.equal(out.source, "ok");
    assert.equal(out.stage2_called, true);
    assert.equal(out.run.status, "ok");
    assert.equal(out.run.stage2?.failure_reason, null);
    assert.equal(out.run.stage2?.attempts, 1);
    const amd = out.run.targets.find((t) => t.target === "AMD")!;
    assert.equal(amd.transmission.direction, "positive");
    assert.equal(amd.mechanism, "Mechanism for AMD|competitor.");
    const tsm = out.run.targets.find((t) => t.target === "TSM")!;
    assert.equal(tsm.pricing.status, "open");
    assert.deepEqual(tsm.pricing, stage1.targets.find((t) => t.target === "TSM")!.pricing);
    const m = store.getMetrics();
    assert.equal(m.runs_ok, 1);
    // Only AMD now: MSFT's unclear competitor cell folded into its customer
    // call before stage-2 ever saw it.
    assert.equal(m.unclear_resolved, 1);
    assert.equal(m.unclear_total, 1);
    assert.equal(m.input_tokens, 100);
    assert.equal(store.size(), 1);
  });

  it("stage-2 skipped (budget) → stage1_only with the reason; nothing fabricated", async () => {
    const { svc } = service(jsonCaller({ targets: [] }));
    const out = await svc.run(requestFixture(), { stage2: false, stage2SkipReason: "daily budget exhausted" });
    assert.equal(out.source, "stage1_only");
    assert.equal(out.stage2_called, false);
    assert.equal(out.run.status, "stage1_only");
    assert.equal(out.run.stage2?.skipped_reason, "daily budget exhausted");
    assert.ok(out.run.targets.every((t) => t.stage2 === null));
  });

  it("no model caller → stage1_only, still a complete run", async () => {
    const { svc } = service(null);
    const out = await svc.run(requestFixture(), { stage2: true });
    assert.equal(out.run.status, "stage1_only");
    assert.match(out.run.stage2?.skipped_reason ?? "", /ANTHROPIC_API_KEY/);
    assert.equal(out.run.targets.length, 8);
  });

  it("MANDATORY add-attempt fixture: the model adds a target → rejected, retried, then stage1_only", async () => {
    const caller = jsonCaller({
      targets: [
        { ref: "c1", verdict: "confirmed", direction: null, mechanism: null, rationale: null },
        { ref: "AVGO|supplier", verdict: "confirmed", direction: "negative", mechanism: "Broadcom networking exposure.", rationale: null },
      ],
    });
    const { svc, store } = service(caller);
    const out = await svc.run(requestFixture(), { stage2: true });
    assert.equal(out.run.status, "stage1_only");
    assert.match(out.run.stage2?.failure_reason ?? "", /targets cannot be added/);
    assert.equal(out.run.stage2?.attempts, 3); // 1 + 2 validation retries
    assert.ok(out.run.targets.every((t) => t.target !== "AVGO"));
    assert.ok(out.run.targets.every((t) => t.stage2 === null));
    const m = store.getMetrics();
    assert.equal(m.added_target_rejections, 3);
    assert.equal(m.validation_failures, 3);
    assert.equal(m.runs_stage1_only, 1);
  });

  it("a validation failure is retried with the error appended and then accepted", async () => {
    const stage1 = await runStage1({ graph: syntheticGraph(), request: requestFixture(), config: configFixture(), quant: QUANT, now: NOW });
    const good = JSON.stringify(confirmAll(stage1));
    const calls: string[] = [];
    const seq = sequenceCaller(["{\"targets\":[{\"ref\":\"c99\",\"verdict\":\"confirmed\",\"direction\":null,\"mechanism\":null,\"rationale\":null}]}", good]);
    const wrapped: ModelCaller = async (input) => {
      calls.push(input.user);
      return seq(input);
    };
    const { svc } = service(wrapped);
    const out = await svc.run(requestFixture(), { stage2: true });
    assert.equal(out.run.status, "ok");
    assert.equal(out.run.stage2?.attempts, 2);
    assert.equal(out.run.stage2?.retry_errors.length, 1);
    assert.match(calls[1], /previous response failed validation/);
    assert.match(calls[1], /targets cannot be added/);
  });

  it("transport failure: retries with backoff, then stage1_only; breaker opens after k consecutive failures", async () => {
    const caller = failingCaller(() => Object.assign(new Error("ECONNRESET"), { status: 503 }));
    const { svc, store } = service(caller, { transportRetries: 2, breaker: { consecutiveFailures: 3, cooldownMs: 600_000 } });
    const out = await svc.run(requestFixture(), { stage2: true });
    assert.equal(out.run.status, "stage1_only");
    assert.match(out.run.stage2?.failure_reason ?? "", /transport: ECONNRESET/);
    assert.equal(caller.calls, 3);
    const breaker = svc.getBreakerState();
    assert.equal(breaker.status, "open");
    assert.equal(breaker.trips, 1);
    assert.equal(store.getMetrics().breaker_trips, 1);
    // While open, the next request's stage-2 is skipped — stage-1 still ships.
    const next = await svc.run(requestFixture({ request_id: "pr-inc-nvda-earnings-other", incident_id: "inc-other" }), { stage2: true });
    assert.equal(next.run.status, "stage1_only");
    assert.match(next.run.stage2?.skipped_reason ?? "", /breaker open/);
    assert.equal(caller.calls, 3);
  });

  it("a refusal (4xx) is not retried", async () => {
    const caller = failingCaller(() => Object.assign(new Error("model refused the request"), { status: 400 }));
    const { svc } = service(caller);
    const out = await svc.run(requestFixture(), { stage2: true });
    assert.equal(caller.calls, 1);
    assert.match(out.run.stage2?.failure_reason ?? "", /refused/);
  });

  it("a timeout aborts the call and is reported as such", async () => {
    const caller: ModelCaller = (input) =>
      new Promise((_, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { svc } = service(caller, { timeoutMs: 5, transportRetries: 0 });
    const out = await svc.run(requestFixture(), { stage2: true });
    assert.match(out.run.stage2?.failure_reason ?? "", /timeout after 5ms/);
  });

  it("same request twice → served from the store; a new best event supersedes the prior run", async () => {
    const { svc, store } = service(null);
    const first = await svc.run(requestFixture(), { stage2: false });
    const again = await svc.run(requestFixture(), { stage2: false });
    assert.equal(again.source, "cache");
    assert.equal(store.getMetrics().cache_hits, 1);

    const updated = requestFixture({
      event: eventFixture({ materiality: "standard", source_msg_ids: ["n-nvda-2"] }),
      update: true,
      prior_run_id: first.run.run_id,
    });
    assert.notEqual(updated.request_id, first.run.request_id);
    const second = await svc.run(updated, { stage2: false });
    assert.equal(second.run.update_of, first.run.run_id);
    assert.deepEqual(second.superseded, [first.run.run_id]);
    assert.equal(store.get(first.run.run_id)?.superseded_by, second.run.run_id);
    assert.equal(store.latestFor("inc-nvda-earnings")?.run_id, second.run.run_id);
    assert.equal(store.list({ currentOnly: true }).length, 1);
    assert.equal(store.getMetrics().superseded, 1);
  });

  it("per-incident lane: a queued request is dropped when a newer one arrives", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: ModelCaller = async () => {
      await gate;
      return { text: JSON.stringify({ targets: [] }), input_tokens: 1, output_tokens: 1 };
    };
    const { svc } = service(slow);
    const p1 = svc.run(requestFixture(), { stage2: true });
    const p2 = svc.run(requestFixture({ request_id: "pr-inc-nvda-earnings-b" }), { stage2: false });
    const p3 = svc.run(requestFixture({ request_id: "pr-inc-nvda-earnings-c" }), { stage2: false });
    const dropped = await p2;
    assert.equal(dropped.source, "dropped");
    release();
    const [o1, o3] = await Promise.all([p1, p3]);
    assert.equal(o1.run.status, "ok");
    assert.equal(o3.run.request_id, "pr-inc-nvda-earnings-c");
    assert.equal(svc.activeIncidents, 0);
  });

  it("stage-1 failure (graph unreadable) → failed run, attempt ledger, permanent after max attempts", async () => {
    const store = new PropagationRunStore(new MemoryBackend());
    const svc = new PropagationService({
      config: configFixture({ maxAttemptsPerRequest: 2 }),
      store,
      graph: () => {
        throw new Error("graph.json missing");
      },
      quant: NO_QUANT,
      callModel: null,
      now: () => NOW,
    });
    const a = await svc.run(requestFixture(), { stage2: false });
    assert.equal(a.source, "failed");
    assert.match(a.run.failure_reason ?? "", /graph.json missing/);
    const b = await svc.run(requestFixture(), { stage2: false });
    assert.equal(b.source, "failed");
    assert.equal(store.permanentFailures().length, 1);
    const c = await svc.run(requestFixture(), { stage2: false });
    assert.equal(c.source, "skipped");
  });

  it("runBatch reports per-item outcomes", async () => {
    const { svc } = service(null);
    const results = await svc.runBatch([
      { request: requestFixture(), options: { stage2: false } },
      { request: requestFixture({ root_ticker: "TSM", request_id: "pr-inc-nvda-earnings-tsm", incident_id: "inc-tsm" }), options: { stage2: false } },
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.error === null && r.outcome));
    assert.equal(results[1].outcome?.run.targets[0].target, "NVDA");
    assert.equal(results[1].outcome?.run.targets[0].relationship.role, "customer");
  });
});
