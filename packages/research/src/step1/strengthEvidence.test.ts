import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fullEvidencePlan } from "./disclosedShareBackfill.js";
import {
  STRENGTH_CLASSIFY_BATCH_SYSTEM,
  STRENGTH_CLASSIFY_SYSTEM,
  strengthPromptFields,
} from "./strength.js";
import {
  MAX_STRENGTH_QUOTE_CHARS,
  dependenceSentences,
  filingSentences,
  statesDependenceOn,
  strengthInputForEdge,
  strengthQuotes,
} from "./strengthEvidence.js";
import type { ValidatedEdge } from "./types.js";

const NAMING =
  "We utilize foundries, such as Taiwan Semiconductor Manufacturing Company Limited, or TSMC, and Samsung Electronics Co., Ltd., or Samsung, to produce our semiconductor wafers.";
const DEPENDS = "We depend on foundries to manufacture our semiconductor wafers using their fabrication equipment and techniques.";

/** NVDA's shape: the naming sentence in Item 1, the dependence sentence far away in Item 1A. */
const FILING = [
  "Item 1. Business Our Company NVIDIA pioneered accelerated computing.",
  NAMING,
  "We purchase memory from SK Hynix Inc., Micron Technology, Inc., and Samsung.",
  "Filler about the U.S. market and products. ".repeat(200),
  "Item 1A. Risk Factors.",
  DEPENDS,
  "We rely on third parties, including suppliers, distributors, foundries, alliances and service providers, for many things.",
  "We rely on Intel foundries for packaging of some products.",
  "• limited number and geographic concentration of global suppliers, foundries, contract manufacturers, assembly and test providers and memory manufacturers;",
  "We compete with Intel, AMD and Broadcom, and we depend on foundries for capacity.",
].join(" ");

const NAMES = ["Taiwan Semiconductor Manufacturing Company Limited", "Samsung Electronics Co., Ltd.", "Intel", "Micron Technology, Inc."];

describe("filing sentences", () => {
  it("does not end a sentence at a legal form or an abbreviation, and splits at bullets", () => {
    const s = filingSentences(`${NAMING} Next sentence here. • a bullet item; another clause`).map((x) => x.text);
    assert.deepEqual(s, [NAMING, "Next sentence here.", "a bullet item;", "another clause"]);
    assert.equal(filingSentences("Sales in the U.S. grew. Then more.").length, 2);
  });
});

describe("category dependence sentences", () => {
  const input = (over: Partial<Parameters<typeof dependenceSentences>[1]> = {}) => ({
    counterparty_name: "Taiwan Semiconductor Manufacturing Company Limited",
    category: "supplier",
    quotes: [NAMING],
    otherNames: NAMES,
    ...over,
  });

  it("finds the far dependence sentence that names no foundry (NVDA to TSMC)", () => {
    assert.deepEqual(dependenceSentences(FILING, input()), [DEPENDS]);
  });

  it("is verbatim filing text", () => {
    for (const s of dependenceSentences(FILING, input())) assert.ok(FILING.includes(s));
  });

  it("leaves out a sentence naming another counterparty, boilerplate lists and multi-kind risk bullets", () => {
    const got = dependenceSentences(FILING, input());
    assert.ok(!got.some((s) => /Intel|third parties|limited number/.test(s)));
  });

  it("gives a competitor nothing, and quotes in no known category nothing", () => {
    assert.deepEqual(dependenceSentences(FILING, input({ category: "competitor" })), []);
    assert.deepEqual(dependenceSentences(FILING, input({ quotes: ["We work with TSMC on many projects of note."] })), []);
    assert.deepEqual(dependenceSentences("", input()), []);
  });

  it("needs the category word right after the dependence words", () => {
    assert.equal(statesDependenceOn("We depend on foundries to manufacture our wafers.", "foundry"), true);
    assert.equal(
      statesDependenceOn("We rely on many materials, including silicon, copper, gold, gallium, chemicals, gases and ceramic packages, while elsewhere we mention the foundry business of a peer.", "foundry"),
      false,
    );
  });
});

describe("strength quotes", () => {
  it("keeps quotes found in the filing, drops duplicates, keeps order", () => {
    assert.deepEqual(strengthQuotes([NAMING, "Not in the filing at all, made up.", NAMING, DEPENDS], FILING), [NAMING, DEPENDS]);
  });

  it("keeps every stored quote when there is no text to check against", () => {
    assert.deepEqual(strengthQuotes(["A quote one here.", "A quote two here."]), ["A quote one here.", "A quote two here."]);
  });

  it("caps the total length but always keeps the first quote", () => {
    const long = "x".repeat(MAX_STRENGTH_QUOTE_CHARS + 10);
    assert.deepEqual(strengthQuotes([long, "short quote"]), [long]);
    const half = "y".repeat(MAX_STRENGTH_QUOTE_CHARS / 2);
    const other = "w".repeat(MAX_STRENGTH_QUOTE_CHARS / 2 + 1);
    assert.deepEqual(strengthQuotes([half, other, "tail quote"]), [half, "tail quote"]);
  });

  it("reads a repeated or partly repeated sentence as one quote", () => {
    const full = "Under these licenses, such as our licenses from A, B, C and D, we may be required to pay fees.";
    const part = "Under these licenses, such as our licenses from A, B, C and D";
    assert.deepEqual(strengthQuotes([full, part, `${full.slice(0, -1)}`, "Another quote entirely."]), [full, "Another quote entirely."]);
    assert.deepEqual(strengthQuotes([part, full]), [full]);
  });
});

describe("classifier input for a stored edge", () => {
  const edge = {
    counterparty_name: "Taiwan Semiconductor Manufacturing Company Limited",
    category: "supplier",
    subtype: "wafer_fabrication",
    evidence: [{ quote: NAMING }],
  };

  it("carries the quotes and the category dependence of the filing", () => {
    const input = strengthInputForEdge(edge, FILING, NAMES);
    assert.deepEqual(input.evidence_quotes, [NAMING]);
    assert.deepEqual(input.category_dependence, [DEPENDS]);
    assert.equal(input.disclosed_revenue_dependency_pct, null);
    const fields = strengthPromptFields(input);
    assert.deepEqual(fields.evidence_quotes, [NAMING]);
    assert.deepEqual(fields.category_dependence, [DEPENDS]);
    assert.ok(!("evidence_quote" in fields));
  });

  it("with quotes not in the text (another filing), keeps the stored quotes and adds no dependence", () => {
    const input = strengthInputForEdge(edge, "We depend on foundries to manufacture our semiconductor wafers today.", NAMES);
    assert.deepEqual(input.evidence_quotes, [NAMING]);
    assert.equal(input.category_dependence, undefined);
  });

  it("an input with only the first quote still reads as a list of one", () => {
    const fields = strengthPromptFields({ ...edge, disclosed_revenue_dependency_pct: null, evidence_quote: NAMING });
    assert.deepEqual(fields.evidence_quotes, [NAMING]);
    assert.ok(!("category_dependence" in fields));
  });
});

describe("prompt", () => {
  it("states the category dependence rule and keeps lists of many peers marginal", () => {
    for (const prompt of [STRENGTH_CLASSIFY_SYSTEM, STRENGTH_CLASSIFY_BATCH_SYSTEM]) {
      assert.match(prompt, /category_dependence/);
      assert.match(prompt, /at most three examples/);
      assert.match(prompt, /sole, single-source or limited-number language/);
      assert.match(prompt, /many peers stays marginal/);
      assert.match(prompt, /all evidence_quotes together/);
      assert.match(prompt, /Conditional or prospective language \("if approved", "may", "could", "potential", "product candidates"/);
      assert.match(prompt, /never makes an edge critical/);
      assert.match(prompt, /country or region named as a supply origin .* is at most important, unless the filing says it is the sole or primary source/);
    }
  });
});

describe("full evidence plan (--full-evidence)", () => {
  const v = (over: Partial<ValidatedEdge>): ValidatedEdge => ({
    root_ticker: "NVDA",
    counterparty_name: "X",
    counterparty_ticker: null,
    counterparty_type: "public_company",
    category: "supplier",
    subtype: "",
    strength: 0.6,
    strength_tier: "important",
    strength_basis: "classified",
    disclosed_share_pct: null,
    disclosed_share_quote: null,
    epistemic_label: "VERIFIED",
    confidence: 0.9,
    evidence: [],
    valid_from: "2026-01-01",
    shared_evidence_group: "",
    ...over,
  });

  it("selects edges with a dependence sentence or several quotes, never a disclosed share", () => {
    const edges = [
      v({ counterparty_name: "Dep" }),
      v({ counterparty_name: "Multi" }),
      v({ counterparty_name: "One" }),
      v({ counterparty_name: "Disclosed", strength_basis: "disclosed", strength: 0.2, strength_tier: "critical" }),
      v({ counterparty_name: "Unrated", strength_basis: "unclassified" }),
    ];
    const inputs = [
      { evidence_quotes: ["a"], category_dependence: ["We depend on foundries."] },
      { evidence_quotes: ["a", "b"] },
      { evidence_quotes: ["a"] },
      { evidence_quotes: ["a", "b"] },
      { evidence_quotes: ["a", "b"] },
    ];
    assert.deepEqual(fullEvidencePlan(edges, inputs), { multiQuote: [1, 4], dependence: [0] });
  });
});
