import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNTRANSLATED, upperEnglish, upperIn } from "./casing";

describe("upperIn", () => {
  it("cases Turkish the Turkish way", () => {
    assert.equal(upperIn("etkinlik türleri", "tr-TR"), "ETKİNLİK TÜRLERİ");
    assert.equal(upperIn("ılık", "tr"), "ILIK");
  });

  it("cases every other language by its own rule", () => {
    assert.equal(upperIn("event types", "en-US"), "EVENT TYPES");
    assert.equal(upperIn("straße", "de-DE"), "STRASSE");
    assert.equal(upperIn("évènements", "fr-FR"), "ÉVÈNEMENTS");
    assert.equal(upperIn("予定", "ja-JP"), "予定");
  });

  it("falls back to the root rule for a tag the runtime refuses", () => {
    assert.equal(upperIn("list", "not a tag!"), "LIST");
  });
});

describe("upperEnglish", () => {
  it("never uses the Turkish dotted capital, whatever the app's language", () => {
    assert.equal(upperEnglish("windows"), "WINDOWS");
    assert.equal(upperEnglish("brk.b"), "BRK.B");
    assert.equal(upperEnglish("grounding_failed"), "GROUNDING_FAILED");
  });
});

describe("UNTRANSLATED", () => {
  it("marks content as English for CSS casing", () => {
    assert.deepEqual(UNTRANSLATED, { lang: "en" });
  });
});
