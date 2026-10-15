import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeClassifierConfig } from "./config.js";
import { cycleBudget, feedArticleInput, planFeedLane, planHeadlines, type FeedStory } from "./feed-lane.js";
import { newsRequest, NVDA } from "./test-fixtures.js";
import type { TickerContext, Verdict } from "./types.js";

const NOW = "2026-10-15T20:00:00.000Z";
const NOW_SEC = Date.parse(NOW) / 1000;
const CONFIG = mergeClassifierConfig({ feedRequestsPerCycle: 3, tickerCap: 2 });

function story(id: number, hoursAgo: number, over: Partial<FeedStory> = {}): FeedStory {
  return {
    id,
    headline: `Nvidia signs supply deal number ${id}`,
    summary: "",
    source: "Yahoo",
    datetime: NOW_SEC - hoursAgo * 3600,
    tickers: ["NVDA"],
    ...over,
  };
}

const ctx = (t: string): TickerContext => ({ ticker: t, official_name: null, sector: null, cap_bucket: null, metadata_missing: true });

describe("feed lane", () => {
  it("sends the newest uncovered stories first, capped, skipping covered, junk and old ones", () => {
    const feed = [
      story(1, 1),
      story(2, 2),
      story(3, 3, { headline: "Why Nvidia Stock Is Up Today" }),
      story(4, 4),
      story(5, 5),
      story(6, 100),
      story(7, 0.5),
    ];
    const { lane, rest } = planFeedLane({
      feed,
      requests: [],
      covered: (key) => key === "id:7",
      tickerContext: ctx,
      config: CONFIG,
      now: NOW,
      budget: 50,
    });
    assert.deepEqual(lane.map((r) => r.article?.article_key), ["id:1", "id:2", "id:4"]);
    assert.deepEqual(rest, []);
  });

  it("never exceeds the budget", () => {
    const { lane } = planFeedLane({ feed: [story(1, 1), story(2, 2)], requests: [], covered: () => false, tickerContext: ctx, config: CONFIG, now: NOW, budget: 1 });
    assert.equal(lane.length, 1);
  });

  it("reuses the Tracker's request for the same article and keeps the rest for Base's queue", () => {
    const tracker = newsRequest("2", "Nvidia signs supply deal number 2", [NVDA]);
    const other = newsRequest("99", "Something else", [NVDA]);
    const { lane, rest } = planFeedLane({ feed: [story(2, 1)], requests: [tracker, other], covered: () => false, tickerContext: ctx, config: CONFIG, now: NOW, budget: 10 });
    assert.equal(lane[0], tracker);
    assert.deepEqual(rest, [other]);
  });

  it("builds a lead request from the story, names capped, the overflow unassessed", () => {
    const { lane } = planFeedLane({
      feed: [story(8, 1, { tickers: ["nvda", "AMD", "INTC", "NVDA"] })],
      requests: [],
      covered: () => false,
      tickerContext: ctx,
      config: CONFIG,
      now: NOW,
      budget: 10,
    });
    const r = lane[0]!;
    assert.equal(r.mode, "lead");
    assert.equal(r.kind, "news");
    assert.deepEqual(r.tickers.map((t) => t.ticker), ["NVDA", "AMD"]);
    assert.deepEqual(r.unassessed_tickers, ["INTC"]);
    assert.equal(r.syndication_scope, 3);
    assert.deepEqual(r.article, feedArticleInput(story(8, 1, { tickers: ["nvda", "AMD", "INTC", "NVDA"] })));
  });
});

function verdict(id: number, over: Partial<Verdict> = {}): Verdict {
  return {
    schema_version: 1,
    prompt_version: "cls-1.0",
    model: "m",
    article_key: `id:${id}`,
    kind: "news",
    event_type: "contract_partnership",
    event_label: "",
    syndication_scope: 1,
    tickers: [{ ticker: "NVDA", relevance: "direct", materiality: "high", direction: "positive" }],
    unassessed_tickers: [],
    status: "ok",
    metadata_missing: false,
    classified_at: NOW,
    failure_reason: null,
    ...over,
  };
}

describe("headline lane", () => {
  const texts = new Map([1, 2, 3, 4, 5, 6].map((id) => [`id:${id}`, feedArticleInput(story(id, id))]));
  texts.set("id:7", feedArticleInput(story(7, 1, { headline: "Stock Market Today: Nasdaq slips" })));
  texts.set("id:8", feedArticleInput(story(8, 200)));

  it("picks material verdicts without a headline, newest story first, capped", () => {
    const jobs = planHeadlines({
      verdicts: [
        verdict(3),
        verdict(1),
        verdict(2, { tickers: [{ ticker: "NVDA", relevance: "direct", materiality: "low", direction: "positive" }] }),
        verdict(4, { headline: { text: "x y z w", prompt_version: "hl-1.0", model: "m", written_at: NOW } }),
        verdict(5, { status: "failed" }),
        verdict(6),
        verdict(7),
        verdict(8),
        verdict(9),
      ],
      articleText: (key) => texts.get(key) ?? null,
      givenUp: (key) => key === "id:6",
      config: CONFIG,
      now: NOW,
      limit: 5,
    });
    // 2 is low, 4 has one, 5 failed, 6 given up, 7 junk, 8 too old, 9 has no text.
    assert.deepEqual(jobs.map((j) => j.article.article_key), ["id:1", "id:3"]);
    assert.deepEqual(jobs[0]!.tickers, ["NVDA"]);
  });

  it("treats an article as settled when any of its rows has a headline", () => {
    const jobs = planHeadlines({
      verdicts: [verdict(1), verdict(1, { model: "n", headline: { text: "x y z w", prompt_version: "hl-1.0", model: "n", written_at: NOW } })],
      articleText: (key) => texts.get(key) ?? null,
      givenUp: () => false,
      config: CONFIG,
      now: NOW,
      limit: 5,
    });
    assert.deepEqual(jobs, []);
  });

  it("respects the limit", () => {
    const jobs = planHeadlines({
      verdicts: [verdict(1), verdict(3)],
      articleText: (key) => texts.get(key) ?? null,
      givenUp: () => false,
      config: CONFIG,
      now: NOW,
      limit: 1,
    });
    assert.equal(jobs.length, 1);
  });
});

describe("cycle budget", () => {
  it("holds a headline reserve and keeps Base's queue off the card's daily floor", () => {
    assert.deepEqual(cycleBudget({ remaining: 500, laneSize: 30, headlineBatchPerCycle: 40, floor: 150 }), { headlineReserve: 40, baseQueue: 280 });
    assert.deepEqual(cycleBudget({ remaining: 150, laneSize: 10, headlineBatchPerCycle: 40, floor: 150 }), { headlineReserve: 40, baseQueue: 0 });
    assert.deepEqual(cycleBudget({ remaining: 20, laneSize: 30, headlineBatchPerCycle: 40, floor: 150 }), { headlineReserve: 0, baseQueue: 0 });
  });

  it("without a feed (no headlines, no floor) Base's queue gets everything, as before", () => {
    assert.deepEqual(cycleBudget({ remaining: 500, laneSize: 0, headlineBatchPerCycle: 0, floor: 0 }), { headlineReserve: 0, baseQueue: 500 });
  });
});
