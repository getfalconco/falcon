import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repairArticleText, repairMojibake } from "./mojibake.js";

/** How the mangling happens upstream: UTF-8 bytes read back as Windows-1252 (Latin-1 for the gaps). */
function mangle(text: string): string {
  const cp1252: Record<number, string> = {
    0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
    0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘",
    0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜",
    0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
  };
  return [...Buffer.from(text, "utf8")].map((b) => cp1252[b] ?? String.fromCharCode(b)).join("");
}

describe("repairMojibake: repairs", () => {
  it("undoes Windows-1252 mojibake of curly quotes, dashes and ellipses", () => {
    assert.equal(repairMojibake("The weekâ€™s biggest movers"), "The week’s biggest movers");
    assert.equal(repairMojibake("â€œStrong quarter,â€\u009d CEO says"), "“Strong quarter,” CEO says");
    assert.equal(repairMojibake("Revenue rose â€“ again"), "Revenue rose – again");
    assert.equal(repairMojibake(mangle("Guidance cut — shares slide…")), "Guidance cut — shares slide…");
  });

  it("undoes Latin-1 mojibake, where the continuation bytes arrive as C1 controls", () => {
    assert.equal(repairMojibake("weekâ\u0080\u0099s"), "week’s");
    assert.equal(repairMojibake("CafÃ© chain"), "Café chain");
  });

  it("repairs accented letters, currency and symbols", () => {
    for (const original of ["Société Générale", "Zürich", "£2.4 billion", "Nestlé®", "€1.2bn deal", "Acme™", "Başkent"]) {
      assert.equal(repairMojibake(mangle(original)), original, original);
    }
  });

  it("repairs text that was mangled twice", () => {
    assert.equal(repairMojibake(mangle(mangle("It’s up"))), "It’s up");
  });

  it("repairs remnants whose last byte was lost upstream", () => {
    assert.equal(repairMojibake("weekâs top stories"), "week’s top stories");
    assert.equal(repairMojibake("We donât know, weâre told"), "We don’t know, we’re told");
    assert.equal(repairMojibake("â€quotedâ€ here"), "”quoted” here");
    assert.equal(repairMojibake("ï»¿Headline"), "Headline");
  });

  it("repairs a provider article's text fields and leaves the rest", () => {
    const article = { id: 1, headline: "Appleâ€™s week", summary: "CafÃ©", source: "SeekingAlpha", url: "https://x" };
    assert.deepEqual(repairArticleText(article), { ...article, headline: "Apple’s week", summary: "Café" });
    const clean = { id: 2, headline: "Fine", summary: "", source: "Reuters" };
    assert.equal(repairArticleText(clean), clean);
  });
});

describe("repairMojibake: leaves correct text alone", () => {
  it("keeps legitimate accented and non-Latin text", () => {
    for (const text of [
      "café",
      "Zürich Insurance",
      "Société Générale",
      "SÃO PAULO, AÇÃO",
      "CHÂTEAU",
      "pâte, âge, château, mât",
      "Åre, Ärger, München, François",
      "NESTLÉ’s «CAFÉ»",
      "The week’s “biggest” movers — €5bn",
      "中文标题, 한국어, 日本語",
      "Başkent, İstanbul",
      "",
    ]) {
      assert.equal(repairMojibake(text), text, text);
    }
  });

  it("returns non-strings unchanged", () => {
    assert.equal(repairMojibake(undefined as unknown as string), undefined);
  });
});
