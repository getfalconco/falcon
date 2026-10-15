import type { ClassifierVerdict } from "./classifier-types";

/**
 * The news article panel's contracts: what the renderer asks the main process
 * for when a reader opens a story, and what comes back.
 *
 * Three questions, three channels, all answered in main (the renderer never
 * fetches a publisher page and never sees a provider key):
 *   news:article          the article's text, from the feed or the publisher
 *   news:article-reading  what the server's classifier already ruled on it
 *   news:article-analysis Falcon's own short read, made on demand when the
 *                         server has none
 */

/** The story as the panel knows it: the feed row, nothing more. */
export type NewsArticleRequest = {
  /** The provider's id (Finnhub), which is also the classifier's article key `id:<id>`. */
  id: number;
  headline: string;
  /** The provider's summary; often a sentence or two, sometimes empty. */
  summary: string;
  url: string;
  source: string;
  /** Published, unix seconds. */
  datetime: number;
  tickers: string[];
};

/**
 * How much of the article the panel can show.
 *   full     readable text from the publisher's page (or a provider body)
 *   summary  only the provider's summary; the page gave nothing usable
 *   paywall  the publisher marks the story as paid; nothing is shown
 *   blocked  the publisher refused the request (403, 429, a bot wall)
 *   empty    the page answered but held no article text, and there is no summary
 *   error    the page could not be reached (timeout, network, too large)
 */
export type NewsArticleBodyStatus = "full" | "summary" | "paywall" | "blocked" | "empty" | "error";

export type NewsArticleBody = {
  status: NewsArticleBodyStatus;
  /** Paragraphs in reading order; empty for paywall / blocked / empty / error. */
  paragraphs: string[];
  /** True when the text was cut at the cache's size cap. */
  truncated: boolean;
  /** Where the text came from. */
  origin: "provider" | "publisher" | "none";
  /** The page the text was read from, after redirects (for "Read at {source}"). */
  finalUrl: string;
  fetchedAt: number;
};

export type NewsArticleBodyResult = { ok: true; body: NewsArticleBody } | { ok: false; error: string };

/**
 * The server's classifier verdict for this article, when it made one.
 *   ok, verdict    the lookup answered and the server has ruled on the article
 *   ok, null       the lookup answered and the server has no verdict for it
 *   not ok         the lookup failed (`lookup_failed`: engine out of reach,
 *                  timeout, an error reply) or the request was unusable. A
 *                  failed lookup says nothing about whether a verdict exists,
 *                  so it never stands for "no verdict".
 */
export type NewsArticleReadingResult =
  | { ok: true; verdict: ClassifierVerdict | null }
  | { ok: false; error: string; reason?: "lookup_failed" | "bad_request" };

export type NewsAnalysisRequest = NewsArticleRequest & {
  /** The UI language (a LanguageCode such as "tr-TR"); main falls back to its own. */
  language?: string;
  /**
   * `auto` (the default): the panel asks because the server has no verdict;
   * main checks the verdict lookup first and makes no model call when it
   * failed. `manual`: the reader pressed "Get Falcon's read"; it goes ahead.
   */
  trigger?: "auto" | "manual";
};

/** One sentence of Falcon's read: the English that was checked, and what is shown. */
export type NewsAnalysisLine = {
  /** The checked English. */
  en: string;
  /** What the reader sees: the translation, or the English when there is none or it did not hold. */
  text: string;
  /** True when `text` is the English standing in for a translation that was dropped. */
  untranslated: boolean;
};

export type NewsAnalysisCompany = NewsAnalysisLine & { ticker: string };

export type NewsAnalysis = {
  /** What the article reports, two or three plain sentences. */
  summary: NewsAnalysisLine[];
  /** What it means for each named company's business, one or two sentences each. */
  companies: NewsAnalysisCompany[];
  /** The language `text` is written in (English when the UI is English). */
  language: string;
  /** What the read was grounded in: the full article, or only the provider's summary. */
  basis: "article" | "summary";
  /** Relationship-graph edges given to the model as context, for the footnote. */
  graphEdges: number;
  model: string;
  generatedAt: string;
};

export type NewsAnalysisResult =
  | { ok: true; analysis: NewsAnalysis; cached: boolean }
  | {
      ok: false;
      error: string;
      /** `lookup_failed`: an automatic read refused because the verdict lookup failed; no model call was made. */
      reason: "unavailable" | "thin" | "failed" | "busy" | "lookup_failed";
    };
