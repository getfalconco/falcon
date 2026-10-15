import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EM_DASH, EN_DASH } from "../../../shared/copy-rules";
import { LANGUAGES, foldForSearch, matchesLanguage, resolveLanguage, languageInfo } from "./languages";
import { MESSAGES, en, type MessageKey } from "./messages";
import { interpolate, interpolateParts, messageFor, translate } from "./translate";

/**
 * The i18n layer's rules: which language a machine gets, how a missing
 * translation falls back, how placeholders fill, and that every table is
 * complete and keeps the same placeholders as English.
 */

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("resolveLanguage", () => {
  it("takes an exact tag first", () => {
    assert.equal(resolveLanguage(["tr-TR"]), "tr-TR");
    assert.equal(resolveLanguage(["pt-BR"]), "pt-BR");
  });

  it("matches the language in another region, case and separator aside", () => {
    assert.equal(resolveLanguage(["de-AT"]), "de-DE");
    assert.equal(resolveLanguage(["en-GB"]), "en-US");
    assert.equal(resolveLanguage(["fr"]), "fr-FR");
    assert.equal(resolveLanguage(["ja"]), "ja-JP");
    assert.equal(resolveLanguage(["ZH_cn"]), "zh-CN");
    assert.equal(resolveLanguage(["zh-Hans-CN"]), "zh-CN");
  });

  it("walks the machine's list in order and skips what it does not have", () => {
    assert.equal(resolveLanguage(["nl-NL", "sv", "ko-KR", "en-US"]), "ko-KR");
    assert.equal(resolveLanguage(["nl-NL", "sv"]), null);
    assert.equal(resolveLanguage([]), null);
  });

  it("never hands Simplified characters to a Traditional Chinese machine", () => {
    assert.equal(resolveLanguage(["zh-TW"]), null);
    assert.equal(resolveLanguage(["zh-Hant-HK", "en-US"]), "en-US");
  });
});

describe("translate", () => {
  it("uses the language's own wording", () => {
    assert.equal(translate("tr-TR", "menu.settings"), "Ayarlar");
    assert.equal(translate("ja-JP", "language.title"), "言語を選択");
  });

  it("falls back to English for a key a table lacks", () => {
    const key: MessageKey = "menu.settings";
    const saved = MESSAGES["de-DE"][key];
    try {
      delete (MESSAGES["de-DE"] as Record<string, string>)[key];
      assert.equal(messageFor("de-DE", key), en[key]);
    } finally {
      (MESSAGES["de-DE"] as Record<string, string>)[key] = saved!;
    }
  });

  it("shows the key itself rather than nothing when even English lacks it", () => {
    assert.equal(messageFor("fr-FR", "no.such.key" as MessageKey), "no.such.key");
  });

  it("fills placeholders, in each language's own word order", () => {
    assert.equal(translate("en-US", "home.greeting.morning", { name: "Kuzey" }), "Morning, Kuzey");
    assert.equal(translate("ja-JP", "home.greeting.morning", { name: "Kuzey" }), "おはようございます、Kuzeyさん");
    assert.equal(translate("ko-KR", "home.greeting.evening", { name: "Kuzey" }), "좋은 저녁이에요, Kuzey님");
  });
});

describe("interpolate", () => {
  it("replaces every occurrence and accepts numbers", () => {
    assert.equal(interpolate("{a} and {a}, {n} MB", { a: "x", n: 15 }), "x and x, 15 MB");
  });

  it("leaves a placeholder with no value as written", () => {
    assert.equal(interpolate("Hello {name}", {}), "Hello {name}");
    assert.equal(interpolate("Hello {name}"), "Hello {name}");
  });

  it("splits into parts for values that are not text", () => {
    const key = { kind: "kbd" };
    assert.deepEqual(interpolateParts("Press {key} to open {symbol}.", { key, symbol: "NVDA" }), [
      "Press ",
      key,
      " to open ",
      "NVDA",
      ".",
    ]);
    assert.deepEqual(interpolateParts("{missing} stays", {}), ["{missing} stays"]);
  });
});

describe("language search", () => {
  it("folds case, accents and the letters without a decomposition", () => {
    assert.equal(foldForSearch("Türkçe"), "turkce");
    assert.equal(foldForSearch("FRANÇAIS"), "francais");
    assert.equal(foldForSearch("ılık İstanbul"), "ilik istanbul");
    assert.equal(foldForSearch("Straße"), "strasse");
  });

  it("finds a language by native name, English name, code or an extra name", () => {
    const tr = languageInfo("tr-TR");
    assert.ok(matchesLanguage(tr, "turkce"));
    assert.ok(matchesLanguage(tr, "TURK"));
    assert.ok(matchesLanguage(tr, "tr-tr"));
    assert.ok(!matchesLanguage(tr, "german"));
    assert.ok(matchesLanguage(languageInfo("de-DE"), "almanca", ["Almanca"]));
    assert.ok(matchesLanguage(languageInfo("ja-JP"), "日本"));
    assert.ok(matchesLanguage(tr, "   "));
  });
});

describe("message tables", () => {
  const keys = Object.keys(en) as MessageKey[];

  it("list exactly the languages that have a table", () => {
    assert.deepEqual(Object.keys(MESSAGES).sort(), LANGUAGES.map((l) => l.code).sort());
  });

  for (const { code } of LANGUAGES) {
    it(`${code} translates every key, with English's placeholders and no dashes`, () => {
      const table = MESSAGES[code];
      const missing = keys.filter((k) => !table[k]?.trim());
      assert.deepEqual(missing, [], `untranslated in ${code}`);
      for (const key of keys) {
        const text = table[key]!;
        assert.deepEqual(placeholders(text), placeholders(en[key]), `${code} ${key} placeholders`);
        assert.ok(!text.includes(EM_DASH) && !text.includes(EN_DASH), `${code} ${key} has a dash`);
      }
      const extra = Object.keys(table).filter((k) => !(k in en));
      assert.deepEqual(extra, [], `${code} has keys English does not`);
    });
  }
});
