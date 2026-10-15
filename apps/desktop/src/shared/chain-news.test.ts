import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chainNews, chainPaths, chainTitle, mentionsStock, recencyWeight, shortName } from "./chain-news.js";
import { extractEgo, normalizeLinks, type RawGraphEdge } from "./stock-graph.js";
import type { NewsFeedArticle } from "./news-feed.js";

const URL = "https://www.sec.gov/Archives/edgar/data/1/x.htm";
const NOW = 1_800_000_000;

function edge(root: string, cp: string, category: string, tier: "critical" | "important" | "marginal" = "important"): RawGraphEdge {
  return {
    root_ticker: root,
    counterparty_id: cp,
    counterparty_ticker: cp,
    counterparty_name: cp === "NVDA" ? "NVIDIA Corporation" : `${cp} Holdings`,
    category,
    subtype: "",
    strength: { critical: 1, important: 0.6, marginal: 0.3 }[tier],
    strength_tier: tier,
    confidence: 0.9,
    evidence_quote: "quote",
    source_url: URL,
  };
}

/** TSM supplies NVDA (critical); ASML supplies TSM (critical); AMD competes with NVDA (marginal). */
const EDGES = [
  edge("NVDA", "TSM", "supplier", "critical"),
  edge("TSM", "ASML", "supplier", "critical"),
  edge("NVDA", "AMD", "competitor", "marginal"),
  edge("AMD", "INTC", "competitor", "marginal"),
];

function graph() {
  const { links, names } = normalizeLinks(EDGES, { minConfidence: 0.5 });
  return extractEgo(links, names, "NVDA");
}

function story(id: number, tickers: string[], headline: string, hoursAgo = 1, extra: Partial<NewsFeedArticle> = {}): NewsFeedArticle {
  return {
    id,
    headline,
    summary: "",
    url: `https://example.com/${id}`,
    source: "Reuters",
    datetime: NOW - hoursAgo * 3600,
    tickers,
    event: null,
    first_seen: "",
    sectors: [],
    ...extra,
  };
}

describe("chainPaths", () => {
  it("writes the path out with each node's role towards the next", () => {
    const paths = chainPaths(graph());
    const tsm = paths.get("TSM")!;
    assert.equal(tsm.hops, 1);
    assert.deepEqual(tsm.nodes, ["TSM", "NVDA"]);
    assert.equal(tsm.steps[0]!.role, "supplier");

    const asml = paths.get("ASML")!;
    assert.equal(asml.hops, 2);
    assert.deepEqual(asml.nodes, ["ASML", "TSM", "NVDA"]);
    assert.deepEqual(asml.steps.map((s) => s.role), ["supplier", "supplier"]);

    assert.equal(paths.get("AMD")!.steps[0]!.role, "competitor");
    assert.equal(paths.has("NVDA"), false);
  });

  it("scores a path by its weakest link and discounts the second hop", () => {
    const paths = chainPaths(graph());
    assert.equal(paths.get("TSM")!.score, 1);
    assert.ok(paths.get("ASML")!.score < paths.get("TSM")!.score);
    assert.ok(paths.get("INTC")!.score < paths.get("ASML")!.score);
  });
});

describe("mentionsStock", () => {
  it("catches the stock in tickers, by symbol and by short name", () => {
    assert.equal(mentionsStock(story(1, ["NVDA"], "x"), "NVDA", null), true);
    assert.equal(mentionsStock(story(1, ["TSM"], "TSMC ships to $NVDA"), "NVDA", null), true);
    assert.equal(mentionsStock(story(1, ["TSM"], "Nvidia orders more wafers"), "NVDA", "NVIDIA Corporation"), true);
    assert.equal(mentionsStock(story(1, ["TSM"], "TSMC raises prices"), "NVDA", "NVIDIA Corporation"), false);
    assert.equal(shortName("AMD Inc."), null, "a three letter word stands for too much");
  });
});

describe("chainNews", () => {
  it("keeps stories that reach the stock only through the graph", () => {
    const rows = chainNews(
      [
        story(1, ["TSM"], "TSMC raises wafer prices"),
        story(2, ["NVDA"], "Nvidia results"),
        story(3, ["ASML"], "ASML ships new tools"),
        story(4, ["ORCL"], "Oracle cloud deal"),
      ],
      graph(),
      { now: NOW },
    );
    assert.deepEqual(rows.map((r) => r.article.id), [1, 3]);
    assert.equal(rows[0]!.via, "TSM");
    assert.deepEqual(rows[1]!.path.nodes, ["ASML", "TSM", "NVDA"]);
  });

  it("ranks by hop, strength and recency together", () => {
    const rows = chainNews(
      [
        story(1, ["AMD"], "AMD launches a chip", 60),
        story(2, ["ASML"], "ASML ships new tools", 1),
        story(3, ["TSM"], "TSMC raises wafer prices", 2),
      ],
      graph(),
      { now: NOW },
    );
    assert.deepEqual(rows.map((r) => r.article.id), [3, 2, 1]);
  });

  it("dedupes by id, engine duplicate, URL and title, and caps the list", () => {
    const base = story(1, ["TSM"], "TSMC raises wafer prices");
    const rows = chainNews(
      [
        base,
        story(2, ["TSM"], "TSMC raises wafer prices!"),
        story(3, ["TSM"], "Other", 1, { url: base.url }),
        story(4, ["TSM"], "Copy", 1, {
          falcon: {
            decision: "show",
            reason: "material",
            headline: "Copy",
            headline_source: "falcon",
            article_key: "",
            event_type: null,
            materiality: null,
            direction: null,
            tickers: ["TSM"],
            primary: null,
            duplicate_of: 1,
          },
        }),
        ...Array.from({ length: 20 }, (_, i) => story(100 + i, ["TSM"], `Story ${i}`)),
      ],
      graph(),
      { now: NOW },
    );
    const ids = rows.map((r) => r.article.id);
    assert.equal(ids.filter((id) => id === 1 || id === 2 || id === 3 || id === 4).length, 1);
    assert.equal(rows.length, 10);
  });

  it("uses Falcon's title when there is one and leaves hidden stories out", () => {
    const falcon = (decision: "show" | "hide", headline: string | null) => ({
      decision,
      reason: "material" as const,
      headline,
      headline_source: "falcon" as const,
      article_key: "",
      event_type: null,
      materiality: null,
      direction: null,
      tickers: ["TSM"],
      primary: null,
      duplicate_of: null,
    });
    const shown = story(1, ["TSM"], "Publisher line", 1, { falcon: falcon("show", "TSMC raises wafer prices") });
    const hidden = story(2, ["TSM"], "Junk", 1, { falcon: falcon("hide", null) });
    assert.equal(chainTitle(shown), "TSMC raises wafer prices");
    assert.equal(chainTitle(story(3, [], "Publisher line")), "Publisher line");
    const rows = chainNews([shown, hidden], graph(), { now: NOW });
    assert.deepEqual(rows.map((r) => r.title), ["TSMC raises wafer prices"]);
  });

  it("is empty for a stock with no graph", () => {
    const { links, names } = normalizeLinks(EDGES);
    const empty = extractEgo(links, names, "QQQQ");
    assert.deepEqual(chainNews([story(1, ["TSM"], "x")], empty, { now: NOW }), []);
  });
});

describe("recencyWeight", () => {
  it("halves a day", () => {
    assert.equal(recencyWeight(0), 1);
    assert.equal(recencyWeight(24 * 3600), 0.5);
  });
});
