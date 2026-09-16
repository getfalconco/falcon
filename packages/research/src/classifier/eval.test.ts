/**
 * §15.5 — eval harness against the gate thresholds.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeClassifierConfig } from "./config.js";
import { evaluateClassifier, formatEvalReport, type LabeledArticle } from "./eval.js";
import { assembleVerdict } from "./schema.js";
import { AT, AVGO, META, NVDA, newsRequest } from "./test-fixtures.js";
import type { ModelOutput, Verdict } from "./types.js";

const ENVELOPE = { prompt_version: "cls-1.0", model: "m", classified_at: AT };

function verdictOf(req: LabeledArticle["request"], output: ModelOutput): Verdict {
  return assembleVerdict(req, output, ENVELOPE);
}

describe("eval harness", () => {
  const a = newsRequest("a", "Broadcom…", [AVGO, NVDA]);
  const b = newsRequest("b", "listicle", [NVDA, META]);
  const c = newsRequest("c", "Meta trial", [META]);
  const labeled: LabeledArticle[] = [
    {
      request: a,
      expected: {
        event_type: "contract_partnership",
        tickers: [
          { ticker: "AVGO", relevance: "direct", materiality: "standard", direction: "positive" },
          { ticker: "NVDA", relevance: "direct", materiality: "standard", direction: "negative" },
        ],
      },
    },
    {
      request: b,
      expected: { event_type: "macro_sector", tickers: [{ ticker: "NVDA", relevance: "none" }, { ticker: "META", relevance: "none" }] },
    },
    {
      request: c,
      expected: { event_type: "legal", tickers: [{ ticker: "META", relevance: "direct", materiality: "high", direction: "negative" }] },
    },
  ];
  const verdicts: Record<string, Verdict> = {
    "id:a": verdictOf(a, {
      event_type: "contract_partnership",
      event_label: "",
      tickers: [
        { ticker: "AVGO", relevance: "direct", materiality: "high", direction: "positive" }, // within one tier
        { ticker: "NVDA", relevance: "direct", materiality: "standard", direction: "mixed" }, // direction miss
      ],
    }),
    "id:b": verdictOf(b, {
      event_type: "ownership_flows", // event_type miss
      event_label: "",
      tickers: [
        { ticker: "NVDA", relevance: "none" },
        { ticker: "META", relevance: "indirect", materiality: "low", direction: "unclear" }, // relevance miss
      ],
    }),
    "id:c": verdictOf(c, {
      event_type: "legal",
      event_label: "",
      tickers: [{ ticker: "META", relevance: "direct", materiality: "low", direction: "negative" }], // two tiers off
    }),
  };

  it("scores every gate metric and reports misses", async () => {
    const config = mergeClassifierConfig({ eval: { minLabeledArticles: 3 } as never });
    const report = await evaluateClassifier(labeled, (req) => verdicts[req.article!.article_key] ?? null, config);
    assert.equal(report.evaluated_articles, 3);
    assert.equal(report.missing_verdicts, 0);
    const by = Object.fromEntries(report.metrics.map((m) => [m.name, m]));
    assert.equal(by.relevanceAccuracy.correct, 4);
    assert.equal(by.relevanceAccuracy.total, 5);
    assert.equal(by.eventTypeAccuracy.correct, 2);
    assert.equal(by.eventTypeAccuracy.total, 3);
    // materiality scored where both sides assessed: AVGO (ok), NVDA (ok), META-c (two off)
    assert.equal(by.materialityWithinOneTier.correct, 2);
    assert.equal(by.materialityWithinOneTier.total, 3);
    // direction on expected-direct subset: AVGO ok, NVDA miss, META-c ok
    assert.equal(by.directionAccuracyDirect.correct, 2);
    assert.equal(by.directionAccuracyDirect.total, 3);
    assert.equal(report.pass, false);
    assert.equal(report.size_ok, true);
    assert.equal(report.event_type_confusion.macro_sector.ownership_flows, 1);
    assert.ok(report.misses.some((m) => m.field === "direction" && m.ticker === "NVDA"));
    const text = formatEvalReport(report);
    assert.ok(text.includes("Gate: FAIL"));
  });

  it("passes when every metric clears its threshold and the set is large enough", async () => {
    const config = mergeClassifierConfig({ eval: { minLabeledArticles: 1 } as never });
    const perfect: Record<string, Verdict> = {
      "id:a": verdictOf(a, {
        event_type: "contract_partnership",
        event_label: "",
        tickers: [
          { ticker: "AVGO", relevance: "direct", materiality: "standard", direction: "positive" },
          { ticker: "NVDA", relevance: "direct", materiality: "standard", direction: "negative" },
        ],
      }),
    };
    const report = await evaluateClassifier([labeled[0]], (req) => perfect[req.article!.article_key], config);
    assert.equal(report.pass, true);
  });

  it("missing or failed verdicts are counted, not scored; a small set fails the size check", async () => {
    const config = mergeClassifierConfig(null); // minLabeledArticles 100
    const report = await evaluateClassifier(labeled, () => null, config);
    assert.equal(report.missing_verdicts, 3);
    assert.equal(report.evaluated_articles, 0);
    assert.equal(report.size_ok, false);
    assert.equal(report.pass, false);
    assert.equal(report.metrics[0].accuracy, null);
  });
});
