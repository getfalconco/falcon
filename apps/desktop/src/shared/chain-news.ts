/**
 * News from the chain: stories that do not name a stock but reach it through
 * the filing graph in one or two hops, each with its path written out
 * ("TSM, supplier, NVDA" read as TSM is a supplier of NVDA).
 *
 * Pure: the Stock tab hands it the ego graph (`stock:graph`) and the cached
 * news feed, and the tests run it on plain arrays. No model is asked
 * anything: the path is the graph's, the title is the feed's.
 *
 * Ranking: a one-hop path weighs well over twice a two-hop one, a path is as
 * strong as its weakest link, and a story loses half its weight a day. A story reaches the
 * stock through its best path only; the same story under another id (a
 * duplicate the engine marked, the same URL, the same title) appears once.
 */

import type { NewsFeedArticle } from "./news-feed";
import { compareLinks, otherEnd, roleOf, type LinkRole, type StockGraph, type StockGraphLink } from "./stock-graph";

/** One step of a path: `from` plays `role` towards the next node. */
export type ChainStep = { from: string; role: LinkRole; link: StockGraphLink };

export type ChainPath = {
  /** Node ids from the story's company to the stock, both ends included. */
  nodes: string[];
  /** One per link, in order. */
  steps: ChainStep[];
  hops: 1 | 2;
  /** The weakest link's strength, times a two-hop discount. */
  score: number;
};

const TWO_HOP = 0.55;
const HALF_LIFE_HOURS = 24;

function bestLinks(graph: StockGraph): Map<string, StockGraphLink> {
  const best = new Map<string, StockGraphLink>();
  for (const link of graph.links) {
    const key = link.filer < link.named ? `${link.filer}|${link.named}` : `${link.named}|${link.filer}`;
    const prev = best.get(key);
    if (!prev || compareLinks(link, prev) < 0) best.set(key, link);
  }
  return best;
}

/**
 * The best path (one or two hops) from every node in the ego graph to its
 * centre, keyed by node id. Two-hop paths run through a first-ring node.
 */
export function chainPaths(graph: StockGraph): Map<string, ChainPath> {
  const center = graph.ticker;
  const adjacency = new Map<string, StockGraphLink[]>();
  for (const link of bestLinks(graph).values()) {
    for (const end of [link.filer, link.named]) {
      const list = adjacency.get(end) ?? [];
      list.push(link);
      adjacency.set(end, list);
    }
  }

  const paths = new Map<string, ChainPath>();
  const offer = (id: string, path: ChainPath) => {
    const prev = paths.get(id);
    if (!prev || path.score > prev.score || (path.score === prev.score && path.hops < prev.hops)) paths.set(id, path);
  };

  const direct = adjacency.get(center) ?? [];
  for (const first of direct) {
    const mid = otherEnd(first, center);
    offer(mid, {
      nodes: [mid, center],
      steps: [{ from: mid, role: roleOf(first, mid), link: first }],
      hops: 1,
      score: first.strength,
    });
    for (const second of adjacency.get(mid) ?? []) {
      const start = otherEnd(second, mid);
      if (start === center || start === mid) continue;
      offer(start, {
        nodes: [start, mid, center],
        steps: [
          { from: start, role: roleOf(second, start), link: second },
          { from: mid, role: roleOf(first, mid), link: first },
        ],
        hops: 2,
        score: Math.min(first.strength, second.strength) * TWO_HOP,
      });
    }
  }
  // A node linked directly keeps its direct path even when a two-hop one scores higher.
  for (const first of direct) {
    const mid = otherEnd(first, center);
    const path = paths.get(mid);
    if (path && path.hops === 2) {
      paths.set(mid, { nodes: [mid, center], steps: [{ from: mid, role: roleOf(first, mid), link: first }], hops: 1, score: first.strength });
    }
  }
  return paths;
}

export type ChainNewsRow = {
  article: NewsFeedArticle;
  /** Falcon's title when the engine wrote one, else the publisher's headline. */
  title: string;
  /** The company in the story the path starts from. */
  via: string;
  path: ChainPath;
  score: number;
};

export type ChainNewsOptions = {
  /** Unix seconds; the clock recency is measured against. */
  now: number;
  /** Most rows returned. */
  limit?: number;
};

/** The row title: Falcon's own, when it wrote one, else the provider's. */
export function chainTitle(article: NewsFeedArticle): string {
  const falcon = article.falcon?.headline?.trim();
  return falcon || article.headline.trim();
}

function storyTickers(article: NewsFeedArticle): string[] {
  const all = [
    ...(article.tickers ?? []),
    ...(article.falcon?.tickers ?? []),
    article.event?.affected_ticker ?? "",
  ];
  return [...new Set(all.map((t) => (t ?? "").trim().toUpperCase()).filter(Boolean))];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first word of a company name that is long enough to stand for it ("NVIDIA" of "NVIDIA Corporation"). */
export function shortName(name: string | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/[\s,]+/)[0] ?? "";
  const bare = first.replace(/[^\p{L}\p{N}&.-]/gu, "");
  return bare.length >= 4 ? bare : null;
}

/** True when the story names the stock itself: in its tickers, or by symbol or name in its text. */
export function mentionsStock(article: NewsFeedArticle, ticker: string, name: string | null): boolean {
  const symbol = ticker.toUpperCase();
  if (storyTickers(article).includes(symbol)) return true;
  const text = `${article.headline} ${article.falcon?.headline ?? ""} ${article.summary ?? ""}`;
  if (new RegExp(`(^|[^\\p{L}\\p{N}])\\$?${escapeRegExp(symbol)}(?![\\p{L}\\p{N}])`, "u").test(text)) return true;
  const short = shortName(name);
  if (short && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(short)}(?![\\p{L}\\p{N}])`, "iu").test(text)) return true;
  return false;
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** How much a story still weighs at `ageSeconds`: 1 when new, half a day later. */
export function recencyWeight(ageSeconds: number): number {
  const hours = Math.max(0, ageSeconds) / 3600;
  return Math.pow(0.5, hours / HALF_LIFE_HOURS);
}

/**
 * The chain feed for `graph`'s stock: stories about companies within two
 * hops that do not name the stock, ranked by hop distance, link strength and
 * recency, deduplicated, at most `limit` (10).
 *
 * A story the engine decided to hide (junk, a duplicate, not material) stays
 * out, as it does on the News card; one still waiting for its reading is in.
 */
export function chainNews(
  articles: readonly NewsFeedArticle[],
  graph: StockGraph,
  opts: ChainNewsOptions,
): ChainNewsRow[] {
  const limit = opts.limit ?? 10;
  const paths = chainPaths(graph);
  if (paths.size === 0) return [];

  const candidates: ChainNewsRow[] = [];
  for (const article of articles) {
    if (article.falcon?.decision === "hide") continue;
    const title = chainTitle(article);
    if (!title) continue;
    if (mentionsStock(article, graph.ticker, graph.name)) continue;
    let best: { via: string; path: ChainPath } | null = null;
    for (const ticker of storyTickers(article)) {
      const path = paths.get(ticker);
      if (!path) continue;
      if (!best || path.score > best.path.score || (path.score === best.path.score && path.hops < best.path.hops)) {
        best = { via: ticker, path };
      }
    }
    if (!best) continue;
    const hopWeight = best.path.hops === 1 ? 1 : 0.7;
    const score = hopWeight * best.path.score * (0.25 + 0.75 * recencyWeight(opts.now - article.datetime));
    candidates.push({ article, title, via: best.via, path: best.path, score });
  }

  // One score carries all three: a two-hop path starts at well under half a
  // one-hop path's weight, so a far story leads only when it is both fresher
  // and on stronger links.
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.hops - b.path.hops ||
      b.article.datetime - a.article.datetime ||
      a.article.id - b.article.id,
  );

  const out: ChainNewsRow[] = [];
  const seenIds = new Set<number>();
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  for (const row of candidates) {
    const { article } = row;
    const dupOf = article.falcon?.duplicate_of;
    if (seenIds.has(article.id) || (typeof dupOf === "number" && seenIds.has(dupOf))) continue;
    const url = (article.url ?? "").trim();
    if (url && seenUrls.has(url)) continue;
    const key = titleKey(row.title);
    if (key && seenTitles.has(key)) continue;
    seenIds.add(article.id);
    if (typeof dupOf === "number") seenIds.add(dupOf);
    if (url) seenUrls.add(url);
    if (key) seenTitles.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
