import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEvidenceExcerpt, ELISION, mergeSpans, WINDOW_RADIUS } from "./evidenceWindow.js";

const FILLER = "The company continued its operations throughout the period under review. ";

function chunkWith(quotes: string[], gap = 4000): string {
  let out = FILLER.repeat(Math.ceil(gap / FILLER.length));
  for (const q of quotes) {
    out += q + " " + FILLER.repeat(Math.ceil(gap / FILLER.length));
  }
  return out;
}

describe("mergeSpans", () => {
  it("merges overlapping spans", () => {
    assert.deepEqual(mergeSpans([{ start: 0, end: 100 }, { start: 50, end: 180 }]), [
      { start: 0, end: 180 },
    ]);
  });

  it("joins near-touching spans rather than eliding less than it costs", () => {
    assert.deepEqual(mergeSpans([{ start: 0, end: 100 }, { start: 150, end: 200 }]), [
      { start: 0, end: 200 },
    ]);
  });

  it("keeps genuinely distant spans apart", () => {
    const out = mergeSpans([{ start: 0, end: 100 }, { start: 9000, end: 9100 }]);
    assert.equal(out.length, 2);
  });

  it("is empty on empty", () => {
    assert.deepEqual(mergeSpans([]), []);
  });
});

describe("buildEvidenceExcerpt", () => {
  it("trims a big chunk down to the passages around each quote", () => {
    const quotes = ["We purchase wafers from Acme Foundry.", "Our principal competitor is Beta Corp."];
    const chunk = chunkWith(quotes, 6000);
    const r = buildEvidenceExcerpt(chunk, quotes);
    assert.equal(r.trimmed, true);
    assert.ok(r.excerptChars < r.originalChars);
    for (const q of quotes) assert.ok(r.excerpt.includes(q), `lost quote: ${q}`);
  });

  it("keeps context either side of the quote, not just the quote", () => {
    const quote = "We purchase wafers from Acme Foundry.";
    const chunk = chunkWith([quote], 6000);
    const r = buildEvidenceExcerpt(chunk, [quote]);
    // Context is the whole point: the auditor judges the quote *in context*.
    assert.ok(r.excerptChars > quote.length + WINDOW_RADIUS);
  });

  it("marks omitted text so two passages never read as continuous prose", () => {
    const quotes = ["Alpha supplies our controllers.", "Gamma competes with us in optics."];
    const chunk = chunkWith(quotes, 8000);
    const r = buildEvidenceExcerpt(chunk, quotes);
    assert.ok(r.excerpt.includes(ELISION.trim()));
  });

  it("collapses clustered quotes into one passage", () => {
    // Candidates usually arrive from one competitor list; their windows should
    // merge rather than emit the same text twice with a marker between.
    const quotes = ["Our competitors include Alpha", "Beta", "and Gamma."];
    const chunk = `${FILLER.repeat(80)}Our competitors include Alpha, Beta, and Gamma.${FILLER.repeat(80)}`;
    const r = buildEvidenceExcerpt(chunk, quotes);
    assert.equal(r.excerpt.split(ELISION.trim()).length, 1);
  });

  it("sends the FULL chunk when a quote cannot be located", () => {
    // The case where the auditor most needs everything — never trim here.
    const real = "We purchase wafers from Acme Foundry.";
    const chunk = chunkWith([real], 6000);
    const r = buildEvidenceExcerpt(chunk, [real, "a paraphrase that is not in the text"]);
    assert.equal(r.trimmed, false);
    assert.equal(r.excerpt, chunk);
    assert.equal(r.missing.length, 1);
  });

  it("does not trim when trimming would not save anything", () => {
    const quote = "Alpha supplies our controllers.";
    const chunk = `short lead. ${quote} short tail.`;
    const r = buildEvidenceExcerpt(chunk, [quote]);
    assert.equal(r.trimmed, false);
    assert.equal(r.excerpt, chunk);
  });

  it("passes an empty chunk or no quotes straight through", () => {
    assert.equal(buildEvidenceExcerpt("", ["x"]).excerpt, "");
    assert.equal(buildEvidenceExcerpt("body", []).excerpt, "body");
  });

  it("never cuts a word in half at a window boundary", () => {
    const quote = "Delta manufactures our enclosures.";
    const chunk = chunkWith([quote], 6000);
    const r = buildEvidenceExcerpt(chunk, [quote]);
    assert.equal(r.trimmed, true);

    // The excerpt is trimmed, so locate it in the chunk and check that the
    // characters immediately outside it are whitespace — that is what
    // "did not cut a word" actually means.
    const at = chunk.indexOf(r.excerpt);
    assert.ok(at >= 0, "excerpt should be a verbatim slice of the chunk");
    if (at > 0) assert.match(chunk[at - 1]!, /\s/);
    const after = at + r.excerpt.length;
    if (after < chunk.length) assert.match(chunk[after]!, /\s/);
  });
});
