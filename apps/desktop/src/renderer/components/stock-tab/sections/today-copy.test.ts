import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CAUSAL_WORDS, bannedWordHits, copyProblems, textProblems } from "../../../../shared/copy-rules";
import { ITEM_KEYS, todaySummary, todayView, type StockToday, type TodayFormat } from "../../../../shared/today-move";
import * as today from "../../../lib/i18n/messages/areas/today";

/**
 * The house copy rules over "Today" (the Stock tab's unusual session and the
 * Positions card's hover line): every English line with the risk words on
 * and the causal words too (no line may say why a stock moved), every
 * language's lines, the lines as built from a full answer, and the section's
 * and the view's sources.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANGS = ["tr", "de", "fr", "es", "it", "ptBR", "ja", "zhCN", "ko"] as const;

/** The same in the other languages the tables are written in, as a translator might reach for them. */
const CAUSAL_ELSEWHERE: Readonly<Record<(typeof LANGS)[number], RegExp>> = {
  tr: /nedeniyle|yüzünden|dolayı|sayesinde|etkisiyle|sebebiyle|kaynaklı/i,
  de: /\bweil\b|aufgrund|wegen|infolge|getrieben|ausgelöst/i,
  fr: /parce que|en raison|à cause|grâce à|suite à|porté par|entraîné/i,
  es: /porque|debido a|a causa|gracias a|impulsad|provocad/i,
  it: /perché|a causa|dovuto|grazie a|trainat|provocat/i,
  ptBR: /porque|devido a|por causa|graças a|impulsionad|provocad/i,
  ja: /ため|により|によって|を受けて|が原因/,
  zhCN: /因为|由于|受.*推动|导致|带动/,
  ko: /때문|인해|으로 인한|에 따라|덕분/,
};

const own = Object.entries(today.en);

function answer(): StockToday {
  return {
    ticker: "FAST",
    day: "2026-10-15",
    previousDay: "2026-10-14",
    since: "2026-10-14T20:00:00.000Z",
    asOf: "2026-10-15T19:00:00.000Z",
    move: -0.0312,
    market: { symbol: "SPY", move: 0.0028 },
    sector: { symbol: "XLI", move: 0.0051 },
    beta: 0.55,
    sigma: 0.0125,
    sessions: 60,
    abnormal: -0.0327,
    ratio: 2.62,
    unusual: true,
    filings: [
      { kind: "current", form: "8-K", items: Object.keys(ITEM_KEYS).concat("9.99"), at: "2026-10-15T11:31:00.000Z", url: "https://www.sec.gov/a" },
      { kind: "insider", name: "Jane Doe", role: "", code: "S", value: 1_250_000, plan: true, at: "2026-10-14T21:00:00.000Z", url: "https://www.sec.gov/b" },
      { kind: "insider", name: "John Roe", role: "Director", code: "P", value: null, plan: false, at: "2026-10-14T21:00:00.000Z", url: "https://www.sec.gov/c" },
      { kind: "insider_other", count: 2, at: null, url: "https://www.sec.gov/d" },
      { kind: "insider_other", count: 1, at: null, url: "https://www.sec.gov/d" },
      { kind: "schedule", schedule: "13D", amendment: true, at: null, url: "https://www.sec.gov/e" },
      { kind: "schedule", schedule: "13G", amendment: false, at: null, url: "https://www.sec.gov/e" },
      { kind: "periodic", form: "10-Q", at: null, url: "https://www.sec.gov/f" },
      { kind: "current", form: "8-K", items: [], at: null, url: "https://www.sec.gov/f" },
      { kind: "other", forms: ["S-3", "424B5"], count: 2, at: null, url: "https://www.sec.gov/g" },
    ],
    linked: ["supplier", "customer", "partner", "competitor", "dependency", "related"].flatMap((category) => [
      { ticker: "GWW", name: null, category, namedBy: "FAST", linkUrl: null, event: "report" as const, items: [], at: null, url: null },
      { ticker: "GWW", name: null, category, namedBy: "GWW", linkUrl: null, event: "filing" as const, items: ["8.01"], at: null, url: null },
      { ticker: "GWW", name: null, category, namedBy: "GWW", linkUrl: null, event: "filing" as const, items: [], at: null, url: null },
    ]),
    news: [],
    peers: [{ ticker: "GWW", move: -0.025 }],
    peersRead: 5,
    degraded: ["sec", "links", "news", "peers"],
  };
}

function format(lang: (typeof LANGS)[number] | "en"): TodayFormat {
  const table = (lang === "en" ? today.en : { ...today.en, ...today[lang] }) as Record<string, string>;
  return {
    t: (key, params = {}) => {
      const text = table[key];
      assert.ok(text, `${lang} ${key} missing`);
      return text.replace(/\{(\w+)\}/g, (_, n: string) => String(params[n] ?? `{${n}}`));
    },
    move: (x) => `${(x * 100).toFixed(1)}%`,
    share: (x) => `${(x * 100).toFixed(1)}%`,
    ratio: (x) => x.toFixed(1),
    money: (x) => `$${x}`,
    weekday: () => "Wednesday",
    time: () => "10:00 ET",
    list: (xs) => xs.join(", "),
    plural: (n) => (n === 1 ? "one" : "other"),
  };
}

function built(lang: (typeof LANGS)[number] | "en"): string[] {
  const f = format(lang);
  const out: string[] = [];
  const cases: Array<[StockToday, string]> = [
    [answer(), "2026-10-15"],
    [{ ...answer(), filings: [], linked: [], peers: [], degraded: [] }, "2026-10-17"],
  ];
  for (const [d, now] of cases) {
    const v = todayView(d, now, f);
    out.push(v.headline, v.context, v.since, f.t("today.onRecord", { since: v.since }), ...v.lines.map((l) => l.text), v.empty ?? "", v.note ?? "", todaySummary(d, now, f));
  }
  return out.filter(Boolean);
}

describe("today: copy", () => {
  it("has its lines in the table", () => {
    assert.ok(own.length >= 60);
  });

  it("the English lines follow the copy rules, risk words included, and name no cause", () => {
    const problems = own.flatMap(([key, text]) => [
      ...textProblems(text, { riskWords: true }).map((p) => `${key}: ${p}`),
      ...bannedWordHits(text, CAUSAL_WORDS).map((w) => `${key}: causal word "${w}"`),
    ]);
    assert.deepEqual(problems, []);
  });

  it("every language has every line, keeps the placeholders, with no dashes, no exclamation marks and no causal words", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const lang of LANGS) {
      const table = today[lang] as Record<string, string | undefined>;
      for (const [key, text] of own) {
        const tr = table[key];
        assert.ok(tr, `${lang} ${key} missing`);
        assert.equal(placeholders(tr!), placeholders(text), `${lang} ${key}`);
        assert.ok(!/[‒–—―－〜～⸺⸻]/.test(tr!), `${lang} ${key} has a dash`);
        assert.ok(!/[!！]/.test(tr!), `${lang} ${key} has an exclamation mark`);
        assert.ok(!CAUSAL_ELSEWHERE[lang].test(tr!), `${lang} ${key} names a cause: ${tr}`);
      }
      assert.deepEqual(Object.keys(table).filter((k) => !(k in today.en)), [], `${lang} has lines English does not`);
    }
  });

  it("the lines as built, every kind of record, in every language, name no cause and leave no placeholder", () => {
    for (const lang of ["en", ...LANGS] as const) {
      for (const line of built(lang)) {
        assert.ok(!/\{\w+\}/.test(line), `${lang}: ${line}`);
        assert.ok(!/[‒–—―－⸺⸻]/.test(line), `${lang}: ${line}`);
        if (lang === "en") {
          assert.deepEqual(bannedWordHits(line, CAUSAL_WORDS), [], line);
          assert.deepEqual(textProblems(line, { riskWords: true }), [], line);
        } else assert.ok(!CAUSAL_ELSEWHERE[lang].test(line), `${lang}: ${line}`);
      }
    }
  });

  it("the section, the view and the reads carry no line of their own that breaks the rules", () => {
    const files = [
      path.join(HERE, "TodaySection.tsx"),
      path.join(HERE, "../use-stock-today.ts"),
      path.join(HERE, "../../../../shared/today-move.ts"),
    ];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      assert.deepEqual(copyProblems(src, { jsxText: true, riskWords: true }), [], file);
    }
  });
});
