/**
 * Which stories the News card shows, and under what title.
 *
 * The feed (article-store.ts) keeps every story the poll read. Most of it is
 * noise for a reader who wants an informational advantage: market roundups,
 * "stocks to watch", price recaps, opinion columns, the same event retold by
 * five outlets. This module decides, per story, whether it is shown, and
 * which line is its title, from the classifier's verdict (classifier/*) and
 * the headline Falcon wrote for it. Pure: the engine's `news:feed` channel
 * (and the desktop's local fallback) call it with the verdicts they hold.
 *
 * THE THRESHOLD (tested in curation.test.ts):
 *
 *   A third-party story is shown only when its verdict is `ok` and at least
 *   one name in it clears the bar:
 *     relevance direct   and materiality >= the event type's minimum
 *                        (standard; high for analyst_action, ownership_flows
 *                        and macro_sector, which the spec says are mostly
 *                        noise: ratings, 13F coverage, thematic pieces);
 *     relevance indirect and materiality high.
 *   `none` relevance and `low` materiality never show. Neither does a story
 *   whose publisher headline has the shape of a roundup, a list, a "stocks to
 *   watch", a price recap or an opinion question (`junkReason`), whatever its
 *   verdict said.
 *
 *   Duplicates: of the stories that clear the bar, one per event is shown.
 *   Two stories are the same event when they share the event type and the
 *   lead name (the strongest material name) and were published within 24
 *   hours of each other, or when their Falcon headlines read the same. The
 *   one kept is the most material, then the earliest (the first report).
 *
 *   Unclassified third-party stories wait (decision `pending`): the verdict
 *   usually arrives within one classifier cycle. A failed verdict hides.
 *
 *   Primary sources (an SEC filing, a company press release on a newswire)
 *   are shown at once, before any verdict, under a neutral title built from
 *   the filing type and the company: no model involved. Once a verdict
 *   exists they are held to the same bar as everything else.
 *
 * THE TITLE: Falcon's headline (classifier/headline.ts) when one is stored
 * and still passes the headline rules; else the classifier's event label when
 * it passes them too (it is a neutral label the same model wrote, with every
 * figure checked against the article); else the story waits (`pending`,
 * "awaiting_headline") rather than show the publisher's line.
 */

import type { NewsArticle } from "./article-store.js";
import { vetHeadline } from "./headline-rules.js";
import type { Direction, EventType, Materiality, TickerVerdict, Verdict } from "../classifier/types.js";

export type CurationDecision = "show" | "hide" | "pending";

export type CurationReason =
  /** Cleared the materiality bar, has a title. */
  | "material"
  /** A filing or press release, shown before its verdict. */
  | "primary_source"
  /** Verdict ok, but no name cleared the bar. */
  | "not_material"
  /** Roundup, list, recap or opinion by its shape. */
  | "junk"
  /** Same event as a story already shown. */
  | "duplicate"
  /** No verdict yet. */
  | "unclassified"
  /** The classifier gave up on it. */
  | "failed"
  /** Material, but no title that passes the rules yet. */
  | "awaiting_headline";

export type HeadlineSource = "falcon" | "label" | "primary";
export type PrimaryKind = "sec_filing" | "press_release";

export type NewsCuration = {
  decision: CurationDecision;
  reason: CurationReason;
  /** The row title; null unless the story is shown. */
  headline: string | null;
  headline_source: HeadlineSource | null;
  /** The classifier's key for the story (`id:<finnhub id>`). */
  article_key: string;
  event_type: EventType | null;
  /** The strongest materiality among the names that cleared the bar. */
  materiality: Materiality | null;
  /** The lead name's direction. */
  direction: Direction | null;
  /** Names that cleared the bar, strongest first; for a primary source, its names. */
  tickers: string[];
  primary: PrimaryKind | null;
  /** The id of the story this one repeats, when `reason` is "duplicate". */
  duplicate_of: number | null;
};

export type CuratedNewsArticle = NewsArticle & { falcon: NewsCuration };

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

const RANK: Record<Materiality, number> = { low: 0, standard: 1, high: 2 };

/** Event types whose direct stories must be `high` to show: mostly noise at `standard`. */
export const HIGH_BAR_EVENT_TYPES: readonly EventType[] = ["analyst_action", "ownership_flows", "macro_sector"];

export function minimumMateriality(eventType: EventType): Materiality {
  return HIGH_BAR_EVENT_TYPES.includes(eventType) ? "high" : "standard";
}

type Assessed = Extract<TickerVerdict, { relevance: "direct" | "indirect" }>;

/** The verdict's names that clear the bar, strongest first (direct before indirect on ties). */
export function materialEntries(verdict: Pick<Verdict, "status" | "event_type" | "tickers">): Assessed[] {
  if (verdict.status !== "ok") return [];
  const min = RANK[minimumMateriality(verdict.event_type)];
  const out = verdict.tickers.filter((t): t is Assessed => {
    if (t.relevance === "direct") return RANK[t.materiality] >= min;
    if (t.relevance === "indirect") return t.materiality === "high";
    return false;
  });
  return out.sort(
    (a, b) =>
      RANK[b.materiality] - RANK[a.materiality] ||
      (a.relevance === b.relevance ? 0 : a.relevance === "direct" ? -1 : 1),
  );
}

export function isMaterialVerdict(verdict: Pick<Verdict, "status" | "event_type" | "tickers">): boolean {
  return materialEntries(verdict).length > 0;
}

// ---------------------------------------------------------------------------
// Shapes that are never news
// ---------------------------------------------------------------------------

const JUNK: ReadonlyArray<readonly [RegExp, string]> = [
  [/\?\s*$/, "question"],
  [/\bstocks? to watch\b/i, "stocks to watch"],
  [/\b(?:stock market today|sector update|market (?:wrap|recap|update)|morning (?:brief|wrap)|week ahead|(?:pre-?market|after-?hours) movers|stocks? making (?:big|the biggest) moves|most active)\b/i, "roundup"],
  [/\bwhich\b.*\bstocks?\b|\bstocks?\b.*\b(?:making waves|are moving|moving in today)\b/i, "roundup"],
  [/\b(?:stock market midday|top midday stories|midday movers|markets? (?:mixed|wrap))\b/i, "roundup"],
  [/\b(?:gap-?ups?|gap-?downs?|gapping|top gainers|gainers and losers|before the opening bell|pre-?market session|stocks that explain|analyst research calls|bull and bear of the day)\b/i, "roundup"],
  [/^prediction:|\bhow to build\b|\bearnings preview\b|\bexploring analyst estimates\b/i, "preview or column"],
  [/\bwhat (?:you|investors) need to know\b/i, "recap"],
  [/\b(?:top|best|these)\s+\d+\b/i, "list"],
  [/^\d+\s+(?:[\p{L}-]+\s+){0,2}(?:stocks?|reasons?|things|ways|picks|etfs?|funds|charts|names)\b/iu, "list"],
  [/\bwhat you need to know\b|\bhere['’]?s (?:why|what|how)\b|\bwhat to know\b/i, "recap"],
  [/\bwhy\b.*\b(?:stock|shares)\b.*\b(?:is|are|was|were|has|have)\b.*\b(?:up|down|higher|lower|climbing|falling|rising|sliding|jumping|dropping|soaring|sinking|popp(?:ed|ing)|moving|gaining|today)\b/i, "price recap"],
  [/\bwhy\b.*\b(?:stock|shares|etf)\b.*\b(?:popped|crashed|soared|sank|jumped|fell|rose|climbed|slid|tumbled|surged|plunged|dropped|rallied)\b/i, "price recap"],
  [/\b(?:shares|stocks?)\s+(?:trade|trading|are|were)\s+(?:up|down|higher|lower)\b/i, "price recap"],
  // Several names' moves in one line ("X climbs 5%; Y rises 4%, Z dips"): a movers list.
  [/\b(?:rises|falls|climbs|slides|slips|dips|rallies|retreats|tumbles|jumps|gains|drops|sinks|surges|soars|plunges|edges)\s+\d+(?:\.\d+)?%[^;]*;/i, "price recap"],
  [/\b(?:i['’]?d|i['’]?m|i am|my)\b/i, "opinion"],
  // Not "retire": "Apple's COO to retire" is a management change, not a column.
  [/\b(?:should you|is it time to|better buy|buy now|no-brainer|millionaire|retirement|forever stock)\b/i, "opinion"],
  [/\bbetter\s+(?:[\p{L}-]+\s+){0,3}stock\b|\bvs\.?\s.*\bwhich\b/iu, "opinion"],
];

/** Why a story is noise by its publisher headline alone; null when it may be news. */
export function junkReason(publisherHeadline: string): string | null {
  const text = publisherHeadline.trim();
  for (const [re, label] of JUNK) if (re.test(text)) return label;
  return null;
}

// ---------------------------------------------------------------------------
// Primary sources
// ---------------------------------------------------------------------------

const WIRE_HOSTS: Readonly<Record<string, string>> = {
  "businesswire.com": "Business Wire",
  "prnewswire.com": "PR Newswire",
  "globenewswire.com": "GlobeNewswire",
  "accesswire.com": "ACCESSWIRE",
  "accessnewswire.com": "ACCESS Newswire",
  "newsfilecorp.com": "Newsfile",
};

const WIRE_SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/business\s*wire/i, "Business Wire"],
  [/pr\s*newswire/i, "PR Newswire"],
  [/globe\s*newswire/i, "GlobeNewswire"],
  [/access\s*(?:news)?wire/i, "ACCESSWIRE"],
  [/newsfile/i, "Newsfile"],
  [/press release/i, ""],
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A filing or a company press release on a newswire; null for third-party coverage. */
export function primarySource(article: Pick<NewsArticle, "source" | "url">): { kind: PrimaryKind; wire: string } | null {
  const host = hostOf(article.url);
  const source = article.source.trim();
  if (host === "sec.gov" || host.endsWith(".sec.gov") || /^(?:sec|sec edgar|edgar|sec filing)$/i.test(source)) {
    return { kind: "sec_filing", wire: "" };
  }
  for (const [suffix, wire] of Object.entries(WIRE_HOSTS)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return { kind: "press_release", wire };
  }
  for (const [re, wire] of WIRE_SOURCES) if (re.test(source)) return { kind: "press_release", wire };
  return null;
}

const FORM = /\b(?:Form\s+)?(8-K|10-K|10-Q|6-K|20-F|40-F|S-1|S-3|S-4|SC\s?13D|SC\s?13G|13D|13G|DEF\s?14A|424B\d?|Form\s+4)\b/i;

/**
 * The neutral title for a primary source, built from fixed parts: the company
 * and the filing type, or the company and the wire. No model, no figure.
 */
export function primaryHeadline(
  kind: PrimaryKind,
  company: string,
  article: Pick<NewsArticle, "headline">,
  wire: string,
): string {
  if (kind === "sec_filing") {
    const m = FORM.exec(article.headline);
    if (!m) return `${company} files with the SEC`;
    const form = m[1]!.replace(/\s+/g, " ").toUpperCase().replace(/^FORM /, "");
    return `${company} files Form ${form}`;
  }
  return wire ? `${company} issues a press release via ${wire}` : `${company} issues a press release`;
}

// ---------------------------------------------------------------------------
// One story
// ---------------------------------------------------------------------------

export type CurationOptions = {
  /** The verdict for an article key (any prompt version, ok preferred); null when none. */
  verdictFor: (articleKey: string) => Verdict | null;
  /** The company's name for a neutral title; the ticker when unknown. */
  companyName?: (ticker: string) => string | null;
};

export function articleKeyFor(article: Pick<NewsArticle, "id">): string {
  return `id:${article.id}`;
}

function base(article: NewsArticle): NewsCuration {
  return {
    decision: "pending",
    reason: "unclassified",
    headline: null,
    headline_source: null,
    article_key: articleKeyFor(article),
    event_type: null,
    materiality: null,
    direction: null,
    tickers: [],
    primary: null,
    duplicate_of: null,
  };
}

/** The decision for one story, before duplicates are folded. */
export function curateArticle(article: NewsArticle, options: CurationOptions): NewsCuration {
  const out = base(article);
  const primary = primarySource(article);
  out.primary = primary?.kind ?? null;

  const junk = junkReason(article.headline);
  if (junk) return { ...out, decision: "hide", reason: "junk" };

  const verdict = options.verdictFor(out.article_key);
  const names = article.tickers.map((t) => t.trim().toUpperCase()).filter(Boolean);

  if (!verdict || verdict.status !== "ok") {
    if (primary && names.length > 0) {
      const lead = names[0]!;
      const company = options.companyName?.(lead)?.trim() || lead;
      return {
        ...out,
        decision: "show",
        reason: "primary_source",
        headline: primaryHeadline(primary.kind, company, article, primary.wire),
        headline_source: "primary",
        tickers: names,
      };
    }
    return verdict ? { ...out, decision: "hide", reason: "failed" } : out;
  }

  const material = materialEntries(verdict);
  const classified: NewsCuration = {
    ...out,
    event_type: verdict.event_type,
    materiality: material[0]?.materiality ?? null,
    direction: material[0]?.direction ?? null,
    tickers: material.map((t) => t.ticker.toUpperCase()),
  };
  if (material.length === 0) return { ...classified, decision: "hide", reason: "not_material" };

  const source = `${article.headline}\n${article.summary}`;
  const falcon = verdict.headline ? vetHeadline(verdict.headline.text, source) : null;
  if (falcon?.ok) {
    return { ...classified, decision: "show", reason: "material", headline: falcon.headline, headline_source: "falcon" };
  }
  const label = verdict.event_label ? vetHeadline(verdict.event_label, source) : null;
  if (label?.ok) {
    return { ...classified, decision: "show", reason: "material", headline: label.headline, headline_source: "label" };
  }
  return { ...classified, decision: "pending", reason: "awaiting_headline" };
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/** Two reports of one event closer than this are folded into one row. */
export const DUPLICATE_WINDOW_SEC = 24 * 60 * 60;

function normalisedTitle(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sameEvent(a: CuratedNewsArticle, b: CuratedNewsArticle): boolean {
  if (a.falcon.headline && b.falcon.headline && normalisedTitle(a.falcon.headline) === normalisedTitle(b.falcon.headline)) {
    return true;
  }
  if (!a.falcon.event_type || a.falcon.event_type !== b.falcon.event_type) return false;
  const leadA = a.falcon.tickers[0];
  if (!leadA || leadA !== b.falcon.tickers[0]) return false;
  return Math.abs(a.datetime - b.datetime) <= DUPLICATE_WINDOW_SEC;
}

/**
 * Every story with its decision, in the order given (newest first from the
 * store). Of the stories that would show, one per event stays shown; the
 * rest are marked duplicates of it.
 */
export function curateNewsFeed<T extends NewsArticle>(articles: T[], options: CurationOptions): Array<T & { falcon: NewsCuration }> {
  const curated = articles.map((a) => ({ ...a, falcon: curateArticle(a, options) }));
  const shown = curated
    .filter((a) => a.falcon.decision === "show")
    .sort(
      (a, b) =>
        (b.falcon.materiality ? RANK[b.falcon.materiality] : -1) - (a.falcon.materiality ? RANK[a.falcon.materiality] : -1) ||
        a.datetime - b.datetime ||
        a.id - b.id,
    );
  const kept: Array<T & { falcon: NewsCuration }> = [];
  for (const story of shown) {
    const original = kept.find((k) => sameEvent(k, story));
    if (original) {
      story.falcon = { ...story.falcon, decision: "hide", reason: "duplicate", duplicate_of: original.id };
      continue;
    }
    kept.push(story);
  }
  return curated;
}

/**
 * One verdict per article key: an ok verdict over a failed one, then the
 * latest. The same preference Base's lookup uses (base/classification.ts).
 */
export function verdictIndex(verdicts: Iterable<Verdict>): (articleKey: string) => Verdict | null {
  const byKey = new Map<string, Verdict>();
  for (const v of verdicts) {
    const prior = byKey.get(v.article_key);
    if (
      !prior ||
      (prior.status !== "ok" && v.status === "ok") ||
      (prior.status === v.status && v.classified_at > prior.classified_at) ||
      (prior.status === v.status && v.classified_at === prior.classified_at && !prior.headline && v.headline)
    ) {
      byKey.set(v.article_key, v);
    }
  }
  return (key) => byKey.get(key) ?? null;
}
