import type { NewsFeedArticle } from "../../shared/news-feed";
import type { NewsArticleRequest } from "../../shared/news-article";
import type { ClassifierTickerVerdict, ClassifierVerdict } from "../../shared/classifier-types";

/**
 * The bits of the news panel that are decisions rather than layout, kept
 * apart so they read (and test) on their own.
 */

/** Names on a story, the one the classifier says it moves first. */
export function storyNames(a: Pick<NewsFeedArticle, "event" | "tickers">): string[] {
  const out: string[] = [];
  const affected = a.event?.affected_ticker?.trim().toUpperCase();
  if (affected) out.push(affected);
  for (const t of a.tickers) {
    const name = t.trim().toUpperCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** What the main process is asked with: the feed row, names in reading order. */
export function articleRequest(a: NewsFeedArticle): NewsArticleRequest {
  return {
    id: a.id,
    headline: a.headline,
    summary: a.summary,
    url: a.url,
    source: a.source,
    datetime: a.datetime,
    tickers: storyNames(a),
  };
}

/** The publisher's name for "Read at {source}": the feed's, else the page's host. */
export function sourceName(source: string, url: string): string {
  if (source.trim()) return source.trim();
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export type ServerReading =
  | { kind: "verdict"; verdict: ClassifierVerdict; related: Extract<ClassifierTickerVerdict, { relevance: "direct" | "indirect" }>[]; unrelated: string[] }
  | { kind: "feed"; event: NonNullable<NewsFeedArticle["event"]> }
  | null;

/**
 * What the server already made of the story: the classifier's verdict when
 * it has one for this article, else the feed's own material reading. Null
 * means nothing; `panelRead` decides what stands in for it.
 */
export function serverReading(verdict: ClassifierVerdict | null, article: Pick<NewsFeedArticle, "event">): ServerReading {
  if (verdict && verdict.status === "ok" && verdict.tickers.length > 0) {
    const related = verdict.tickers.filter(
      (t): t is Extract<ClassifierTickerVerdict, { relevance: "direct" | "indirect" }> => t.relevance !== "none",
    );
    related.sort((a, b) => (a.relevance === b.relevance ? 0 : a.relevance === "direct" ? -1 : 1));
    const unrelated = verdict.tickers.filter((t) => t.relevance === "none").map((t) => t.ticker);
    return { kind: "verdict", verdict, related, unrelated };
  }
  if (article.event?.material) return { kind: "feed", event: article.event };
  return null;
}

/** Where the panel's verdict lookup stands. */
export type ReadingLookup =
  | { state: "loading" }
  | { state: "ready"; verdict: ClassifierVerdict | null }
  | { state: "failed" };

/**
 * What the panel's top card shows, given the verdict lookup.
 *   pending      the lookup is still out
 *   server       the classifier's verdict, or the feed's material reading
 *   falcon       the lookup answered and the server has nothing: Falcon's
 *                read is asked for automatically
 *   unavailable  the lookup failed and the feed has no reading: the server
 *                may well have one, so no paid read is made on its own; the
 *                reader can ask for one
 */
export type PanelRead =
  | { kind: "pending" }
  | { kind: "server"; reading: NonNullable<ServerReading> }
  | { kind: "falcon" }
  | { kind: "unavailable" };

export function panelRead(lookup: ReadingLookup, article: Pick<NewsFeedArticle, "event">): PanelRead {
  if (lookup.state === "loading") return { kind: "pending" };
  const reading = serverReading(lookup.state === "ready" ? lookup.verdict : null, article);
  if (reading) return { kind: "server", reading };
  return lookup.state === "failed" ? { kind: "unavailable" } : { kind: "falcon" };
}
