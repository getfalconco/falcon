import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as research from "@meridian/research/news/headline-rules";
import {
  ADVICE_WORDS,
  MARKET_AI_NOUNS,
  RISK_SENTENCE_WORDS,
  bannedWordHits,
  brandWordHits,
  plainDashes,
} from "../../shared/copy-rules";
import { ungroundedNumbers, corpusNumbers } from "../agents/grounding";

/**
 * The engine checks Falcon's news headlines with a copy of the house rules
 * (packages/research/src/news/headline-rules.ts), because research cannot
 * import from this app. This holds the copy to the original: same word
 * lists, same matcher, same dash rule, same figure check.
 */

const SAMPLES = [
  "Nvidia buys a stake in CoreWeave",
  "Analysts recommend trimming positions before the stop",
  "Revenue will likely fall, the company may consider cuts",
  "Bought shares were sold at the target",
  "The address of the longer hedge fund ledger",
  "AI revenue rose while the AI partnership edges closer",
  "A.I. chips and aI assistants",
  "2025–2026 sales — a record",
  "Rates fell − 0.5%",
];

describe("news headline rules mirror the house copy rules", () => {
  it("uses the same word lists", () => {
    assert.deepEqual([...research.ADVICE_WORDS], [...ADVICE_WORDS]);
    assert.deepEqual([...research.RISK_SENTENCE_WORDS], [...RISK_SENTENCE_WORDS]);
    assert.deepEqual([...research.MARKET_AI_NOUNS], [...MARKET_AI_NOUNS]);
  });

  it("matches words, brand words and dashes the same way", () => {
    for (const text of SAMPLES) {
      assert.deepEqual(research.bannedWordHits(text, research.ADVICE_WORDS), bannedWordHits(text, ADVICE_WORDS), text);
      assert.deepEqual(research.bannedWordHits(text, research.RISK_SENTENCE_WORDS), bannedWordHits(text, RISK_SENTENCE_WORDS), text);
      assert.deepEqual(research.brandWordHits(text), brandWordHits(text), text);
      assert.equal(research.plainDashes(text), plainDashes(text), text);
    }
  });

  it("grounds figures the way the agents engine does", () => {
    const source = "Revenue was $30,040 million, up 112% from $14.2 billion; margin 75.1 percent.";
    for (const line of [
      "Revenue reaches $30.0 billion, up 112%",
      "Margin is 75.1% on $14.2 billion",
      "Revenue reaches $31 billion",
      "Up 113% in Q3 2026",
    ]) {
      assert.deepEqual(research.ungroundedFigures(line, source), ungroundedNumbers(line, corpusNumbers(source)), line);
    }
  });
});
