/**
 * The graph's explicit disclosed share and the "U.S. government" fold, as the
 * Stock tab graph and the Exposure tab read them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldGovernmentCounterparty } from "@meridian/research/step1";
import { computeExposure, disclosedShare as exposureShare, type ExposureEdge } from "./exposure";
import { edgeShare, normalizeLinks, type RawGraphEdge } from "./stock-graph";

const URL = "https://www.sec.gov/Archives/edgar/data/1/000000000026000001/x.htm";

describe("disclosed share: consumers read the field, not the strength", () => {
  it("Stock tab: the field decides when present, the strength only on older graphs", () => {
    // A disclosed 30% stores strength 0.3, the marginal weight: only the field tells.
    assert.equal(edgeShare({ disclosed_share_pct: 30, strength: 0.3 }), 30);
    // A strength that is not a tier weight is not a share once the field says none.
    assert.equal(edgeShare({ disclosed_share_pct: null, strength: 0.298 }), null);
    // Older graph: no field, recovered from the strength.
    assert.equal(edgeShare({ strength: 0.298 }), 29.8);
    assert.equal(edgeShare({ strength: 0.6 }), null);

    const base: RawGraphEdge = {
      root_ticker: "LITE",
      counterparty_name: "Customer A",
      counterparty_id: "name:customer a",
      category: "customer",
      strength_tier: "critical",
      confidence: 0.9,
      evidence_quote: "Customer A 30 %",
      source_url: URL,
    };
    const { links } = normalizeLinks([{ ...base, strength: 0.3, disclosed_share_pct: 30 }]);
    assert.equal(links[0]!.share, 30);
  });

  it("Exposure: the field decides when present", () => {
    const e: ExposureEdge = { root_ticker: "LITE", strength: 0.3, strength_tier: "critical", disclosed_share_pct: 30 };
    assert.equal(exposureShare(e), 30);
    assert.equal(exposureShare({ ...e, strength: 0.298, disclosed_share_pct: null }), null);
    assert.equal(exposureShare({ root_ticker: "AMKR", strength: 0.298, strength_tier: "critical" }), 29.8);
  });
});

describe("U.S. government fold: consumers see one counterparty", () => {
  const gov = (root: string, name: string, id: string): ExposureEdge => ({
    root_ticker: root,
    counterparty_ticker: null,
    counterparty_id: id,
    counterparty_name: name,
    counterparty_type: "government",
    category: "customer",
    strength: 1,
    strength_tier: "critical",
    confidence: 0.95,
    evidence_quote: `${name} is our largest customer.`,
    source_url: URL,
    accession_number: "0000000000-26-000001",
    filing_date: "2026-02-01",
  });

  it("an old graph's LMT Department of Defense and NOC U.S. government meet once folded", () => {
    const old = [
      gov("LMT", "Department of Defense", "name:us department of defense"),
      gov("NOC", "U.S. government", "name:us government"),
    ];
    const holdings = [
      { ticker: "LMT", weight: 0.5, fund: false },
      { ticker: "NOC", weight: 0.5, fund: false },
    ];
    const before = computeExposure(old, { scope: "account", holdings });
    assert.equal(before.shared.length, 0);

    const folded = old.map(foldGovernmentCounterparty);
    assert.equal(folded[0]!.counterparty_id, "name:us government");
    const after = computeExposure(folded, { scope: "account", holdings });
    assert.equal(after.shared.length, 1);
    assert.equal(after.shared[0]!.key, "name:us government");
    assert.equal(after.shared[0]!.name, "U.S. government");
    assert.deepEqual(after.shared[0]!.via.map((v) => v.ticker).sort(), ["LMT", "NOC"]);
  });

  it("the Stock tab labels the shared node U.S. government", () => {
    const { names } = normalizeLinks([
      foldGovernmentCounterparty(gov("LMT", "Department of Defense", "name:us department of defense")) as RawGraphEdge,
    ]);
    assert.equal(names.get("name:us government"), "U.S. government");
  });
});
