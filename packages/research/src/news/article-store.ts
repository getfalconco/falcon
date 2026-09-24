import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArticleClassification } from "./classify-article.js";
import type { FinnhubNewsArticle } from "./finnhub-news.js";
import type { EventDirection, EventType } from "./types.js";

/**
 * Every article the poll has seen, not only the ones that became events.
 *
 * The event store keeps what the classifier judged material — a handful a
 * day. A news feed needs the rest too: the earnings preview nobody acted on,
 * the analyst note, the sector piece that mentions three of the names at
 * once. So the poll files each article here as it arrives, under the day it
 * was published, and attaches the classifier's reading when there is one.
 *
 * One article, many tickers: Finnhub returns the same story for every company
 * it names, so a story is keyed by its id and the tickers it was fetched for
 * accumulate on it. That list is the feed's "who this touches".
 *
 * Kept on the engine's disk beside the events, a few days deep; the feed
 * channel reads it. Nothing here calls a provider.
 */

export type NewsArticleEvent = {
  material: boolean;
  event_type: EventType;
  /** The name the classifier says the story moves — usually one of `tickers`. */
  affected_ticker: string;
  direction: EventDirection;
  summary: string;
  confidence: number;
};

export type NewsArticle = {
  id: number;
  headline: string;
  summary: string;
  url: string;
  source: string;
  /** Published, unix seconds. */
  datetime: number;
  /** The tracked names the story was fetched for, in the order they arrived. */
  tickers: string[];
  /** The classifier's reading, once it has read the story; null until then. */
  event: NewsArticleEvent | null;
  first_seen: string;
};

type ArticlesFile = { date: string; articles: NewsArticle[] };

/** A day's ceiling. The universe returns a few hundred a day at most; this is a fuse. */
const MAX_PER_DAY = 800;
/** How many day-files to keep in memory and on disk. */
const KEEP_DAYS = 7;
const DIR = "articles";

export function articlesDir(dataDir: string): string {
  return path.join(dataDir, DIR);
}

function ymd(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "1970-01-01";
}

async function readDay(dir: string, file: string): Promise<NewsArticle[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, file), "utf8")) as ArticlesFile;
    return Array.isArray(parsed.articles) ? parsed.articles : [];
  } catch {
    return [];
  }
}

async function dayFiles(dir: string, days: number): Promise<string[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }
  files.sort((a, b) => b.localeCompare(a));
  return files.slice(0, days);
}

export class ArticleStore {
  private byDay = new Map<string, Map<number, NewsArticle>>();
  private byId = new Map<number, NewsArticle>();
  private dirty = new Set<string>();
  private loaded = false;

  constructor(
    private readonly dataDir: string,
    private readonly keepDays: number = KEEP_DAYS,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const dir = articlesDir(this.dataDir);
    for (const file of await dayFiles(dir, this.keepDays)) {
      const day = file.slice(0, 10);
      const map = new Map<number, NewsArticle>();
      for (const a of await readDay(dir, file)) {
        map.set(a.id, a);
        this.byId.set(a.id, a);
      }
      this.byDay.set(day, map);
    }
  }

  /**
   * A fetch's worth of articles for one ticker. New stories are filed under
   * their day; a story already on file gains the ticker if it lacked it.
   */
  note(ticker: string, articles: FinnhubNewsArticle[]): void {
    const t = ticker.trim().toUpperCase();
    const now = new Date().toISOString();
    for (const a of articles) {
      if (!Number.isFinite(a.id) || a.id <= 0 || !a.headline) continue;
      const known = this.byId.get(a.id);
      if (known) {
        if (t && !known.tickers.includes(t)) {
          known.tickers.push(t);
          this.dirty.add(ymd(known.datetime));
        }
        continue;
      }
      const day = ymd(a.datetime);
      let map = this.byDay.get(day);
      if (!map) {
        map = new Map();
        this.byDay.set(day, map);
      }
      if (map.size >= MAX_PER_DAY) continue;
      const row: NewsArticle = {
        id: a.id,
        headline: a.headline,
        summary: a.summary ?? "",
        url: a.url ?? "",
        source: a.source ?? "",
        datetime: a.datetime,
        tickers: t ? [t] : [],
        event: null,
        first_seen: now,
      };
      map.set(a.id, row);
      this.byId.set(a.id, row);
      this.dirty.add(day);
    }
  }

  /** The classifier's reading of one story, material or not. */
  classify(id: number, c: ArticleClassification): void {
    const row = this.byId.get(id);
    if (!row) return;
    row.event = {
      material: c.is_material_event,
      event_type: c.event_type,
      affected_ticker: c.affected_ticker,
      direction: c.direction_on_primary,
      summary: c.summary,
      confidence: c.confidence,
    };
    this.dirty.add(ymd(row.datetime));
  }

  async persist(): Promise<void> {
    if (this.dirty.size === 0) return;
    const dir = articlesDir(this.dataDir);
    await mkdir(dir, { recursive: true });
    for (const day of this.dirty) {
      const map = this.byDay.get(day);
      if (!map) continue;
      const articles = [...map.values()].sort((a, b) => b.datetime - a.datetime);
      const payload: ArticlesFile = { date: day, articles };
      await writeFile(path.join(dir, `${day}.json`), JSON.stringify(payload), "utf8");
    }
    this.dirty.clear();
  }
}

/**
 * The feed: the newest stories across the last `days` day-files, newest
 * first, at most `limit` of them. Reads the files directly, so it answers
 * from any process that shares the directory.
 */
export async function listNewsArticles(
  dataDir: string,
  options?: { days?: number; limit?: number },
): Promise<NewsArticle[]> {
  const days = Math.max(1, options?.days ?? 3);
  const limit = Math.max(1, options?.limit ?? 300);
  const dir = articlesDir(dataDir);
  const all: NewsArticle[] = [];
  for (const file of await dayFiles(dir, days)) all.push(...(await readDay(dir, file)));
  all.sort((a, b) => b.datetime - a.datetime);
  return all.slice(0, limit);
}
