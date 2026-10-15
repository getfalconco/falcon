import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffConcentration, diffHeadings, headingSimilarity, MATCH_MIN, namedIn, newSentences, REWORD_BELOW, searchableText } from "./diff";
import type { RiskHeading } from "./parse";

const h = (text: string): RiskHeading => ({ text, group: null });

describe("headingSimilarity", () => {
  it("is 1 for the same words, whatever the year, quotes or case", () => {
    assert.equal(
      headingSimilarity("The market price of our stock in fiscal 2024 has been volatile.", "The market price of our stock in fiscal 2025 has been volatile."),
      1,
    );
    assert.equal(headingSimilarity("Our \u201cAI\u201d business", "our ai business"), 1);
  });

  it("a word added stays above the rewording threshold; a rewritten heading falls below it", () => {
    const small = headingSimilarity("Climate change may have an impact on our business.", "Climate change may have a long-term impact on our business.");
    assert.ok(small >= 0.75 && small < 0.9, String(small));
    const rewritten = headingSimilarity(
      "Climate change and extreme weather events could disrupt our operations and those of our suppliers and customers.",
      "Climate change may have a long-term impact on our business.",
    );
    assert.ok(rewritten < REWORD_BELOW, String(rewritten));
    assert.ok(headingSimilarity("We have never paid dividends.", "Our revenue depends on a few customers.") < MATCH_MIN);
  });
});

describe("diffHeadings", () => {
  const previous = [
    h("Our revenue depends on a small number of customers."),
    h("Our operating results fluctuate from quarter to quarter."),
    h("The market price of our common stock in fiscal 2024 has been volatile."),
    h("We have never paid dividends on our common stock."),
    h("Our acquisition of Initech may not close on the expected terms and conditions."),
  ];

  it("sorts headings into kept, new, removed and reworded", () => {
    const latest = [
      h("Our revenue depends on a small number of customers."),
      h("Our quarterly operating results fluctuate from quarter to quarter."),
      h("The market price of our common stock in fiscal 2025 has been volatile."),
      h("We have never paid cash dividends on our common stock and do not intend to pay dividends for the foreseeable time."),
      h("New tariffs on imported components have increased our costs."),
    ];
    const d = diffHeadings(latest, previous);
    assert.equal(d.kept, 3);
    assert.deepEqual(
      d.added.map((x) => x.text),
      ["New tariffs on imported components have increased our costs."],
    );
    assert.deepEqual(
      d.removed.map((x) => x.text),
      ["Our acquisition of Initech may not close on the expected terms and conditions."],
    );
    assert.equal(d.reworded.length, 1);
    assert.equal(d.reworded[0]!.before.text, "We have never paid dividends on our common stock.");
    assert.ok(d.reworded[0]!.similarity < REWORD_BELOW);
  });

  it("reports nothing when the filing repeats itself", () => {
    const d = diffHeadings(previous, previous);
    assert.deepEqual([d.kept, d.added.length, d.removed.length, d.reworded.length], [5, 0, 0, 0]);
  });

  it("pairs a reworded heading with its closest predecessor only once", () => {
    const d = diffHeadings([h("Our operating results fluctuate a lot from quarter to quarter and year to year.")], [h("Our operating results fluctuate from quarter to quarter."), h("Our operating results fluctuate.")]);
    assert.equal(d.reworded.length + d.kept, 1);
    assert.equal(d.removed.length, 1);
  });
});

describe("diffConcentration", () => {
  const fact = (label: string, pct: number) => ({ label, pct, basis: "revenue" as const, quote: `${label} ${pct}%` });

  it("finds shares that moved, appeared and went", () => {
    const changes = diffConcentration([fact("Globex Corporation", 24), fact("Hooli Inc.", 11), fact("Customer A", 30.4)], [fact("Globex Corp.", 18), fact("Customer A", 30), fact("Vandelay", 12)]);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.label]),
      [
        ["share", "Globex Corporation"],
        ["new", "Hooli Inc."],
        ["dropped", "Vandelay"],
      ],
    );
  });
});

describe("names and sentences", () => {
  it("finds a company name anywhere in a text, whole words only", () => {
    const text = searchableText("We sell to Globex Corporation and to Hooli, Inc. in Europe.");
    assert.ok(namedIn("Globex Corp.", text));
    assert.ok(namedIn("Hooli Inc.", text));
    assert.ok(!namedIn("Umbrella Materials", text));
    assert.ok(!namedIn("Glob", text));
  });

  it("keeps the latest sentences with no close match before", () => {
    assert.deepEqual(
      newSentences(
        ["We rely on a single source supplier for our image sensor dies.", "Umbrella Materials is our sole supplier of 200mm wafers."],
        ["We rely on a single source supplier for our image sensors dies."],
      ),
      ["Umbrella Materials is our sole supplier of 200mm wafers."],
    );
  });
});
