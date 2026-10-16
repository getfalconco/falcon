import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeSameCounterpartyEdges, sameCounterpartyGroups } from "./sameCounterparty.js";
import type { ValidatedEdge } from "./types.js";

function edge(over: Partial<ValidatedEdge> & Pick<ValidatedEdge, "counterparty_name">): ValidatedEdge {
  return {
    root_ticker: "ADI",
    counterparty_ticker: null,
    counterparty_type: "public_company",
    category: "supplier",
    subtype: "wafer fabrication foundry",
    strength: 0.6,
    strength_tier: "important",
    strength_basis: "classified",
    disclosed_share_pct: null,
    disclosed_share_quote: null,
    epistemic_label: "VERIFIED",
    confidence: 0.9,
    evidence: [{ quote: `We buy wafers from ${over.counterparty_name} today.`, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    valid_from: "2025-11-25",
    shared_evidence_group: "",
    ...over,
  };
}

const Q1 = "We currently source more than half of our wafer requirements annually from third-party wafer fabrication foundries, such as Taiwan Semiconductor Manufacturing Company (TSMC) and others";
const Q2 = "We currently source more than half of our wafer requirements annually from third-party wafer foundries, including Taiwan Semiconductor Manufacturing Company (TSMC) and others.";
const ev = (quote: string): ValidatedEdge["evidence"][number] => ({ quote, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" });

describe("same-counterparty edges of one filer", () => {
  it("folds ADI's two spellings of TSMC into one edge with all quotes and the full legal name", () => {
    const edges = [
      edge({ counterparty_name: "Taiwan Semiconductor Manufacturing Company", counterparty_ticker: "TSM", evidence: [ev(Q1), ev(Q2)] }),
      edge({ counterparty_name: "Analog Partner", subtype: "distributor", category: "customer" }),
      edge({ counterparty_name: "TSMC", counterparty_ticker: "TSM", strength: 1, strength_tier: "critical", evidence: [ev(Q1)], confidence: 0.95 }),
    ];
    const { edges: out, merges } = mergeSameCounterpartyEdges(edges);
    assert.equal(out.length, 2);
    assert.equal(merges.length, 1);
    const m = out[0]!;
    assert.equal(m.counterparty_name, "Taiwan Semiconductor Manufacturing Company");
    assert.equal(m.counterparty_ticker, "TSM");
    assert.deepEqual(m.evidence.map((e) => e.quote), [Q1, Q2]);
    assert.equal(m.strength_tier, "critical", "the leading member's tier until it is judged again");
    assert.equal(m.confidence, 0.95);
    assert.equal(m.subtype, "wafer fabrication foundry");
    assert.match(m.shared_evidence_group, /^ev_[0-9a-f]{12}$/);
    assert.equal(out[1], edges[1], "other edges are returned as they were");
  });

  it("joins names by alias without a ticker, and keeps categories apart", () => {
    const edges = [
      edge({ counterparty_name: "Samsung Electronics Co., Ltd.", subtype: "wafer_fabrication" }),
      edge({ counterparty_name: "Samsung", subtype: "memory" }),
      edge({ counterparty_name: "Samsung", category: "competitor", subtype: "SoC" }),
    ];
    assert.deepEqual(sameCounterpartyGroups(edges), [[0, 1]]);
    assert.equal(mergeSameCounterpartyEdges(edges).edges[0]!.subtype, "wafer_fabrication; memory");
  });

  it("joins one ticker under two names, and treats joint venture and joint_venture as one subtype", () => {
    const edges = [
      edge({ root_ticker: "SHEL", counterparty_name: "Chevron", counterparty_ticker: "CVX", category: "partner", subtype: "joint venture" }),
      edge({ root_ticker: "SHEL", counterparty_name: "Chevron U.S.A. Inc.", counterparty_ticker: "CVX", category: "partner", subtype: "joint_venture" }),
    ];
    const { edges: out } = mergeSameCounterpartyEdges(edges);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.subtype, "joint venture");
  });

  it("leaves a group alone when its members resolved to different tickers", () => {
    const edges = [
      edge({ counterparty_name: "Acme", counterparty_ticker: "ACME" }),
      edge({ counterparty_name: "Acme Inc.", counterparty_ticker: "ACMI" }),
    ];
    assert.deepEqual(sameCounterpartyGroups(edges), []);
  });

  it("never identifies a counterparty by the filer's own ticker", () => {
    const edges = [
      edge({ counterparty_name: "Alpha Unit", counterparty_ticker: "ADI" }),
      edge({ counterparty_name: "Beta Unit", counterparty_ticker: "ADI" }),
    ];
    assert.deepEqual(sameCounterpartyGroups(edges), []);
  });

  it("lets a member with a stated share lead the merged edge", () => {
    const shareQuote = "Acme accounted for 12% of our revenue in fiscal 2025.";
    const edges = [
      edge({ counterparty_name: "Acme Corporation", category: "customer", strength: 1, strength_tier: "critical" }),
      edge({
        counterparty_name: "Acme",
        category: "customer",
        strength: 0.12,
        strength_tier: "critical",
        strength_basis: "disclosed",
        disclosed_share_pct: 12,
        disclosed_share_quote: shareQuote,
        evidence: [ev(shareQuote)],
      }),
    ];
    const m = mergeSameCounterpartyEdges(edges).edges[0]!;
    assert.equal(m.disclosed_share_pct, 12);
    assert.equal(m.evidence[0]!.quote, shareQuote);
    assert.equal(m.counterparty_name, "Acme Corporation");
  });
});
