import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildGraphFromResearchDir } from "./buildGraph.js";
import { canonicalCounterparty, foldGovernmentCounterparty, usGovernmentBody } from "./canonical.js";
import type { ValidatedEdge } from "./types.js";

describe("US government fold: usGovernmentBody", () => {
  it("folds the government, its departments, branches and defense agencies", () => {
    assert.deepEqual(usGovernmentBody("U.S. government", "government"), { detail: null });
    assert.deepEqual(usGovernmentBody("United States Government"), { detail: null });
    assert.deepEqual(usGovernmentBody("Department of Defense", "government"), { detail: "U.S. Department of Defense" });
    assert.deepEqual(usGovernmentBody("U.S. Department of Defense"), { detail: "U.S. Department of Defense" });
    assert.deepEqual(usGovernmentBody("Department of War"), { detail: "U.S. Department of War" });
    assert.deepEqual(usGovernmentBody("U.S. Navy"), { detail: "U.S. Navy" });
    assert.deepEqual(usGovernmentBody("U.S. Army"), { detail: "U.S. Army" });
    assert.deepEqual(usGovernmentBody("U.S. Air Force"), { detail: "U.S. Air Force" });
    assert.deepEqual(usGovernmentBody("Missile Defense Agency"), { detail: "Missile Defense Agency" });
    assert.deepEqual(usGovernmentBody("National Geospatial-Intelligence Agency"), {
      detail: "National Geospatial-Intelligence Agency",
    });
    assert.deepEqual(usGovernmentBody("Centers for Medicare & Medicaid Services"), {
      detail: "Centers for Medicare & Medicaid Services",
    });
    assert.deepEqual(usGovernmentBody("Centers for Medicare and Medicaid Services"), {
      detail: "Centers for Medicare & Medicaid Services",
    });
    assert.deepEqual(usGovernmentBody("NASA", "government"), { detail: "NASA" });
  });

  it("folds acronyms only when the counterparty is typed as a government", () => {
    assert.deepEqual(usGovernmentBody("DoD", "government"), { detail: "U.S. Department of Defense" });
    assert.deepEqual(usGovernmentBody("CMS", "government"), { detail: "Centers for Medicare & Medicaid Services" });
    assert.equal(usGovernmentBody("CMS", "public_company"), null);
    assert.equal(usGovernmentBody("DOW", "public_company"), null);
    assert.equal(usGovernmentBody("Dow"), null);
  });

  it("leaves other governments, states, regulators, programs and look-alike companies alone", () => {
    for (const name of [
      "German government",
      "Venezuelan government",
      "Indian central government",
      "Canadian army",
      "Royal Australian Air Force",
      "State of New York",
      "FDA",
      "Federal Aviation Administration",
      "Federal Reserve System",
      "Federal Deposit Insurance Corporation",
      "Medicare",
      "Medicaid",
      "Department of Energy",
      "Federal government",
      "DoW Inspector General",
      "U.S. Silica Inc.",
      "U.S. Bank Trust Company, National Association",
      "Taiwan",
    ]) {
      assert.equal(usGovernmentBody(name, "government"), null, name);
    }
  });

  it("canonicalCounterparty gives one id for every federal body, with the body as detail", () => {
    assert.deepEqual(
      canonicalCounterparty({ counterparty_name: "Department of Defense", counterparty_ticker: null, counterparty_type: "government" }),
      { id: "name:us government", ticker: null, detail: "U.S. Department of Defense" },
    );
    assert.deepEqual(canonicalCounterparty({ counterparty_name: "U.S. government", counterparty_ticker: null }), {
      id: "name:us government",
      ticker: null,
      detail: null,
    });
    // A ticker always wins.
    assert.deepEqual(canonicalCounterparty({ counterparty_name: "U.S. Navy", counterparty_ticker: "XYZ" }), {
      id: "XYZ",
      ticker: "XYZ",
      detail: null,
    });
  });

  it("foldGovernmentCounterparty brings an old graph edge up to the fold, and nothing else", () => {
    const old = { counterparty_id: "name:us department of defense", counterparty_ticker: null, counterparty_name: "Department of Defense", counterparty_type: "government" };
    assert.deepEqual(foldGovernmentCounterparty(old), {
      ...old,
      counterparty_id: "name:us government",
      counterparty_detail: "U.S. Department of Defense",
    });
    const company = { counterparty_id: "name:samsung electronics", counterparty_ticker: null, counterparty_name: "Samsung" };
    assert.equal(foldGovernmentCounterparty(company), company);
    const stamped = { counterparty_id: "name:us navy", counterparty_name: "U.S. Navy", counterparty_detail: null };
    assert.equal(foldGovernmentCounterparty(stamped), stamped);
  });
});

describe("US government fold: buildGraphFromResearchDir", () => {
  const mkEdge = (root: string, name: string, ticker: string | null, type: string, quote: string): ValidatedEdge => ({
    root_ticker: root,
    counterparty_name: name,
    counterparty_ticker: ticker,
    counterparty_type: type,
    category: "customer",
    subtype: "",
    strength: 1,
    strength_tier: "critical",
    strength_basis: "classified",
    epistemic_label: "VERIFIED",
    confidence: 0.95,
    evidence: [{ quote, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    valid_from: "2026-02-01",
    shared_evidence_group: "",
  });

  it("puts LMT's Department of Defense and NOC's U.S. government on one node, keeping the agency", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-gov-fold-"));
    try {
      await writeFile(
        path.join(dir, "LMT.json"),
        JSON.stringify([
          mkEdge("LMT", "Department of Defense", null, "government", "63% from the Department of Defense"),
          mkEdge("LMT", "NASA", null, "government", "NASA is a customer"),
        ]),
      );
      await writeFile(
        path.join(dir, "NOC.json"),
        JSON.stringify([
          mkEdge("NOC", "U.S. government", null, "government", "Our primary customer is the U.S. government"),
          mkEdge("NOC", "U.S. Navy", null, "government", "programs for the U.S. Navy"),
          mkEdge("NOC", "Australia", null, "government", "sales to Australia"),
        ]),
      );
      await writeFile(
        path.join(dir, "AMD.json"),
        JSON.stringify([
          mkEdge("AMD", "Taiwan Semiconductor Manufacturing Company Limited", "TSM", "public_company", "TSMC makes our wafers"),
          mkEdge("AMD", "HP Inc.", null, "public_company", "HP Inc. buys our chips"),
          mkEdge("AMD", "Hewlett Packard Enterprise", null, "public_company", "HPE buys our chips"),
        ]),
      );
      await writeFile(path.join(dir, "INTC.json"), JSON.stringify([mkEdge("INTC", "TSMC", null, "public_company", "We compete with TSMC")]));

      const graph = await buildGraphFromResearchDir(dir);
      const gov = graph.edges.filter((e) => e.counterparty_id === "name:us government");
      assert.deepEqual(
        gov.map((e) => [e.root_ticker, e.counterparty_name, e.counterparty_detail]).sort(),
        [
          ["LMT", "Department of Defense", "U.S. Department of Defense"],
          ["LMT", "NASA", "NASA"],
          ["NOC", "U.S. Navy", "U.S. Navy"],
          ["NOC", "U.S. government", null],
        ],
      );
      assert.equal(graph.nodes.find((n) => n.id === "name:us government")?.label, "U.S. government");
      assert.equal(graph.reverseIndex["name:us government"]!.length, 4);
      // A foreign government stays its own node.
      assert.equal(graph.edges.find((e) => e.counterparty_name === "Australia")!.counterparty_id, "name:australia");
      assert.equal(graph.edges.find((e) => e.counterparty_name === "Australia")!.counterparty_detail, null);

      // Company aliases: both TSMC spellings on TSM; HP Inc. and HPE stay apart.
      assert.deepEqual(
        graph.edges.filter((e) => /taiwan|tsmc/i.test(e.counterparty_name)).map((e) => e.counterparty_id),
        ["TSM", "TSM"],
      );
      const hp = graph.edges.find((e) => e.counterparty_name === "HP Inc.")!.counterparty_id;
      const hpe = graph.edges.find((e) => e.counterparty_name === "Hewlett Packard Enterprise")!.counterparty_id;
      assert.notEqual(hp, hpe);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
