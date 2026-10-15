import type { EventDirection, EventType, EventsPollStatus } from "./news-events";
import type { ClassifierDirection, ClassifierEventType, ClassifierMateriality } from "./classifier-types";

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

/**
 * Whether the card shows a story and under which title, decided on the
 * engine from the classifier's verdict. Mirrors `NewsCuration` in
 * packages/research/src/news/curation.ts, where the threshold is documented.
 */
export type NewsFeedFalcon = {
  decision: "show" | "hide" | "pending";
  reason:
    | "material"
    | "primary_source"
    | "not_material"
    | "junk"
    | "duplicate"
    | "unclassified"
    | "failed"
    | "awaiting_headline";
  /** The row title Falcon wrote (or the neutral primary-source line); null unless shown. */
  headline: string | null;
  headline_source: "falcon" | "label" | "primary" | null;
  article_key: string;
  event_type: ClassifierEventType | null;
  materiality: ClassifierMateriality | null;
  direction: ClassifierDirection | null;
  /** The names the story is material for, strongest first. */
  tickers: string[];
  primary: "sec_filing" | "press_release" | null;
  duplicate_of: number | null;
};

export type NewsFeedArticle = {
  id: number;
  /** The publisher's headline: shown only inside the article panel, as the source's title. */
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
  /** The engine's decision for the card; absent from an engine that predates it. */
  falcon?: NewsFeedFalcon;
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
