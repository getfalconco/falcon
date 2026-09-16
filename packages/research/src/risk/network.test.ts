import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadGraphIndexSync } from "../propagation/engine/graph.js";
import { realGraphPath } from "../propagation/engine/test-fixtures.js";
import { networkComponent } from "./components.js";
import { linkedFraction, pairLink } from "./network.js";
import { cfg, syntheticGraph, weightsOf } from "./test-fixtures.js";

const config = cfg();
const graph = syntheticGraph();

describe("risk/network — pairwise links", () => {
  it("NVDA+TSM equal weights, critical supplier edge → network ≥ 60 and the payload names the edge", () => {
    const n = networkComponent(weightsOf([["NVDA", 0.5], ["TSM", 0.5]]), graph, config, []);
    assert.equal(n.linked_fraction, 1);
    assert.ok(n.score >= 60);
    assert.equal(n.score, 90);
    const top = n.top_links[0];
    assert.equal(top.via, "direct");
    assert.equal(top.edge_id, "NVDA:TSM:supplier:wafer:0");
    assert.equal(top.tier, "critical");
    assert.equal(top.category, "supplier");
    assert.deepEqual([top.a, top.b], ["NVDA", "TSM"]);
    assert.ok(top.evidence_quote.length > 0);
  });

  it("two equal, graph-known but unlinked names → network ≤ 10", () => {
    const n = networkComponent(weightsOf([["AAA", 0.5], ["BBB", 0.5]]), graph, config, []);
    assert.equal(n.linked_fraction, 0);
    assert.equal(n.pair_count, 1);
    assert.ok(n.score <= 10);
  });

  it("shared critical dependency (two pharmas on the same CDMO) → l_shared = 0.5 × min(tier weights)", () => {
    const link = pairLink(graph, "PFE", "MRK", config);
    assert.ok(link);
    assert.equal(link.via, "shared");
    assert.equal(link.link, 0.5);
    assert.equal(link.counterparty, "name:lonza");
    assert.equal(link.counterparty_label, "Lonza Group");
    assert.equal(link.edge_id, "PFE:name:lonza:supplier:x:0");
    assert.equal(link.edge_id_b, "MRK:name:lonza:supplier:x:0");
    const n = networkComponent(weightsOf([["PFE", 0.5], ["MRK", 0.5]]), graph, config, []);
    assert.equal(n.linked_fraction, 0.5);
    assert.equal(n.score, 90);
  });

  it("shared dependency uses the weaker tier and ignores edges below the minimum tier", () => {
    // NVDA critical on TSM, DDD important on TSM → 0.5 × min(1.0, 0.6) = 0.3
    const a = pairLink(graph, "NVDA", "DDD", config);
    assert.ok(a);
    assert.equal(a.via, "shared");
    assert.ok(Math.abs(a.link - 0.3) < 1e-9);
    assert.equal(a.tier, "important");
    // EEE is only marginal on TSM → below sharedMinTier → no link
    assert.equal(pairLink(graph, "NVDA", "EEE", config), null);
  });

  it("direct beats shared when stronger; reverse-direction edges count", () => {
    const link = pairLink(graph, "GGG", "HHH", config);
    assert.ok(link);
    assert.equal(link.via, "direct"); // 0.6 direct > 0.5 shared
    assert.equal(link.link, 0.6);
    // order of arguments does not matter; the edge's root is reported as `a`
    const reversed = pairLink(graph, "HHH", "GGG", config);
    assert.ok(reversed);
    assert.equal(reversed.edge_id, link.edge_id);
    assert.deepEqual([reversed.a, reversed.b], ["GGG", "HHH"]);
  });

  it("linked_fraction weights pairs by w_i·w_j and excludes unknown tickers", () => {
    const r = linkedFraction(weightsOf([["NVDA", 0.6], ["TSM", 0.2], ["AAA", 0.2]]), graph, config);
    // pairs: NVDA·TSM 0.12 (l=1), NVDA·AAA 0.12 (0), TSM·AAA 0.04 (0) → 0.12 / 0.28
    assert.ok(Math.abs(r.linked_fraction - 0.12 / 0.28) < 1e-9);
    assert.equal(r.pair_count, 3);
    const withUnknown = linkedFraction(weightsOf([["NVDA", 0.5], ["TSM", 0.3], ["CCC", 0.2]]), graph, config);
    assert.deepEqual(withUnknown.excluded, ["CCC"]);
    assert.equal(withUnknown.pair_count, 1);
    assert.equal(withUnknown.linked_fraction, 1);
  });

  it("fewer than two positions → 0", () => {
    assert.equal(linkedFraction(weightsOf([["NVDA", 1]]), graph, config).linked_fraction, 0);
    assert.equal(linkedFraction([], graph, config).linked_fraction, 0);
  });
});

describe("risk/network — real graph", () => {
  const path = realGraphPath();
  it("NVDA+TSM on the real graph: filing-backed supplier link, payload carries the edge id", { skip: !path }, () => {
    const real = loadGraphIndexSync(path!);
    const n = networkComponent(weightsOf([["NVDA", 0.5], ["TSM", 0.5]]), real, config, []);
    assert.ok(n.score >= 60, `score ${n.score}`);
    const top = n.top_links[0];
    // The trailing ordinal is the edge's position in the rebuilt graph — it
    // shifts whenever a root is added, so match the identity, not the index.
    assert.match(top.edge_id, /^NVDA:TSM:supplier:wafer_fabrication:\d+$/);
    assert.equal(top.category, "supplier");
    assert.ok(top.evidence_quote.length > 20);
  });

  it("the live paper book (NVDA CEG OPK ZLAB BNTX) shares no filing-backed links on the real graph", { skip: !path }, () => {
    const real = loadGraphIndexSync(path!);
    const n = networkComponent(weightsOf([["NVDA", 0.4], ["CEG", 0.2], ["OPK", 0.1], ["ZLAB", 0.15], ["BNTX", 0.15]]), real, config, []);
    assert.equal(n.excluded.length, 0);
    assert.equal(n.pair_count, 10);
    assert.ok(n.score <= 10, `score ${n.score}`);
  });
});
