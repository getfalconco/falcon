import type { EventDirection, EventType, EventsPollStatus } from "./news-events";

/**
 * Desktop-side mirror of the news feed the engine answers on `news:feed`.
 * Keep in sync with packages/research/src/news/article-store.ts.
 */

export type NewsFeedEvent = {
  material: boolean;
  event_type: EventType;
  affected_ticker: string;
  direction: EventDirection;
  summary: string;
  confidence: number;
};

export type NewsFeedArticle = {
  id: number;
  headline: string;
  summary: string;
  url: string;
  source: string;
  /** Published, unix seconds. */
  datetime: number;
  /** The tracked names the story was fetched for. */
  tickers: string[];
  /** The classifier's reading, or null while the story is unread. */
  event: NewsFeedEvent | null;
  first_seen: string;
  /** Sectors of `tickers`, per the engine's company table; empty when unknown. */
  sectors: string[];
};

export type NewsFeedResult =
  | { ok: true; articles: NewsFeedArticle[]; status: EventsPollStatus }
  | { ok: false; error: string };

/** What `news:feed` is asked with; the cache keys on exactly these two. */
export type NewsFeedOptions = { days?: number; limit?: number };

/**
 * The last good feed the main process holds for a request (in memory, or read
 * back from disk after a restart), with when it was fetched. Answered locally
 * on `news:feed-cached` and never forwarded to the engine, so it costs no
 * network: it is what the card shows while the real request is out.
 */
export type NewsFeedCachedResult =
  | { ok: true; articles: NewsFeedArticle[]; status: EventsPollStatus; fetchedAt: number }
  | { ok: false; error: string };
