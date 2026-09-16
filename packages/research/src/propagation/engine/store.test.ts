import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_PROPAGATION_CONFIG } from "./config.js";
import { FileBackend, PropagationConfigStore, PropagationRunStore, coerceStoredRun, isExpired } from "./store.js";
import { NO_QUANT, runStage1 } from "./stage1.js";
import { NOW, configFixture, requestFixture, syntheticGraph } from "./test-fixtures.js";

async function sampleRun(overrides: { request_id?: string; incident_id?: string; produced_at?: string } = {}) {
  const run = await runStage1({
    graph: syntheticGraph(),
    request: requestFixture({
      ...(overrides.request_id ? { request_id: overrides.request_id } : {}),
      ...(overrides.incident_id ? { incident_id: overrides.incident_id } : {}),
    }),
    config: configFixture(),
    quant: NO_QUANT,
    now: overrides.produced_at ?? NOW,
  });
  return run;
}

describe("run store (§9, §11)", () => {
  it("file backend round-trips runs, attempts, metrics; config file writes defaults on first load", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prop-store-"));
    try {
      const store = new PropagationRunStore(new FileBackend(dir));
      const run = await sampleRun();
      store.put(run);
      store.recordAttempt(run.request_id, run.incident_id, "stage2: boom", NOW, 3);
      store.updateMetrics((m) => {
        m.runs_ok += 1;
      });
      const reread = new PropagationRunStore(new FileBackend(dir));
      assert.deepEqual(reread.get(run.run_id), run);
      assert.equal(reread.attemptsFor(run.request_id)?.attempts, 1);
      assert.equal(reread.getMetrics().runs_ok, 1);
      assert.equal(reread.byRequest(run.request_id)?.run_id, run.run_id);

      const cfgStore = new PropagationConfigStore(dir);
      const cfg = cfgStore.load();
      assert.deepEqual(cfg, DEFAULT_PROPAGATION_CONFIG);
      assert.ok(fs.existsSync(cfgStore.configFile));
      cfgStore.save({ ...cfg, maxTargets: 7 });
      assert.equal(new PropagationConfigStore(dir).load().maxTargets, 7);
      assert.equal(new PropagationConfigStore(dir).load().pricing.openBelow, 0.35);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list filters: status, ticker, currentOnly, openOnly, limit; newest first", async () => {
    const store = new PropagationRunStore();
    const a = await sampleRun({ request_id: "pr-a", incident_id: "inc-a", produced_at: "2026-08-20T00:00:00.000Z" });
    const b = await sampleRun({ request_id: "pr-b", incident_id: "inc-b", produced_at: "2026-08-21T00:00:00.000Z" });
    store.put(a);
    store.put({ ...b, status: "ok", summary: { ...b.summary, open: 2 } });
    assert.deepEqual(store.list().map((r) => r.run_id), [b.run_id, a.run_id]);
    assert.equal(store.list({ status: "ok" }).length, 1);
    assert.equal(store.list({ ticker: "nvda" }).length, 2);
    assert.equal(store.list({ openOnly: true }).length, 1);
    assert.equal(store.list({ limit: 1 }).length, 1);
    store.markSuperseded("inc-a", "run-zzz");
    assert.equal(store.list({ currentOnly: true }).length, 1);
    assert.equal(store.forIncident("inc-a").length, 1);
  });

  it("prunes past retention and ignores corrupt rows", async () => {
    const store = new PropagationRunStore();
    const old = await sampleRun({ request_id: "pr-old", incident_id: "inc-old", produced_at: "2026-05-01T00:00:00.000Z" });
    store.put(old);
    assert.equal(isExpired(old, NOW, 90), true);
    assert.equal(store.prune(NOW, 90), 1);
    assert.equal(store.size(), 0);
    assert.equal(coerceStoredRun({ run_id: "x" }), null);
    assert.equal(coerceStoredRun(null), null);
    const ok = coerceStoredRun({ ...old, superseded_by: 5, stage2: undefined });
    assert.equal(ok?.superseded_by, null);
    assert.equal(ok?.stage2, null);
  });

  it("fixture isolation: synthetic runs are excluded from the live list by default", async () => {
    const store = new PropagationRunStore();
    const live = await sampleRun({ request_id: "pr-live", incident_id: "inc-live" });
    const fixture = { ...(await sampleRun({ request_id: "pr-fix", incident_id: "inc-fix" })), synthetic: true };
    store.put(live);
    store.put(fixture);
    assert.deepEqual(store.list().map((r) => r.run_id), [live.run_id]);
    assert.deepEqual(store.list({ synthetic: "only" }).map((r) => r.run_id), [fixture.run_id]);
    assert.equal(store.list({ synthetic: "all" }).length, 2);
    // A stored row without the flag (older schema) reads as live.
    assert.equal(coerceStoredRun({ ...live, synthetic: undefined })?.synthetic, false);
    // A request marked synthetic yields a synthetic run.
    const seeded = await runStage1({ graph: syntheticGraph(), request: requestFixture({ synthetic: true }), config: configFixture(), quant: NO_QUANT, now: NOW });
    assert.equal(seeded.synthetic, true);
  });

  it("attempt ledger: success clears, failures accumulate to permanent", () => {
    const store = new PropagationRunStore();
    store.recordAttempt("pr-1", "inc-1", "err", NOW, 2);
    assert.equal(store.permanentFailures().length, 0);
    store.recordAttempt("pr-1", "inc-1", "err", NOW, 2);
    assert.equal(store.permanentFailures().length, 1);
    store.recordAttempt("pr-1", "inc-1", null, NOW, 2);
    assert.equal(store.attemptsFor("pr-1"), null);
  });
});

describe("run store — merge from the server mirror", () => {
  it("adds runs it has never seen and reports their ids", async () => {
    const store = new PropagationRunStore();
    const a = await sampleRun({ request_id: "pr-a", incident_id: "inc-a" });
    const b = await sampleRun({ request_id: "pr-b", incident_id: "inc-b" });
    assert.deepEqual(store.merge([a, b]).sort(), [a.run_id, b.run_id].sort());
    assert.equal(store.size(), 2);
    // Merging the same runs again changes nothing.
    assert.deepEqual(store.merge([a, b]), []);
  });

  it("never overwrites a run it already holds", async () => {
    const store = new PropagationRunStore();
    const local = await sampleRun({ request_id: "pr-a", incident_id: "inc-a" });
    store.put({ ...local, status: "ok" });
    // The remote copy is the same run, stage-1 only — local stays authoritative.
    store.merge([{ ...local, status: "stage1_only" }]);
    assert.equal(store.get(local.run_id)?.status, "ok");
  });

  it("learns supersession from the mirror, but only in the forward direction", async () => {
    const store = new PropagationRunStore();
    const run = await sampleRun({ request_id: "pr-a", incident_id: "inc-a" });
    store.put(run);
    assert.equal(store.get(run.run_id)?.superseded_by, null);

    // Another install superseded it: that has to propagate.
    assert.deepEqual(store.merge([{ ...run, superseded_by: "run-newer" }]), [run.run_id]);
    assert.equal(store.get(run.run_id)?.superseded_by, "run-newer");

    // A stale remote copy that still thinks it is current must not revive it.
    assert.deepEqual(store.merge([{ ...run, superseded_by: null }]), []);
    assert.equal(store.get(run.run_id)?.superseded_by, "run-newer");
  });

  it("ignores malformed entries instead of throwing", async () => {
    const store = new PropagationRunStore();
    const good = await sampleRun({ request_id: "pr-a", incident_id: "inc-a" });
    const changed = store.merge([
      null as unknown as typeof good,
      { run_id: "" } as unknown as typeof good,
      good,
    ]);
    assert.deepEqual(changed, [good.run_id]);
  });
});
