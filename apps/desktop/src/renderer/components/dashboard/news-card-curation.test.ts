import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NewsStoryList from "./NewsStoryList";
import { curatedStories, storiesInView, storyTickers, type CuratedStory } from "../../lib/news-curation";
import { panelTitles, storyNames } from "../../lib/news-article";
import * as dashboard from "../../lib/i18n/messages/areas/dashboard";
import { textProblems } from "../../../shared/copy-rules";
import type { NewsFeedArticle, NewsFeedFalcon } from "../../../shared/news-feed";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW_SEC = 1_760_500_000;

function falcon(over: Partial<NewsFeedFalcon> = {}): NewsFeedFalcon {
  return {
    decision: "show",
    reason: "material",
    headline: "Nvidia agrees to supply CoreWeave with data center chips",
    headline_source: "falcon",
    article_key: "id:1",
    event_type: "contract_partnership",
    materiality: "high",
    direction: "positive",
    tickers: ["NVDA"],
    primary: null,
    duplicate_of: null,
    ...over,
  };
}

function story(id: number, over: Partial<NewsFeedArticle> = {}): NewsFeedArticle {
  return {
    id,
    headline: "Nvidia SHOCKS Wall Street With Mega Deal, Here's Why You Should Care",
    summary: "Nvidia agreed to supply CoreWeave.",
    url: `https://example.com/${id}`,
    source: "Yahoo",
    datetime: NOW_SEC - 600,
    tickers: ["NVDA", "AMD", "INTC"],
    event: null,
    first_seen: "2026-10-15T00:00:00Z",
    sectors: ["Semiconductors"],
    falcon: falcon({ article_key: `id:${id}` }),
    ...over,
  };
}

describe("news card: which stories show", () => {
  it("lists only stories the engine marked to show, with a title", () => {
    const feed = [
      story(1),
      story(2, { falcon: falcon({ decision: "pending", reason: "unclassified", headline: null }) }),
      story(3, { falcon: falcon({ decision: "hide", reason: "not_material", headline: null }) }),
      story(4, { falcon: falcon({ decision: "hide", reason: "duplicate", duplicate_of: 1 }) }),
      story(5, { falcon: falcon({ decision: "hide", reason: "junk", headline: null }) }),
      story(6, { falcon: falcon({ decision: "show", headline: "  " }) }),
      story(7, { falcon: falcon({ decision: "show", reason: "primary_source", headline: "NVIDIA Corp files Form 8-K", headline_source: "primary", primary: "sec_filing", tickers: [] }) }),
    ];
    assert.deepEqual(curatedStories(feed).map((a) => a.id), [1, 7]);
  });

  it("holds back every story from an engine that sends no decision (the publisher's line is never a title)", () => {
    assert.deepEqual(curatedStories([story(1, { falcon: undefined })]), []);
  });

  it("names the material tickers, else the ones a primary source was filed under", () => {
    assert.deepEqual(storyTickers(story(1)), ["NVDA"]);
    assert.deepEqual(storyTickers(story(7, { tickers: ["nvda"], falcon: falcon({ tickers: [] }) })), ["NVDA"]);
  });
});

describe("news card: views and search run over the curated set", () => {
  const stories = curatedStories([
    story(1),
    story(2, {
      sectors: ["Software"],
      tickers: ["MSFT", "NVDA"],
      falcon: falcon({ headline: "Microsoft cuts 3% of its workforce", tickers: ["MSFT"], event_type: "management_governance", direction: "negative" }),
    }),
  ]);
  const view = { scope: "market" as const, sector: null, held: [] as string[], query: "" };

  it("Positions keeps stories material for a held name, not every name mentioned", () => {
    assert.deepEqual(storiesInView(stories, { ...view, scope: "positions", held: ["msft"] }).map((a) => a.id), [2]);
    // NVDA is mentioned on story 2 but the story is not material for it.
    assert.deepEqual(storiesInView(stories, { ...view, scope: "positions", held: ["NVDA"] }).map((a) => a.id), [1]);
  });

  it("Sector filters by the story's sectors", () => {
    assert.deepEqual(storiesInView(stories, { ...view, scope: "sector", sector: "Software" }).map((a) => a.id), [2]);
  });

  it("search matches Falcon's title, not the publisher's hidden headline", () => {
    assert.deepEqual(storiesInView(stories, { ...view, query: "workforce" }).map((a) => a.id), [2]);
    assert.deepEqual(storiesInView(stories, { ...view, query: "shocks" }).map((a) => a.id), []);
    assert.deepEqual(storiesInView(stories, { ...view, query: "msft" }).map((a) => a.id), [2]);
  });
});

describe("news card: rendering", () => {
  it("renders Falcon's headline as the row title and never the publisher's", () => {
    const html = renderToStaticMarkup(
      createElement(NewsStoryList, { stories: curatedStories([story(1)]) as CuratedStory[], now: NOW_SEC * 1000, onOpen: () => {} }),
    );
    assert.match(html, /Nvidia agrees to supply CoreWeave with data center chips/);
    assert.doesNotMatch(html, /SHOCKS/);
    assert.match(html, /Yahoo/);
    // The lead name's direction colours the event type; only material names get a chip.
    assert.match(html, /text-tone-positive/);
    assert.match(html, />NVDA</);
    assert.doesNotMatch(html, />AMD</);
  });

  it("renders a primary source under its neutral line, with the names it was filed under", () => {
    const filing = story(7, {
      source: "SEC",
      tickers: ["NVDA"],
      falcon: falcon({ reason: "primary_source", headline: "NVIDIA Corp files Form 8-K", headline_source: "primary", primary: "sec_filing", tickers: [], event_type: null, direction: null }),
    });
    const html = renderToStaticMarkup(createElement(NewsStoryList, { stories: curatedStories([filing]), now: NOW_SEC * 1000, onOpen: () => {} }));
    assert.match(html, /NVIDIA Corp files Form 8-K/);
    assert.match(html, />NVDA</);
  });
});

describe("news article panel: titles", () => {
  it("titles the panel with Falcon's headline and keeps the publisher's as the quiet source line", () => {
    assert.deepEqual(panelTitles(story(1)), {
      title: "Nvidia agrees to supply CoreWeave with data center chips",
      sourceTitle: "Nvidia SHOCKS Wall Street With Mega Deal, Here's Why You Should Care",
    });
  });

  it("falls back to the publisher's headline only when there is no Falcon title, and never repeats it", () => {
    assert.deepEqual(panelTitles(story(1, { falcon: undefined })), { title: story(1).headline, sourceTitle: null });
    assert.deepEqual(panelTitles(story(1, { headline: "nvidia agrees to supply coreweave with data center chips" })).sourceTitle, null);
  });

  it("lists the material names first", () => {
    assert.deepEqual(storyNames(story(1, { tickers: ["AMD", "NVDA"] })), ["NVDA", "AMD"]);
  });
});

describe("news card: copy", () => {
  it("the new lines follow the copy rules and are translated in every language with the same placeholders", () => {
    const keys = ["dashboard.news.nothingMaterial", "dashboard.newsArticle.sourceTitle"] as const;
    const tables = Object.entries(dashboard).filter(([, v]) => v && typeof v === "object") as Array<[string, Record<string, string>]>;
    assert.equal(tables.length, 10);
    for (const key of keys) {
      assert.deepEqual(textProblems(dashboard.en[key]), [], key);
      for (const [lang, table] of tables) {
        const text = table[key];
        assert.ok(typeof text === "string" && text.trim() !== "", `${lang} ${key}`);
        assert.ok(!/[–—]/.test(text), `${lang} ${key} has a dash`);
        assert.equal(text.includes("{title}"), key === "dashboard.newsArticle.sourceTitle", `${lang} ${key}`);
      }
    }
  });

  it("the row component carries no copy of its own", () => {
    const src = fs.readFileSync(path.join(HERE, "NewsStoryList.tsx"), "utf8");
    assert.doesNotMatch(src, /a\.headline\b/, "the publisher's headline must not be a row title");
  });
});
