// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/glossary.test.ts
// Pure checks of the finance glossary and its matcher; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLASS_LABEL, GLOSSARY, PLACE_INFO, glossaryEntry } from "./glossary";
import { MAX_TERM_VALUE, cleanTermValue, explicitTermKeys, findTerms, foldTr, parseTermLink, replyLang, termKeysIn } from "./glossary-match";
import { DESK_SYSTEM } from "./system";

const keys = (text: string, seen = new Set<string>()) => findTerms(text, seen).map((h) => h.key);
const words = (text: string) => findTerms(text, new Set()).map((h) => text.slice(h.start, h.end));

test("every entry has a Turkish and an English term, class and definitions", () => {
  assert.ok(GLOSSARY.length >= 120 && GLOSSARY.length <= 200, `size ${GLOSSARY.length}`);
  const seen = new Set<string>();
  for (const g of GLOSSARY) {
    assert.match(g.key, /^[a-z0-9-]+$/, g.key);
    assert.ok(!seen.has(g.key), `duplicate key ${g.key}`);
    seen.add(g.key);
    assert.ok(CLASS_LABEL.tr[g.cls] && CLASS_LABEL.en[g.cls], `${g.key} class`);
    for (const side of [g.tr, g.en]) {
      assert.ok(side.term.trim(), `${g.key} term`);
      assert.ok(side.forms.length >= 1, `${g.key} forms`);
      assert.ok(side.defs.length >= 1 && side.defs.length <= 3, `${g.key} defs`);
      for (const d of side.defs) assert.ok(d.trim().length > 10 && d.length < 260, `${g.key} def length`);
    }
    assert.equal(g.tr.defs.length, g.en.defs.length, `${g.key}: same number of definitions in both languages`);
    if (g.at) assert.ok(PLACE_INFO[g.at], `${g.key} place`);
  }
});

test("no surface form points at two different terms", () => {
  const owner = new Map<string, string>();
  for (const g of GLOSSARY)
    for (const f of [...g.tr.forms, ...g.en.forms]) {
      const k = foldTr(f.replace(/^=/, "").replace(/\s+/g, " "));
      const prev = owner.get(k);
      assert.ok(!prev || prev === g.key, `"${f}" in ${prev} and ${g.key}`);
      owner.set(k, g.key);
    }
});

test("every glossary term finds itself", () => {
  for (const g of GLOSSARY)
    for (const f of [...g.tr.forms, ...g.en.forms]) {
      const surface = f.replace(/^=/, "");
      assert.deepEqual(keys(`Bak: ${surface} burada.`), [g.key], `${g.key}: "${surface}"`);
    }
});

test("Turkish suffixes, softening and apostrophes", () => {
  assert.deepEqual(keys("Bilanço sonrası IV çöküşünü hesaba kat."), ["iv-crush"]);
  assert.deepEqual(keys("Hissenin oynaklığı yüksek."), ["volatility"]);
  assert.deepEqual(keys("Bu dönemin örtük oynaklığını gördük."), ["iv"]);
  assert.deepEqual(keys("Put tarafındaki skew'i dik."), ["skew"]);
  assert.deepEqual(keys("Stratejinin Sharpe'ı 0,8."), ["sharpe"]);
  assert.deepEqual(keys("Sharpe oranının düşmesi"), ["sharpe"]);
  assert.deepEqual(keys("Sonuç örneklem dışında zayıfladı."), ["out-of-sample"]);
  assert.deepEqual(keys("Şirketin 8-K'sında Item 2.02 var."), ["8-k", "item-2-02"]);
  assert.deepEqual(keys("put/call oranı 1,4"), ["put-call-ratio"]);
  assert.deepEqual(keys("ORANI: PUT/CALL ORANI"), ["put-call-ratio"], "Turkish upper case folds");
  assert.deepEqual(keys("implied move'u ±%8"), ["implied-move"]);
  assert.deepEqual(keys("NVDA'nın drawdown'u"), ["drawdown"]);
  assert.deepEqual(keys("abnormal return was 5%"), ["abnormal-return"]);
  assert.deepEqual(keys("two 10-Ks and an 8-K"), ["10-k", "8-k"]);
});

test("word edges and case: no matches inside other words, abbreviations match case", () => {
  assert.deepEqual(keys("skewness and IVY league"), []);
  assert.deepEqual(keys("alfabetik sıra"), []);
  assert.deepEqual(keys("burada var mı?"), [], "Turkish 'var' is not VaR");
  assert.deepEqual(keys("the iv is high"), [], "lower-case iv is not IV");
  assert.deepEqual(keys("ATM IV %58"), ["iv"], "ATM IV is one term");
  assert.deepEqual(keys("1.8-K"), []);
});

test("longest match first", () => {
  assert.deepEqual(words("IV çöküşü ve IV"), ["IV çöküşü", "IV"], "two different terms");
  assert.deepEqual(words("IV çöküşü sonra yine IV çöküşü"), ["IV çöküşü"]);
  assert.deepEqual(keys("max drawdown then drawdown"), ["max-drawdown", "drawdown"]);
  assert.deepEqual(keys("volume delta, not delta"), ["volume-delta", "delta"]);
  assert.deepEqual(keys("deflated Sharpe ratio"), ["deflated-sharpe"]);
});

test("first occurrence only, across calls sharing a seen set", () => {
  const seen = new Set<string>();
  assert.deepEqual(keys("Skew dik; skew yine dik.", seen), ["skew"]);
  assert.deepEqual(keys("Skew üçüncü kez.", seen), []);
  assert.deepEqual(keys("IV ve IV çöküşü", new Set(["iv"])), ["iv-crush"]);
});

test("bare URLs are skipped", () => {
  assert.deepEqual(keys("See https://example.com/skew-and-IV for skew"), ["skew"]);
});

test("termKeysIn skips code, links and headings", () => {
  const md = "```python\nsharpe = 1\n```\n`VIX` ve [skew](https://x.y)\n# Drawdown\nAncak IV çöküşü önemli.";
  assert.deepEqual([...termKeysIn(md)], ["iv-crush"]);
});

test("explicit term links: known keys only, value cleaned and capped, definition untouched", () => {
  const ok = parseTermLink('[IV çöküşü](term:iv-crush "NVDA 30g ATM IV: %58, bilanço sonrası beklenen ~%35")');
  assert.deepEqual(ok, { label: "IV çöküşü", key: "iv-crush", value: "NVDA 30g ATM IV: %58, bilanço sonrası beklenen ~%35" });
  assert.equal(parseTermLink("[foo](term:not-a-key)")?.key, null);
  assert.equal(parseTermLink('[foo](term:not-a-key "1")')?.value, undefined);
  const long = parseTermLink(`[skew](term:skew "${"x".repeat(300)}")`);
  assert.ok(long?.value && long.value.length <= MAX_TERM_VALUE);
  assert.equal(cleanTermValue("**%58** <b>`x`</b>"), "%58 bx/b");
  const before = JSON.stringify(glossaryEntry("skew"));
  parseTermLink('[skew](term:skew "Skew: tanım yerine yazılmış uzun bir açıklama, bu bir tanım değildir")');
  parseTermLink("[Skew is a bet on crashes](term:skew)");
  assert.equal(JSON.stringify(glossaryEntry("skew")), before, "markup never changes the stored definition");
  assert.deepEqual([...explicitTermKeys("[a](term:skew) [b](term:nope) [c](term:iv)")], ["skew", "iv"]);
});

test("reply language", () => {
  assert.equal(replyLang("NVDA bilanço öncesi IV çöküşü riski nedir?"), "tr");
  assert.equal(replyLang("What is the implied move into earnings for NVDA?"), "en");
});

test("the system prompt lists only real glossary keys", () => {
  const listed = /term keys: ([a-z0-9, -]+)\./.exec(DESK_SYSTEM)?.[1]?.split(/,\s*/) ?? [];
  assert.ok(listed.length >= 20, "system prompt names the keys");
  for (const k of listed) assert.ok(glossaryEntry(k), `unknown key in system prompt: ${k}`);
});

test("display terms carry no match markers", () => {
  for (const g of GLOSSARY) for (const side of [g.tr, g.en]) assert.ok(!side.term.startsWith("="), `${g.key}: ${side.term}`);
});
