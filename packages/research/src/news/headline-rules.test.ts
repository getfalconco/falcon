import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanHeadline, headlineIssues, ungroundedFigures, vetHeadline, HEADLINE_MAX_LENGTH } from "./headline-rules.js";

const SOURCE =
  "Micron's New Taiwan Plant Is Sold Out for 2027. Its Workers Want 15% of Profits\nMicron said output of the $9.5 billion plant is fully booked through 2027.";

describe("headline rules: what passes", () => {
  it("accepts a plain who-did-what line whose figures are in the article", () => {
    assert.deepEqual(headlineIssues("Micron books all 2027 output of its $9.5 billion Taiwan plant", SOURCE), []);
    assert.deepEqual(headlineIssues("Workers at Micron's Taiwan plant ask for 15% of profits", SOURCE), []);
  });

  it("lets small counts, years and quarter labels through the figure check", () => {
    assert.deepEqual(ungroundedFigures("Nvidia names 3 new directors in Q3 2026", "Nvidia board changes"), []);
  });

  it("matches a figure written in other units at the shown precision", () => {
    assert.deepEqual(ungroundedFigures("Apple reports $94.9 billion revenue", "Revenue was $94,930 million"), []);
  });
});

describe("headline rules: what is rejected", () => {
  const reject = (line: string, expected: RegExp) => {
    const issues = headlineIssues(line, SOURCE);
    assert.ok(issues.some((i) => expected.test(i)), `${line} -> ${issues.join(", ")}`);
  };

  it("rejects clickbait: questions, reader address, lists, recaps", () => {
    reject("Could Micron's sold out plant change everything for chips", /speculation/);
    reject("Is Micron's Taiwan plant the deal of the decade?", /question/);
    reject("Here's why Micron workers want a share of profits", /clickbait/);
    reject("What you need to know about Micron's Taiwan plant today", /clickbait/);
    reject("Micron plant news is great for your portfolio today", /addresses the reader/);
    reject("Top 5 stocks to watch after Micron books its Taiwan plant", /stocks to watch|listicle/);
  });

  it("rejects hype words", () => {
    reject("Micron stock soars as Taiwan plant books all 2027 output", /hype word "soar"/);
    reject("Massive demand books Micron's Taiwan plant through 2027", /hype word "massive"/);
  });

  it("rejects advice and forward-looking words", () => {
    reject("Analysts say buy Micron after Taiwan plant books 2027 output", /advice word "buy"/);
    reject("Micron will book all 2027 output of its Taiwan plant", /forward-looking word "will"/);
    reject("Micron shares likely to gain after the Taiwan plant books out", /forward-looking word "likely"/);
  });

  it("rejects dashes and exclamation marks that survive as typed", () => {
    assert.ok(headlineIssues("Micron books 2027 output — workers want 15%", SOURCE).includes("em dash"));
    assert.ok(headlineIssues("Micron books all 2027 output of its Taiwan plant!", SOURCE).includes("exclamation mark"));
  });

  it("rejects a figure the article does not contain", () => {
    reject("Micron books $12 billion of 2027 output at its Taiwan plant", /figure 12 is not in the article/);
    reject("Workers at Micron's Taiwan plant ask for 25% of profits", /figure 25/);
  });

  it("rejects lines that are too long, too short, or name the writer", () => {
    reject(`Micron ${"books all output ".repeat(8)}`.trim(), new RegExp(`longer than ${HEADLINE_MAX_LENGTH}`));
    reject("Micron news", /too short/);
    reject("Falcon summary of Micron's Taiwan plant bookings", /names the writer/);
  });

  it("rejects the brand words unless AI names a line of business", () => {
    reject("Micron stock edges up on Taiwan plant bookings", /banned word "edge"/);
    assert.deepEqual(headlineIssues("Micron's AI chips book all 2027 output of its Taiwan plant", SOURCE), []);
  });
});

describe("headline rules: cleaning", () => {
  it("makes dashes plain, drops emoji, exclamation marks, wrapping quotes and the full stop", () => {
    assert.equal(cleanHeadline("“Micron books 2026–2027 output — workers want more!” \u{1F680}."), "Micron books 2026 to 2027 output, workers want more");
  });

  it("swaps the safe synonyms and spells out AI that is not a line of business", () => {
    assert.equal(cleanHeadline("Morgan Stanley raises Micron price target to $300"), "Morgan Stanley raises Micron price estimate to $300");
    assert.equal(cleanHeadline("Nike expects revenue to fall"), "Nike anticipates revenue to fall");
    assert.equal(cleanHeadline("Meta and Apple discuss AI partnership"), "Meta and Apple discuss artificial intelligence partnership");
    assert.equal(cleanHeadline("Nvidia AI chip sales rise 20%"), "Nvidia AI chip sales rise 20%");
  });

  it("does not reword sells or buys: those go back to the model", () => {
    const vetted = vetHeadline("Micron sells out 2027 output of its Taiwan plant", SOURCE);
    assert.equal(vetted.ok, false);
    assert.ok(!vetted.ok && vetted.issues.some((i) => i.includes('"sell"')));
  });

  it("returns empty for non-strings", () => {
    assert.equal(cleanHeadline(undefined), "");
    assert.deepEqual(headlineIssues("", null), ["empty"]);
  });
});
