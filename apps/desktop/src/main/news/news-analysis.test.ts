import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { GlossModelCaller, GlossModelInput } from "@meridian/research/gloss";
import {
  NEWS_ANALYSIS_SYSTEM,
  analysisSource,
  analyzeNewsArticle,
  buildNewsUser,
  checkTranslation,
  newsModel,
  parseNewsAnalysis,
  relationshipLines,
} from "./news-analysis";
import { createNewsArticleService, sanitizeRequest } from "./news-article-service";
import { TtlCache } from "./ttl-cache";
import type { ClassifierVerdict } from "../../shared/classifier-types";
import type { NewsArticleBody, NewsArticleRequest } from "../../shared/news-article";

const ARTICLE =
  "Nvidia said revenue in its data-center segment rose to $30.8 billion in the quarter, up 112% from a year earlier. " +
  "The company guided third-quarter revenue to $32.5 billion. Taiwan Semiconductor Manufacturing makes the chips.";

const REQUEST: NewsArticleRequest = {
  id: 7,
  headline: "Nvidia beats on data-center demand",
  summary: "",
  url: "https://news.example.com/7",
  source: "Example Wire",
  datetime: 1_760_000_000,
  tickers: ["NVDA", "TSM"],
};

const BODY: NewsArticleBody = {
  status: "full",
  paragraphs: [ARTICLE],
  truncated: false,
  origin: "publisher",
  finalUrl: REQUEST.url,
  fetchedAt: 1,
};

const opts = (language = "en-US") => ({ tickers: REQUEST.tickers, corpusText: `${REQUEST.headline}\n${ARTICLE}`, language });

describe("news analysis: parsing and house rules", () => {
  it("keeps clean, grounded lines", () => {
    const read = parseNewsAnalysis(
      JSON.stringify({
        summary: [
          { en: "Nvidia reported data-center revenue of $30.8 billion, up 112% from a year earlier.", translation: "" },
          { en: "The company guided third-quarter revenue to $32.5 billion.", translation: "" },
        ],
        companies: [
          { ticker: "NVDA", en: "Data-center sales are the largest part of Nvidia's revenue.", translation: "" },
          { ticker: "tsm", en: "TSM's filing names Nvidia as a customer, so the volumes run through its foundry lines.", translation: "" },
        ],
      }),
      opts(),
    );
    assert.equal(read.summary.length, 2);
    assert.equal(read.summary[0]!.text, read.summary[0]!.en);
    assert.deepEqual(read.companies.map((c) => c.ticker), ["NVDA", "TSM"]);
  });

  it("drops a sentence with a figure that is not in the article", () => {
    const read = parseNewsAnalysis(
      JSON.stringify({
        summary: [{ en: "Revenue rose to $30.8 billion. Margins reached 78.4% in the period.", translation: "" }],
        companies: [],
      }),
      opts(),
    );
    assert.equal(read.summary[0]!.en, "Revenue rose to $30.8 billion.");
  });

  it("cleans dashes, emoji, exclamation marks and filler, and softens or drops advice", () => {
    const read = parseNewsAnalysis(
      JSON.stringify({
        summary: [
          { en: "Great question! Nvidia — the chip designer — beat estimates \u{1F680}!", translation: "" },
          { en: "Investors should buy the shares before the next report.", translation: "" },
          { en: "The company expects demand to stay firm.", translation: "" },
        ],
        companies: [{ ticker: "NVDA", en: "The stock will likely rise further.", translation: "" }],
      }),
      opts(),
    );
    const texts = read.summary.map((l) => l.en);
    assert.equal(texts.length, 2);
    assert.ok(!texts.join(" ").includes("—"));
    assert.ok(!texts.join(" ").includes("!"));
    assert.ok(!/\p{Extended_Pictographic}/u.test(texts.join(" ")));
    assert.ok(!/great question/i.test(texts.join(" ")));
    assert.ok(!/should|buy/i.test(texts.join(" ")));
    assert.match(texts[1]!, /anticipates/);
    // A company line made only of a prediction has nothing left: it goes.
    assert.equal(read.companies.length, 0);
  });

  it("drops a sentence a swap would twist, rather than rewording it", () => {
    const read = parseNewsAnalysis(
      JSON.stringify({
        summary: [
          { en: "Meta walked away from the acquisition target after regulators objected.", translation: "" },
          { en: "Nvidia reported results.", translation: "" },
        ],
        companies: [{ ticker: "NVDA", en: "The ruling adds to pressure on Nvidia.", translation: "" }],
      }),
      opts(),
    );
    assert.deepEqual(read.summary.map((l) => l.en), ["Nvidia reported results."]);
    assert.equal(read.companies.length, 0);
  });

  it("joins a company's sentences, at most two, and keeps the translation only when both hold", () => {
    const read = parseNewsAnalysis(
      JSON.stringify({
        summary: [{ en: "Nvidia reported results.", translation: "Nvidia sonuçlarını açıkladı." }],
        companies: [
          { ticker: "NVDA", en: "Data-center sales rose.", translation: "Veri merkezi satışları arttı." },
          { ticker: "NVDA", en: "TSMC makes the chips.", translation: "Çipleri TSMC üretiyor." },
          { ticker: "NVDA", en: "A third sentence.", translation: "Üçüncü cümle." },
          { ticker: "TSM", en: "TSMC makes the chips.", translation: "Çipleri TSMC üretiyor." },
          { ticker: "TSM", en: "The company expects more orders.", translation: "Şirket daha fazla sipariş bekliyor." },
        ],
      }),
      opts("tr-TR"),
    );
    assert.equal(read.companies.length, 2);
    assert.equal(read.companies[0]!.text, "Veri merkezi satışları arttı. Çipleri TSMC üretiyor.");
    assert.equal(read.companies[0]!.untranslated, false);
    // The second TSM sentence was softened in English, so the whole TSM line shows in English.
    assert.equal(read.companies[1]!.untranslated, true);
    assert.equal(read.companies[1]!.text, "TSMC makes the chips. The company anticipates more orders.");
  });

  it("drops companies that were not named", () => {
    const read = parseNewsAnalysis(
      JSON.stringify({
        summary: [{ en: "Nvidia reported results.", translation: "" }],
        companies: [
          { ticker: "AMD", en: "AMD competes with Nvidia.", translation: "" },
          { ticker: "NVDA", en: "Nvidia sells accelerators.", translation: "" },
          { ticker: "NVDA", en: "Nvidia again.", translation: "" },
        ],
      }),
      opts(),
    );
    assert.deepEqual(read.companies.map((c) => c.ticker), ["NVDA"]);
  });

  it("rejects malformed output and an empty read", () => {
    assert.throws(() => parseNewsAnalysis("not json", opts()), /malformed/);
    assert.throws(
      () => parseNewsAnalysis(JSON.stringify({ summary: [{ en: "You should sell now.", translation: "" }], companies: [] }), opts()),
      /survived/,
    );
  });

  it("shows a translation only when its English passed untouched and its figures match", () => {
    const read = parseNewsAnalysis(
      JSON.stringify({
        summary: [
          { en: "Nvidia reported data-center revenue of $30.8 billion.", translation: "Nvidia, veri merkezi gelirini 30,8 milyar $ olarak açıkladı!" },
          { en: "The company expects demand to stay firm.", translation: "Şirket talebin güçlü kalmasını bekliyor." },
          { en: "Revenue rose 112%.", translation: "Gelir %215 arttı." },
        ],
        companies: [],
      }),
      opts("tr-TR"),
    );
    assert.equal(read.summary[0]!.untranslated, false);
    assert.equal(read.summary[0]!.text, "Nvidia, veri merkezi gelirini 30,8 milyar $ olarak açıkladı.");
    // Softened in English ("expects" to "anticipates"): the translation no longer matches.
    assert.equal(read.summary[1]!.untranslated, true);
    assert.equal(read.summary[1]!.text, read.summary[1]!.en);
    // A figure the English does not carry.
    assert.equal(read.summary[2]!.untranslated, true);
  });

  it("checks a translation for dashes and full-width exclamation marks", () => {
    assert.equal(checkTranslation("売上高は$30.8 billion—増加！", "Revenue rose to $30.8 billion."), "売上高は$30.8 billion, 増加。");
    assert.equal(checkTranslation("", "x"), null);
  });
});

describe("news analysis: prompt", () => {
  it("states the house rules and asks for the translation in the UI language", () => {
    assert.match(NEWS_ANALYSIS_SYSTEM, /Describe, never advise/);
    assert.match(NEWS_ANALYSIS_SYSTEM, /Every number you write must appear in the article text/);
    assert.match(NEWS_ANALYSIS_SYSTEM, /em dashes/);
    assert.ok(!NEWS_ANALYSIS_SYSTEM.includes("—"));
    const source = analysisSource(REQUEST, BODY)!;
    const user = buildNewsUser(REQUEST, source, ["NVDA's filing names X (TSM) as a supplier"], "de-DE");
    assert.match(user, /German translation/);
    assert.match(user, /Tickers named: NVDA, TSM/);
    assert.match(user, /supplier/);
    assert.match(buildNewsUser(REQUEST, source, [], "en-US"), /empty string/);
  });

  it("uses the article when there is one, the provider summary otherwise, and nothing when both are thin", () => {
    assert.equal(analysisSource(REQUEST, BODY)!.basis, "article");
    const summary = "S".repeat(200);
    assert.equal(analysisSource({ ...REQUEST, summary }, { ...BODY, status: "blocked", paragraphs: [], origin: "none" })!.basis, "summary");
    assert.equal(analysisSource({ ...REQUEST, summary: "Too short." }, null), null);
  });

  it("defaults to a Haiku-class model and honours FALCON_NEWS_MODEL", () => {
    assert.match(newsModel({}), /haiku/);
    assert.equal(newsModel({ FALCON_NEWS_MODEL: " claude-x " }), "claude-x");
  });

  it("calls the shared caller with the schema, low effort and the chosen model", async () => {
    let input: GlossModelInput | null = null;
    const caller: GlossModelCaller = async (i) => {
      input = i;
      return { text: JSON.stringify({ summary: [{ en: "Nvidia reported results.", translation: "" }], companies: [] }), input_tokens: 1, output_tokens: 1 };
    };
    const read = await analyzeNewsArticle(REQUEST, analysisSource(REQUEST, BODY)!, [], "en-US", { caller, model: "m", now: () => new Date(0) });
    assert.equal(read.model, "m");
    assert.equal(read.basis, "article");
    assert.equal(input!.effort, "low");
    assert.equal(input!.model, "m");
    assert.ok(input!.output_schema);
  });
});

describe("news analysis: relationship lines", () => {
  const edges = [
    { root_ticker: "NVDA", counterparty_ticker: "TSM", counterparty_name: "TSMC", category: "supplier", subtype: "foundry", strength_tier: "critical" },
    { root_ticker: "NVDA", counterparty_ticker: "MSFT", counterparty_name: "Microsoft", category: "customer", strength_tier: "important" },
    { root_ticker: "NVDA", counterparty_ticker: "XYZ", counterparty_name: "Xyz", category: "competitor", strength_tier: "marginal" },
    { root_ticker: "AAPL", counterparty_ticker: "TSM", counterparty_name: "TSMC", category: "supplier", strength_tier: "critical" },
  ];
  it("puts edges between the story's names first, then the strong ones, never marginal or unrelated", () => {
    const lines = relationshipLines(edges, ["NVDA", "TSM"]);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^NVDA's filing names TSMC \(TSM\) as a supplier, foundry; strength critical$/);
    assert.match(lines[1]!, /Microsoft/);
    assert.deepEqual(relationshipLines(edges, []), []);
  });
});

// ---------------------------------------------------------------------------
// Service: caches and dedupe
// ---------------------------------------------------------------------------

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-news-article-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function verdict(key: string, status: "ok" | "failed" = "ok"): ClassifierVerdict {
  return {
    schema_version: 1,
    prompt_version: "p",
    model: "m",
    article_key: key,
    kind: "news",
    event_type: "earnings_results",
    event_label: "Q3 beat",
    syndication_scope: 1,
    tickers: [{ ticker: "NVDA", relevance: "direct", materiality: "high", direction: "positive" }],
    unassessed_tickers: [],
    status,
    metadata_missing: false,
    classified_at: "2026-10-11T00:00:00Z",
    failure_reason: null,
  };
}

function makeService(overrides: Partial<Parameters<typeof createNewsArticleService>[0]> = {}) {
  const dir = tempDir();
  const counts = { body: 0, verdicts: 0, model: 0 };
  const service = createNewsArticleService({
    dataDir: () => dir,
    readBody: async () => {
      counts.body += 1;
      return BODY;
    },
    listVerdicts: async () => {
      counts.verdicts += 1;
      return [verdict("id:7"), verdict("id:8", "failed")];
    },
    relationships: async () => [],
    caller: async (input) => {
      counts.model += 1;
      await new Promise((r) => setTimeout(r, 15));
      const tr = input.user.includes("Turkish") ? "Nvidia sonuçlarını açıkladı." : "";
      return { text: JSON.stringify({ summary: [{ en: "Nvidia reported results.", translation: tr }], companies: [] }), input_tokens: 1, output_tokens: 1 };
    },
    configured: () => true,
    language: () => "en-US",
    isLanguage: (v) => typeof v === "string" && /^[a-z]{2}-[A-Z]{2}$/.test(v),
    model: () => "test-model",
    ...overrides,
  });
  return { service, counts, dir };
}

describe("news article service", () => {
  it("checks what the renderer sends", () => {
    assert.equal(sanitizeRequest(null), null);
    assert.equal(sanitizeRequest({ id: 1 }), null);
    const clean = sanitizeRequest({ id: 3.7, headline: "h", tickers: ["nvda", "NVDA", "bad ticker!", 5], url: 9 })!;
    assert.equal(clean.id, 3);
    assert.deepEqual(clean.tickers, ["NVDA"]);
    assert.equal(clean.url, "");
  });

  it("reads an article once, shares the read in flight, and keeps it on disk", async () => {
    const { service, counts, dir } = makeService();
    const [a, b] = await Promise.all([service.body(REQUEST), service.body(REQUEST)]);
    assert.ok(a.ok && b.ok);
    assert.equal(counts.body, 1);
    await service.body(REQUEST);
    assert.equal(counts.body, 1);
    service.flush();
    assert.ok(fs.existsSync(path.join(dir, "article-text.json")));

    // A second process (a restart) reads it back without fetching.
    let fetched = 0;
    const again = createNewsArticleService({
      dataDir: () => dir,
      readBody: async () => {
        fetched += 1;
        return BODY;
      },
      listVerdicts: async () => [],
      relationships: async () => [],
      caller: async () => ({ text: "{}", input_tokens: 0, output_tokens: 0 }),
      configured: () => true,
      language: () => "en-US",
      isLanguage: () => true,
    });
    const res = await again.body(REQUEST);
    assert.ok(res.ok);
    assert.equal(fetched, 0);
  });

  it("finds the server's verdict by article key, ignores failed ones, and holds the list for a minute", async () => {
    const { service, counts } = makeService();
    const found = await service.reading(REQUEST);
    assert.ok(found.ok && found.verdict?.event_label === "Q3 beat");
    const failed = await service.reading({ ...REQUEST, id: 8 });
    assert.ok(failed.ok && failed.verdict === null);
    const none = await service.reading({ ...REQUEST, id: 9 });
    assert.ok(none.ok && none.verdict === null);
    assert.equal(counts.verdicts, 1);
  });

  it("says so when the verdicts cannot be read", async () => {
    const { service } = makeService({ listVerdicts: async () => Promise.reject(new Error("engine down")) });
    const res = await service.reading(REQUEST);
    assert.deepEqual(res, { ok: false, error: "engine down", reason: "lookup_failed" });
  });

  it("counts a failed verdict lookup as failed, never as no verdict: no automatic model call", async () => {
    const { service, counts } = makeService({ listVerdicts: async () => Promise.reject(new Error("engine timed out")) });
    const reading = await service.reading(REQUEST);
    assert.ok(!reading.ok && reading.reason === "lookup_failed");

    // The panel's automatic request (no trigger, or `auto`) is refused before
    // the article is fetched or the model is called.
    const auto = await service.analysis(REQUEST);
    assert.ok(!auto.ok && auto.reason === "lookup_failed");
    const autoExplicit = await service.analysis({ ...REQUEST, trigger: "auto" });
    assert.ok(!autoExplicit.ok && autoExplicit.reason === "lookup_failed");
    assert.equal(counts.model, 0);
    assert.equal(counts.body, 0);

    // The reader pressed "Get Falcon's read": the model is called, once.
    const manual = await service.analysis({ ...REQUEST, trigger: "manual" });
    assert.ok(manual.ok && !manual.cached);
    assert.equal(counts.model, 1);

    // That read is cached, so even an automatic request now costs nothing.
    const again = await service.analysis(REQUEST);
    assert.ok(again.ok && again.cached);
    assert.equal(counts.model, 1);
  });

  it("treats an engine error reply as a failed lookup, and reads once the server answers with none", async () => {
    let up = false;
    const { service, counts } = makeService({
      listVerdicts: async () => {
        if (!up) throw new Error("HTTP 502 from engine");
        return [];
      },
    });
    assert.ok(!(await service.analysis(REQUEST)).ok);
    assert.equal(counts.model, 0);
    // Back up, and the server has no verdict: the automatic read runs.
    up = true;
    const res = await service.analysis(REQUEST);
    assert.ok(res.ok);
    assert.equal(counts.model, 1);
  });

  it("still reads automatically when the lookup answered with no verdict", async () => {
    const { service, counts } = makeService({ listVerdicts: async () => [] });
    const reading = await service.reading(REQUEST);
    assert.ok(reading.ok && reading.verdict === null);
    const res = await service.analysis(REQUEST);
    assert.ok(res.ok && !res.cached);
    assert.equal(counts.model, 1);
  });

  it("repairs provider mojibake in what the renderer sends", () => {
    const clean = sanitizeRequest({ id: 1, headline: "The weekâ€™s movers", summary: "CafÃ© chain", source: "SeekingAlpha" })!;
    assert.equal(clean.headline, "The week’s movers");
    assert.equal(clean.summary, "Café chain");
    assert.equal(sanitizeRequest({ id: 1, headline: "Société Générale" })!.headline, "Société Générale");
  });

  it("makes one analysis per article and language at a time, and caches it", async () => {
    const { service, counts } = makeService();
    const [a, b] = await Promise.all([service.analysis(REQUEST), service.analysis(REQUEST)]);
    assert.ok(a.ok && b.ok);
    assert.equal(counts.model, 1);
    const c = await service.analysis(REQUEST);
    assert.ok(c.ok && c.cached);
    assert.equal(counts.model, 1);

    const tr = await service.analysis({ ...REQUEST, language: "tr-TR" });
    assert.ok(tr.ok && !tr.cached);
    assert.equal(counts.model, 2);
    assert.equal(tr.ok && tr.analysis.summary[0]!.text, "Nvidia sonuçlarını açıkladı.");
    assert.equal(tr.ok && tr.analysis.language, "tr-TR");
  });

  it("does not call the model without a key, or with too little text", async () => {
    const off = makeService({ configured: () => false });
    const res = await off.service.analysis(REQUEST);
    assert.ok(!res.ok && res.reason === "unavailable");
    assert.equal(off.counts.model, 0);

    const thin = makeService({
      readBody: async () => ({ ...BODY, status: "blocked", paragraphs: [], origin: "none" }),
    });
    const res2 = await thin.service.analysis(REQUEST);
    assert.ok(!res2.ok && res2.reason === "thin");
    assert.equal(thin.counts.model, 0);
  });

  it("returns a failure (not cached) when the model's answer is unusable, so a retry runs again", async () => {
    let calls = 0;
    const { service } = makeService({
      caller: async () => {
        calls += 1;
        return { text: calls === 1 ? "oops" : JSON.stringify({ summary: [{ en: "Nvidia reported results.", translation: "" }], companies: [] }), input_tokens: 0, output_tokens: 0 };
      },
    });
    const first = await service.analysis(REQUEST);
    assert.ok(!first.ok && first.reason === "failed");
    const second = await service.analysis(REQUEST);
    assert.ok(second.ok);
    assert.equal(calls, 2);
  });
});

describe("ttl cache", () => {
  it("expires entries and evicts the oldest past the cap", () => {
    let t = 0;
    const cache = new TtlCache<number>({ dir: tempDir, file: "c.json", ttlMs: 100, maxEntries: 2, now: () => t });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("c"), 3);
    cache.set("short", 4, 10);
    t = 50;
    assert.equal(cache.get("short"), undefined);
    assert.equal(cache.get("c"), 3);
    t = 200;
    assert.equal(cache.get("c"), undefined);
    cache.flush();
  });
});
