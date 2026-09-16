/**
 * Recorded-request fixtures (spec §12 step 3): the propagation requests the
 * live Base replay produced on 2026-08-22 (HON/AMD 8-K routes, the WMT P0
 * incident, and the band-qualified Classifier candidates), replayed through
 * stage-1 against the synthetic graph (deterministic, CI-safe) and — when the
 * checkout has it — the real graph.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadGraphIndexSync } from "./graph.js";
import type { PropagationRequest } from "./requests.js";
import { propagationRequestId } from "./requests.js";
import { selectBestEvent } from "./event.js";
import { NO_QUANT, runStage1 } from "./stage1.js";
import { NOW, configFixture, realGraphPath, syntheticGraph } from "./test-fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures");

type Recorded = { recorded_at: string; request: PropagationRequest; graph_version: { generatedAt: string; pipelineVersion: number } };

function loadAll(): Recorded[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Recorded);
}

describe("recorded propagation requests", () => {
  const all = loadAll();

  it("nine recorded requests, each with a readable best event whose id re-derives", () => {
    assert.ok(all.length >= 9, `expected ≥ 9 fixtures, found ${all.length}`);
    for (const rec of all) {
      const r = rec.request;
      assert.equal(r.request_id, propagationRequestId(r.incident, r.root_ticker, r.event));
      const again = selectBestEvent(r.incident, r.verdicts, { rootTicker: r.root_ticker, config: configFixture() });
      assert.ok(again, `${r.root_ticker}: event re-derives`);
      assert.equal(again.type, r.event.type);
      assert.equal(again.direction, r.event.direction);
      assert.equal(again.materiality, r.event.materiality);
      assert.deepEqual(again.source_msg_ids, r.event.source_msg_ids);
    }
  });

  it("the three Base-routed requests: HON and AMD mapped 8-Ks, WMT P0 with 8-K + event_gap", () => {
    const routed = all.filter((r) => r.request.trigger_rules.some((x) => x.startsWith("filing_item") || x.startsWith("gap_event")));
    const byTicker = new Map(routed.map((r) => [r.request.root_ticker, r.request]));
    assert.ok(byTicker.has("HON") && byTicker.has("AMD") && byTicker.has("WMT"), [...byTicker.keys()].join(","));
    const wmt = byTicker.get("WMT")!;
    assert.equal(wmt.incident.priority_band, "P0");
    assert.deepEqual(wmt.trigger_rules, ["filing_item.8k.mapped", "gap_event.propagation"]);
    // The WMT incident carries high-materiality direct verdicts → the verdict wins over the 8-K.
    assert.equal(wmt.event.source, "verdict");
    assert.equal(wmt.event.materiality, "high");
    for (const t of ["HON", "AMD"]) {
      const r = byTicker.get(t)!;
      assert.equal(r.event.source, "filing_item");
      assert.equal(r.event.type, "management_governance");
    }
  });

  it("candidate-qualified requests are P2+ and carry a verdict event", () => {
    const cands = all.filter((r) => r.request.trigger_rules.includes("propagation_candidates"));
    assert.ok(cands.length >= 5);
    for (const r of cands) {
      assert.ok(["P0", "P1", "P2"].includes(r.request.incident.priority_band), r.request.root_ticker);
      assert.equal(r.request.event.source, "verdict");
      assert.ok(r.request.incident.propagation_candidates.length > 0);
    }
  });

  it("stage-1 over every recorded request is deterministic and complete (synthetic graph)", async () => {
    const g = syntheticGraph();
    for (const rec of all) {
      const a = await runStage1({ graph: g, request: rec.request, config: configFixture(), quant: NO_QUANT, now: NOW });
      const b = await runStage1({ graph: g, request: rec.request, config: configFixture(), quant: NO_QUANT, now: NOW });
      assert.deepEqual(a, b);
      assert.equal(a.root_ticker, rec.request.root_ticker);
      assert.ok(["stage1_only"].includes(a.status));
      assert.equal(a.targets.length, a.summary.targets);
      assert.ok(a.targets.every((t) => t.pricing.status === "unknown" && !t.tracked));
    }
  });

  it("real graph: the WMT and NVDA runs reach the expected counterparties", { skip: !realGraphPath() }, async () => {
    const g = loadGraphIndexSync(realGraphPath()!);
    const wmt = all.find((r) => r.request.root_ticker === "WMT")!;
    const run = await runStage1({ graph: g, request: wmt.request, config: configFixture(), quant: NO_QUANT, now: NOW });
    // WMT's forward edges are five countries (China, Mexico, Vietnam, India,
    // Canada, filed as "suppliers"), JD.com and Flipkart. Only JD is tradable,
    // so the reachable set is JD plus COST from Costco's own filing. Before
    // the counterparty_type filter this said `>= 5` and was counting nations
    // as propagation targets, every one of them permanently unpriceable.
    assert.ok(run.reachable >= 2, `WMT reachable ${run.reachable}`);
    assert.ok(
      !run.targets.some((t) => ["China", "Mexico", "Vietnam", "India", "Canada"].includes(t.label)),
      "a country must never be a propagation target",
    );
    assert.ok(run.targets.some((t) => t.target === "COST" && t.relationship.role === "competitor"), "COST reached as competitor via its own filing");
    assert.equal(run.graph_version.pipelineVersion, g.version.pipelineVersion);
    const nvda = all.find((r) => r.request.root_ticker === "NVDA")!;
    const nrun = await runStage1({ graph: g, request: nvda.request, config: configFixture(), quant: NO_QUANT, now: NOW });
    assert.equal(nrun.targets.length, 15);
    assert.ok(nrun.overflow > 0);
    assert.ok(nrun.targets.some((t) => t.target === "TSM" && t.relationship.role === "supplier"));
  });
});
