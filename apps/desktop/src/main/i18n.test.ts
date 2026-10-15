import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EM_DASH, EN_DASH } from "../shared/copy-rules";
import { LANGUAGES } from "../renderer/lib/i18n/languages";
import {
  MAIN_LANGUAGES,
  MAIN_MESSAGES,
  getMainLanguage,
  mt,
  mtCount,
  resolveMainLanguage,
  setMainLanguage,
  setMainLanguageFallback,
  type MainMessageKey,
} from "./i18n";

/**
 * The main process's own tables (notifications, dialogs): the same languages
 * as the renderer, every key in each, English's placeholders, and the house
 * typography (no dashes, no exclamation marks, no full-width dashes).
 */

/** Em and en dash, and the CJK full-width dashes (horizontal bar, two- and three-em dash, full-width hyphen-minus). */
const DASHES = [EM_DASH, EN_DASH, ...[0x2015, 0x2e3a, 0x2e3b, 0xff0d].map((c) => String.fromCharCode(c))];
/** The exclamation mark and its full-width form. */
const BANGS = ["!", String.fromCharCode(0xff01)];

const placeholders =(text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("main i18n tables", () => {
  it("cover exactly the renderer's languages", () => {
    assert.deepEqual([...MAIN_LANGUAGES].sort(), LANGUAGES.map((l) => l.code).sort());
    assert.deepEqual(Object.keys(MAIN_MESSAGES).sort(), [...MAIN_LANGUAGES].sort());
  });

  const keys = Object.keys(MAIN_MESSAGES["en-US"]) as MainMessageKey[];
  for (const code of MAIN_LANGUAGES) {
    it(`${code} has every key, English's placeholders and no dashes`, () => {
      const table = MAIN_MESSAGES[code];
      assert.deepEqual(Object.keys(table).sort(), [...keys].sort());
      for (const key of keys) {
        const text = table[key];
        assert.ok(text.trim(), `${code} ${key} is empty`);
        assert.deepEqual(placeholders(text), placeholders(MAIN_MESSAGES["en-US"][key]), `${code} ${key} placeholders`);
        assert.ok(!DASHES.some((d) => text.includes(d)), `${code} ${key} has a dash`);
        assert.ok(!BANGS.some((b) => text.includes(b)), `${code} ${key} has an exclamation mark`);
      }
    });
  }
});

describe("main language", () => {
  it("resolves machine tags the way the renderer does", () => {
    assert.equal(resolveMainLanguage(["de-AT"]), "de-DE");
    assert.equal(resolveMainLanguage(["zh-TW", "ja"]), "ja-JP");
    assert.equal(resolveMainLanguage(["nl-NL"]), null);
  });

  it("follows the fallback until a choice arrives, and ignores what it does not have", () => {
    setMainLanguageFallback(() => "fr-FR");
    assert.equal(getMainLanguage(), "fr-FR");
    assert.equal(setMainLanguage("xx-XX"), false);
    assert.equal(setMainLanguage("tr-TR"), true);
    assert.equal(getMainLanguage(), "tr-TR");
    setMainLanguage("en-US");
  });

  it("fills placeholders and picks the plural form by language", () => {
    assert.equal(mt("notify.update.readyBody", { version: "0.3.0" }, "en-US"), "Version 0.3.0 is downloaded. Restart Falcon to install it.");
    assert.equal(mtCount("notify.signals.openOne", "notify.signals.openOther", 1, {}, "en-US"), "1 open name");
    assert.equal(mtCount("notify.signals.openOne", "notify.signals.openOther", 3, {}, "de-DE"), "3 offene Namen");
    assert.equal(mt("notify.signals.title", { ticker: "NVDA" }, "ja-JP"), "二次シグナル：NVDA");
  });
});
