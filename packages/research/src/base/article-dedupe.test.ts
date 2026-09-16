/**
 * B2 — cross-ticker article deduplication golden vectors.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { articleKey, dedupeArticles, normaliseUrl } from "./article-dedupe.js";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig } from "./config.js";
import { replayBase } from "./replay.js";
import { gapEvent, newsItem, plusHours } from "./test-fixtures.js";

const CONFIG = DEFAULT_BASE_CONFIG;
const AT = "2026-08-19T19:36:47.647Z";

describe("B2 article identity", () => {
  it("prefers article_id, then normalised URL, then (source, headline)", () => {
    const byId = newsItem("n1", AT, { article_id: "abc" });
    assert.deepEqual(articleKey(byId, CONFIG), { key: "id:abc", source: "article_id" });

    const byUrl = newsItem("n2", AT, { article_id: "", url: "https://x.test/a" });
    assert.equal(articleKey(byUrl, CONFIG)?.source, "url");

    const byHeadline = newsItem("n3", AT, { article_id: "", url: "", headline: "Hello" });
    assert.equal(articleKey(byHeadline, CONFIG)?.source, "headline");

    const nothing = newsItem("n4", AT, { article_id: "", url: "", headline: "" });
    assert.equal(articleKey(nothing, CONFIG), null);
  });

  it("normalises URLs so syndication variants collapse", () => {
    const a = normaliseUrl("https://www.Example.com/story/?utm_source=x&ref=tw", CONFIG);
    const b = normaliseUrl("http://example.com/story", CONFIG);
    assert.equal(a, b);
    assert.equal(a, "example.com/story");
    // A meaningful param survives, in sorted order.
    assert.equal(normaliseUrl("https://e.com/p?b=2&a=1&utm_x=1", CONFIG), "e.com/p?a=1&b=2");
    assert.equal(normaliseUrl("not a url", CONFIG), null);
  });

  it("is not a news_item -> no key", () => {
    assert.equal(articleKey(gapEvent("g1", AT), CONFIG), null);
  });
});

describe("B2 lead / follower assignment", () => {
  // The Gabelli 13F: one article_id landing on four tickers in the same second.
  const GABELLI = ["AAPL", "MSFT", "NVDA", "SONY"].map((ticker, i) =>
    newsItem(`g${i}`, AT, { article_id: "gabelli-13f", headline: "Gabelli 13F" }, { ticker }),
  );

  it("the Gabelli case: one lead, three followers, flagged syndicated", () => {
    const r = dedupeArticles(GABELLI, CONFIG);
    assert.equal(r.news_count, 4);
    assert.equal(r.lead_count, 1);
    assert.equal(r.follower_count, 3);
    assert.equal(r.groups.length, 1);
    const g = r.groups[0];
    assert.equal(g.lead_message_id, "g0");
    assert.deepEqual(g.message_ids, ["g0", "g1", "g2", "g3"]);
    assert.deepEqual(g.tickers, ["AAPL", "MSFT", "NVDA", "SONY"]);
    assert.equal(g.syndicated, true);
    assert.deepEqual(r.decisions.get("g0"), { role: "lead", key: g.key });
    assert.deepEqual(r.decisions.get("g3"), {
      role: "follower",
      key: g.key,
      lead_message_id: "g0",
    });
  });

  it("is deterministic across arrival order (§8)", () => {
    const shuffled = [GABELLI[2], GABELLI[0], GABELLI[3], GABELLI[1]];
    assert.deepEqual(dedupeArticles(shuffled, CONFIG), dedupeArticles(GABELLI, CONFIG));
  });

  it("two tickers is not syndicated; three is", () => {
    assert.equal(dedupeArticles(GABELLI.slice(0, 2), CONFIG).groups[0].syndicated, false);
    assert.equal(dedupeArticles(GABELLI.slice(0, 3), CONFIG).groups[0].syndicated, true);
  });

  it("distinct articles are distinct leads", () => {
    const r = dedupeArticles(
      [newsItem("a", AT, { article_id: "1" }), newsItem("b", AT, { article_id: "2" })],
      CONFIG,
    );
    assert.equal(r.lead_count, 2);
    assert.equal(r.follower_count, 0);
  });

  it("a re-arrival past the TTL is a fresh lead", () => {
    const first = newsItem("a", AT, { article_id: "1" });
    const inside = newsItem("b", plusHours(AT, 47), { article_id: "1" });
    const outside = newsItem("c", plusHours(AT, 49), { article_id: "1" });
    const r = dedupeArticles([first, inside, outside], CONFIG);
    assert.equal(r.lead_count, 2);
    assert.equal(r.decisions.get("b")?.role, "follower");
    assert.equal(r.decisions.get("c")?.role, "lead");
  });

  it("non-news and identity-less news are never deduped", () => {
    const r = dedupeArticles(
      [gapEvent("g", AT), newsItem("n", AT, { article_id: "", url: "", headline: "" })],
      CONFIG,
    );
    assert.equal(r.decisions.get("g")?.role, "none");
    assert.equal(r.decisions.get("n")?.role, "none");
    assert.equal(r.lead_count, 1); // the identity-less one still costs a request
  });

  it("can be disabled: every news_item becomes its own lead", () => {
    const off = mergeBaseConfig({ dedupe: { ...CONFIG.dedupe, enabled: false } });
    const r = dedupeArticles(GABELLI, off);
    assert.equal(r.lead_count, 4);
    assert.equal(r.follower_count, 0);
  });

  it("surfaces through the replay summary", () => {
    const { summary, article_groups } = replayBase(GABELLI, { config: CONFIG, now: AT });
    assert.equal(summary.dedupe.news_messages, 4);
    assert.equal(summary.dedupe.classifier_requests, 1);
    assert.equal(summary.dedupe.requests_saved, 3);
    assert.equal(summary.dedupe.syndicated_articles, 1);
    assert.equal(summary.dedupe.by_key_source.article_id, 4);
    // Four incidents (one per ticker) still each route to the classifier;
    // dedupe collapses the *requests*, not the incidents.
    assert.equal(summary.by_destination.classifier, 4);
    assert.equal(article_groups.length, 1);
  });
});
