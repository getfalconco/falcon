import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ADVICE_WORDS, RISK_SENTENCE_WORDS, bannedWordHits, copyProblems, EM_DASH, EN_DASH } from "../../../shared/copy-rules";
import { articleRequest, panelRead, serverReading, sourceName, storyNames } from "../../lib/news-article";
import * as dashboard from "../../lib/i18n/messages/areas/dashboard";
import type { NewsFeedArticle } from "../../../shared/news-feed";
import type { ClassifierVerdict } from "../../../shared/classifier-types";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ARTICLE: NewsFeedArticle = {
  id: 11,
  headline: "Chipmakers slide",
  summary: "",
  url: "https://www.example.com/a",
  source: "",
  datetime: 1_760_000_000,
  tickers: ["amd", "NVDA", "INTC"],
  event: null,
  first_seen: "2026-10-11T00:00:00Z",
  sectors: [],
};

function verdict(tickers: ClassifierVerdict["tickers"], status: "ok" | "failed" = "ok"): ClassifierVerdict {
  return {
    schema_version: 1,
    prompt_version: "p",
    model: "m",
    article_key: "id:11",
    kind: "news",
    event_type: "regulatory_decision",
    event_label: "Export review widens",
    syndication_scope: 3,
    tickers,
    unassessed_tickers: [],
    status,
    metadata_missing: false,
    classified_at: "2026-10-11T00:00:00Z",
    failure_reason: null,
  };
}

describe("news article panel: decisions", () => {
  it("lists the story's names with the affected one first, once each", () => {
    const withEvent = { ...ARTICLE, event: { material: true, event_type: "regulatory" as const, affected_ticker: "nvda", direction: "negative" as const, summary: "", confidence: 0.8 } };
    assert.deepEqual(storyNames(withEvent), ["NVDA", "AMD", "INTC"]);
    assert.deepEqual(articleRequest(withEvent).tickers, ["NVDA", "AMD", "INTC"]);
  });

  it("names the publisher by the feed's source, else the page's host", () => {
    assert.equal(sourceName("Reuters", "https://x.com"), "Reuters");
    assert.equal(sourceName("", "https://www.example.com/a"), "example.com");
    assert.equal(sourceName("", "not a url"), "");
  });

  it("uses the classifier's verdict first, direct names before indirect, unrelated apart", () => {
    const reading = serverReading(
      verdict([
        { ticker: "AMD", relevance: "indirect", materiality: "standard", direction: "negative" },
        { ticker: "NVDA", relevance: "direct", materiality: "high", direction: "negative" },
        { ticker: "INTC", relevance: "none" },
      ]),
      ARTICLE,
    );
    assert.ok(reading && reading.kind === "verdict");
    assert.deepEqual(reading.related.map((r) => r.ticker), ["NVDA", "AMD"]);
    assert.deepEqual(reading.unrelated, ["INTC"]);
  });

  it("falls back to the feed's material event, and to nothing (Falcon's read) without either", () => {
    const material = { ...ARTICLE, event: { material: true, event_type: "earnings" as const, affected_ticker: "AMD", direction: "positive" as const, summary: "", confidence: 0.9 } };
    assert.equal(serverReading(null, material)?.kind, "feed");
    assert.equal(serverReading(verdict([], "failed"), ARTICLE), null);
    assert.equal(serverReading(null, { ...ARTICLE, event: { ...material.event, material: false } }), null);
  });

  it("asks for Falcon's read on its own only when the lookup answered with no verdict", () => {
    assert.equal(panelRead({ state: "loading" }, ARTICLE).kind, "pending");
    assert.equal(panelRead({ state: "ready", verdict: null }, ARTICLE).kind, "falcon");
    assert.equal(panelRead({ state: "ready", verdict: verdict([], "failed") }, ARTICLE).kind, "falcon");
    const found = panelRead(
      { state: "ready", verdict: verdict([{ ticker: "NVDA", relevance: "direct", materiality: "high", direction: "negative" }]) },
      ARTICLE,
    );
    assert.ok(found.kind === "server" && found.reading.kind === "verdict");
  });

  it("never asks for a read on its own when the lookup failed: the feed's reading, else unavailable", () => {
    const material = { ...ARTICLE, event: { material: true, event_type: "earnings" as const, affected_ticker: "AMD", direction: "positive" as const, summary: "", confidence: 0.9 } };
    const feed = panelRead({ state: "failed" }, material);
    assert.ok(feed.kind === "server" && feed.reading.kind === "feed");
    assert.equal(panelRead({ state: "failed" }, ARTICLE).kind, "unavailable");
    assert.equal(panelRead({ state: "failed" }, { ...ARTICLE, event: { ...material.event, material: false } }).kind, "unavailable");
  });
});

describe("news article panel: copy", () => {
  it("has no dash or banned word in its source copy", () => {
    for (const file of ["NewsArticleModal.tsx"]) {
      const src = fs.readFileSync(path.join(HERE, file), "utf8");
      assert.deepEqual(copyProblems(src, { jsxText: true }), [], file);
    }
  });

  it("keeps the panel's messages to the house rules in every language", () => {
    const tables = Object.entries(dashboard).filter(([, v]) => v && typeof v === "object") as Array<[string, Record<string, string>]>;
    assert.ok(tables.length >= 10);
    for (const [lang, table] of tables) {
      for (const [key, text] of Object.entries(table)) {
        if (!key.startsWith("dashboard.newsArticle.")) continue;
        assert.ok(!text.includes(EM_DASH) && !text.includes(EN_DASH), `${lang} ${key}`);
        assert.ok(!text.includes("!") && !text.includes("！"), `${lang} ${key}`);
        if (lang === "en") {
          assert.deepEqual(bannedWordHits(text, [...ADVICE_WORDS, ...RISK_SENTENCE_WORDS]), [], key);
        }
      }
    }
  });
});
