import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { THESIS_MAX_CHARS, readStoredThesis, thesisText, thesisTicker } from "./stock-thesis";

describe("stock thesis checks", () => {
  it("takes a ticker in upper case and nothing that is not one", () => {
    assert.equal(thesisTicker(" brk.b "), "BRK.B");
    assert.equal(thesisTicker("RDS-A"), "RDS-A");
    for (const bad of ["", "../x", "a b", "TOOLONGTICKER1", 7, null]) assert.equal(thesisTicker(bad), null, String(bad));
  });

  it("keeps the words, plain line endings and no trailing space", () => {
    assert.equal(thesisText("Line one\r\nLine two  \n\n"), "Line one\nLine two");
    assert.equal(thesisText("\n\nStarts here"), "Starts here");
    assert.equal(thesisText("   "), "");
    assert.equal(thesisText("x".repeat(THESIS_MAX_CHARS)), "x".repeat(THESIS_MAX_CHARS));
    assert.equal(thesisText("x".repeat(THESIS_MAX_CHARS + 1)), null);
    assert.equal(thesisText(5), null);
  });

  it("reads a stored row back, or drops it", () => {
    assert.deepEqual(readStoredThesis("nvda", { text: "Why", updated_at: "2026-10-01T00:00:00.000Z" }), {
      ticker: "NVDA",
      text: "Why",
      updated_at: "2026-10-01T00:00:00.000Z",
    });
    assert.equal(readStoredThesis("NVDA", { text: "" }), null);
    assert.equal(readStoredThesis("NVDA", null), null);
    assert.equal(readStoredThesis("NVDA", { text: "Why" })?.updated_at, new Date(0).toISOString());
  });
});
