/**
 * The News card's two lanes inside a classifier cycle, as pure planning.
 *
 * Feed lane: the card shows only stories with a verdict (news/curation.ts),
 * so a story in the feed that the Tracker's stream never carried would never
 * show. Before the budget is spread over Base's requests, the cycle classifies
 * the feed's uncovered stories, newest first, capped per cycle. A Tracker
 * request for the same article is used as is (it carries Base's ticker set)
 * rather than sent twice. Stories whose headline is a roundup, a list or a
 * recap (`junkReason`) are never sent: the card hides them whatever the
 * verdict, so the call would buy nothing.
 *
 * Headline lane: verdicts that clear the card's bar and have no Falcon
 * headline yet, newest story first, capped per cycle. Old verdicts are
 * backfilled the same way, a cycle at a time, never all at once.
 *
 * Both lanes spend from the classifier's one daily budget.
 */

import type { NewsArticle } from "../news/article-store.js";
import { isMaterialVerdict, junkReason, materialEntries } from "../news/curation.js";
import type { ClassifierConfig } from "./config.js";
import type { ArticleInput, ClassificationRequest, TickerContext, Verdict } from "./types.js";

/** What the lanes need of a feed story. */
export type FeedStory = Pick<NewsArticle, "id" | "headline" | "summary" | "source" | "datetime" | "tickers">;

function keyOf(r: ClassificationRequest): string {
  return r.article?.article_key ?? r.filing?.article_key ?? "";
}

function insideWindow(publishedMs: number, nowMs: number, hours: number): boolean {
  return Number.isFinite(publishedMs) && nowMs - publishedMs <= hours * 3_600_000;
}

export function feedArticleInput(story: FeedStory): ArticleInput {
  return {
    article_key: `id:${story.id}`,
    headline: story.headline ?? "",
    summary: story.summary ?? "",
    source: story.source ?? "",
    published_at: new Date(story.datetime * 1000).toISOString(),
    article_id: String(story.id),
  };
}

/**
 * Split the cycle's requests into the feed lane (sent first) and the rest
 * (Base's priority queue). `covered(key)` is true when any usable verdict, or
 * a permanent failure, already stands for the article.
 */
export function planFeedLane(options: {
  feed: FeedStory[];
  requests: ClassificationRequest[];
  covered: (articleKey: string) => boolean;
  tickerContext: (ticker: string) => TickerContext;
  config: Pick<ClassifierConfig, "feedRequestsPerCycle" | "feedWindowHours" | "tickerCap">;
  now: string;
  /** Requests the budget allows this cycle in total. */
  budget: number;
}): { lane: ClassificationRequest[]; rest: ClassificationRequest[] } {
  const { config } = options;
  const nowMs = Date.parse(options.now);
  const cap = Math.max(0, Math.min(config.feedRequestsPerCycle, options.budget));
  const byKey = new Map(options.requests.map((r) => [keyOf(r), r]));
  const taken = new Set<string>();
  const lane: ClassificationRequest[] = [];

  const stories = [...options.feed]
    .filter((s) => Number.isFinite(s.id) && s.id > 0 && s.tickers.length > 0)
    .filter((s) => insideWindow(s.datetime * 1000, nowMs, config.feedWindowHours))
    .sort((a, b) => b.datetime - a.datetime || b.id - a.id);

  for (const story of stories) {
    if (lane.length >= cap) break;
    const key = `id:${story.id}`;
    if (taken.has(key) || options.covered(key) || junkReason(story.headline ?? "")) continue;
    taken.add(key);
    const existing = byKey.get(key);
    if (existing) {
      lane.push(existing);
      continue;
    }
    const names = [...new Set(story.tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
    const limit = Math.max(1, config.tickerCap);
    const assessed = names.slice(0, limit);
    lane.push({
      request_id: `${key}|lead|${assessed.join(",")}`,
      kind: "news",
      mode: "lead",
      article: feedArticleInput(story),
      filing: null,
      tickers: assessed.map((t) => options.tickerContext(t)),
      unassessed_tickers: names.slice(limit),
      syndication_scope: names.length,
      requested_at: options.now,
    });
  }
  const rest = options.requests.filter((r) => !taken.has(keyOf(r)));
  return { lane, rest };
}

/** One headline to write: the verdict's article, and the names it is material for. */
export type HeadlineJob = { article: ArticleInput; tickers: string[]; published_ms: number };

/**
 * The verdicts that need a Falcon headline, newest story first, at most
 * `limit`: ok, clearing the card's bar, no headline yet, the article's text at
 * hand, published inside the window, not junk by shape, and not given up on.
 */
export function planHeadlines(options: {
  verdicts: Verdict[];
  articleText: (articleKey: string) => ArticleInput | null;
  givenUp: (articleKey: string) => boolean;
  config: Pick<ClassifierConfig, "feedWindowHours">;
  now: string;
  limit: number;
}): HeadlineJob[] {
  const nowMs = Date.parse(options.now);
  const seen = new Set<string>();
  const jobs: HeadlineJob[] = [];
  for (const v of options.verdicts) {
    if (seen.has(v.article_key)) continue;
    if (v.kind !== "news" || v.status !== "ok") continue;
    // Any row for the article already carrying a headline settles it.
    if (v.headline) {
      seen.add(v.article_key);
      continue;
    }
    if (!isMaterialVerdict(v) || options.givenUp(v.article_key)) continue;
    const article = options.articleText(v.article_key);
    if (!article || junkReason(article.headline)) continue;
    const published = Date.parse(article.published_at);
    if (!insideWindow(published, nowMs, options.config.feedWindowHours)) continue;
    seen.add(v.article_key);
    jobs.push({
      article,
      tickers: materialEntries(v).map((t) => t.ticker.toUpperCase()),
      published_ms: published,
    });
  }
  // A verdict listed later for the same article may carry the headline: drop
  // jobs whose article turned out to be settled.
  const settled = new Set(options.verdicts.filter((v) => v.headline).map((v) => v.article_key));
  return jobs
    .filter((j) => !settled.has(j.article.article_key))
    .sort((a, b) => b.published_ms - a.published_ms)
    .slice(0, Math.max(0, options.limit));
}

/**
 * How a cycle's remaining budget is split after the feed lane took its share:
 * a per-cycle reserve for headlines, and what Base's priority queue may
 * spend, which never dips into the day's last `floor` units (the card's
 * reserve, `feedDailyReserve`).
 */
export function cycleBudget(options: {
  remaining: number;
  laneSize: number;
  headlineBatchPerCycle: number;
  floor: number;
}): { headlineReserve: number; baseQueue: number } {
  const afterLane = Math.max(0, options.remaining - options.laneSize);
  const headlineReserve = Math.min(Math.max(0, options.headlineBatchPerCycle), afterLane);
  const baseQueue = Math.max(0, afterLane - headlineReserve - Math.max(0, options.floor));
  return { headlineReserve, baseQueue };
}
