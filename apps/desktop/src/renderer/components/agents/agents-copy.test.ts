import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  bannedWordHits,
  copyProblems,
  jsxText,
  literals,
  looksLikeClassList,
  looksLikeCopy,
  textProblems,
  withoutComments,
} from "../../../shared/copy-rules";
import * as area from "../../lib/i18n/messages/areas/agents";

/**
 * The house copy rules over every agent screen: no advice vocabulary, no
 * forward-looking vocabulary, no em or en dash. Checked against source, so
 * the states that are awkward to reach (no engine, a failed load, an empty
 * list) are held to the rule as well. The fixtures are included: they are
 * what the preview shows, and copy there is copied into the real thing.
 *
 * The words themselves live in the agents message table
 * (lib/i18n/messages/areas/agents.ts), so the same rules run over every
 * language there: English against the house word lists, the others against
 * the same dash rule (and the full-width dashes of Japanese, Chinese and
 * Korean), no exclamation marks, and each language's own advice vocabulary.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = fs
  .readdirSync(HERE)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))
  .map((f) => path.join(HERE, f));
FILES.push(path.join(HERE, "..", "..", "lib", "agents-client.ts"));
const read = (f: string) => fs.readFileSync(f, "utf8");

/** Things the rule cannot see but the reader asked for: no exclamation marks or AI chrome in copy. */
const CHROME = /(AI-powered|I'm your assistant|I am your assistant|Sparkles)/;

type Table = Readonly<Record<string, string | undefined>>;
const TABLES: ReadonlyArray<[string, Table]> = [
  ["en", area.en],
  ["tr", area.tr],
  ["de", area.de],
  ["fr", area.fr],
  ["es", area.es],
  ["it", area.it],
  ["ptBR", area.ptBR],
  ["ja", area.ja],
  ["zhCN", area.zhCN],
  ["ko", area.ko],
];

/**
 * Advice vocabulary per language: the words that would turn a description
 * into an instruction to trade or a recommendation. Purchases as a fact (an
 * insider's open-market purchase) are fine; telling the reader to buy is not.
 */
const ADVICE: Readonly<Record<string, readonly string[]>> = {
  tr: ["satın alın", "satın al", "satın", "satın alma önerisi", "tavsiye", "öneririz", "hedef fiyat", "almalısınız", "satmalısınız"],
  de: ["kaufen", "verkaufen", "Kaufempfehlung", "empfehlen", "Empfehlung", "Kursziel", "sollten"],
  fr: ["acheter", "vendre", "recommandation", "recommander", "recommandons", "conseillons", "objectif de cours", "devriez"],
  es: ["comprar", "vender", "recomendación", "recomendamos", "recomendar", "precio objetivo", "deberías"],
  it: ["comprare", "vendere", "raccomandazione", "consigliamo", "consigliare", "prezzo obiettivo", "dovresti"],
  ptBR: ["comprar", "vender", "recomendação", "recomendamos", "recomendar", "preço-alvo", "deveria"],
  ja: ["買い推奨", "売り推奨", "推奨", "おすすめ", "買うべき", "売るべき", "目標株価"],
  zhCN: ["买入建议", "卖出建议", "推荐", "建议买", "建议卖", "目标价", "应该买", "应该卖"],
  ko: ["매수 추천", "매도 추천", "추천", "사야", "팔아야", "목표가"],
};
const CJK = new Set(["ja", "zhCN", "ko"]);

/** Dashes a CJK writer reaches for in place of the em dash. */
const WIDE_DASHES = /[―‒－〜～⸺⸻]/;

describe("agent screens copy", () => {
  for (const file of FILES) {
    it(`${path.basename(file)} follows the copy rules`, () => {
      assert.deepEqual(copyProblems(read(file), { riskWords: true, jsxText: true }), []);
    });
  }

  it("has no exclamation marks in what a reader sees, and no assistant chrome", () => {
    for (const file of FILES) {
      const code = withoutComments(read(file));
      const copy = [
        ...literals(code).filter((l) => looksLikeCopy(l) && !looksLikeClassList(l) && !l.includes("${")),
        ...jsxText(code),
      ];
      assert.deepEqual(copy.filter((l) => /![^=]|!$/.test(l)), [], path.basename(file));
      assert.ok(!CHROME.test(code), `${path.basename(file)} carries assistant chrome`);
    }
  });

  it("holds the English table to the house word lists", () => {
    const problems = Object.values(area.en).flatMap((text) => textProblems(text, { riskWords: true }));
    assert.deepEqual(problems, []);
  });

  for (const [name, table] of TABLES) {
    it(`${name}: no dashes, no exclamation marks, no advice vocabulary, no assistant chrome`, () => {
      for (const [key, text] of Object.entries(table)) {
        if (!text) continue;
        assert.deepEqual(textProblems(text).filter((p) => p.includes("dash")), [], `${name} ${key}`);
        assert.ok(!WIDE_DASHES.test(text), `${name} ${key} has a full-width dash: ${text}`);
        assert.ok(!/[!！]/.test(text), `${name} ${key} has an exclamation mark: ${text}`);
        assert.ok(!CHROME.test(text), `${name} ${key} carries assistant chrome`);
        const words = ADVICE[name] ?? [];
        const hits = CJK.has(name) ? words.filter((w) => text.includes(w)) : bannedWordHits(text, words);
        assert.deepEqual(hits, [], `${name} ${key}: ${text}`);
      }
    });
  }

  it("translates every English line in every language", () => {
    const keys = Object.keys(area.en);
    for (const [name, table] of TABLES) {
      const missing = keys.filter((k) => !table[k]?.trim());
      assert.deepEqual(missing, [], `${name} lacks agent lines`);
    }
  });

  // The scans above pass trivially over a table with no copy in it.
  it("still finds the lines a reader meets", () => {
    const english = Object.values(area.en).join("\n");
    for (const phrase of [
      "View Agents",
      "No agents yet",
      "Agents aren't available in this build",
      "New agent",
      "Create agent",
      "One report, then done",
      "Keep watching",
      "delivered once the Falcon mobile app launches",
      "Run now",
      "Your agents could not be loaded",
    ]) {
      assert.ok(english.includes(phrase), `missing: ${phrase}`);
    }
  });
});

describe("engine lines", () => {
  it("has words for every code the engine sends", () => {
    const MAIN = path.join(HERE, "..", "..", "..", "main", "agents");
    const files = [
      ...fs.readdirSync(MAIN).map((f) => path.join(MAIN, f)),
      ...fs.readdirSync(path.join(MAIN, "channels")).map((f) => path.join(MAIN, "channels", f)),
    ].filter((f) => /\.ts$/.test(f) && !f.endsWith(".test.ts"));
    const codes = new Set<string>();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/line\("([\w.]+)"/g)) codes.add(m[1]!);
      for (const m of src.matchAll(/code: "([\w.]+)"/g)) codes.add(m[1]!);
      for (const m of src.matchAll(/line\(\s*[^)"]*\?\s*"([\w.]+)"\s*:\s*"([\w.]+)"/g)) {
        codes.add(m[1]!);
        codes.add(m[2]!);
      }
    }
    assert.ok(codes.size > 40, `found only ${codes.size} codes`);
    const en = area.en as Record<string, string>;
    const missing = [...codes].filter((c) => !en[`agents.line.${c}`] && !en[`agents.line.${c}.other`]);
    assert.deepEqual(missing, []);
  });
});

describe("agent wiring", () => {
  const PAGE = withoutComments(fs.readFileSync(path.join(HERE, "..", "..", "pages", "HomePage.tsx"), "utf8"));
  const CARD = withoutComments(read(path.join(HERE, "AgentsCard.tsx")));

  it("opens the Agents tab from the masthead arrow, as the calendar card opens its tab", () => {
    assert.match(CARD, /onOpen=\{onOpenAgents\}/);
    assert.match(CARD, /openLabel=\{t\("agents\.card\.viewAll"\)\}/);
    assert.ok(!/glass-cta[^"]*w-full/.test(CARD), "no full-width button at the foot");
    assert.equal(area.en["agents.card.viewAll"], "View Agents");
  });

  it("registers the Agents tab and opens it from the card and from open requests", () => {
    assert.match(PAGE, /agents: \{ labelKey: "home\.tab\.agents", Component: AgentsTab \}/);
    assert.match(PAGE, /onOpenAgents=\{\(\) => openTab\("agents"\)\}/);
    assert.match(PAGE, /onAgentsOpenRequest\(\(\) => openTab\("agents"\)\)/);
  });

  it("never shows fixtures unless something installs them", () => {
    const client = withoutComments(read(path.join(HERE, "..", "..", "lib", "agents-client.ts")));
    assert.ok(!/import \{[^}]*\} from "@\/components\/agents\/agent-fixtures"/.test(client), "fixtures are loaded lazily, never statically");
    assert.match(client, /import\.meta\.env\.DEV/);
  });
});
