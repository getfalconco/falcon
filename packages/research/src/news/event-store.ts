import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DailyEventsFile } from "../propagation/event-types.js";
import type { MaterialNewsEvent } from "../propagation/types.js";
import type { ArticleClassification } from "./classify-article.js";
import type { FinnhubNewsArticle } from "./finnhub-news.js";
import { dailyEventsPath } from "./event-paths.js";

function dateYmdFromUnix(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export async function appendMaterialEvent(
  dataDir: string,
  ticker: string,
  article: FinnhubNewsArticle,
  classification: ArticleClassification,
): Promise<MaterialNewsEvent> {
  const event: MaterialNewsEvent = {
    id: randomUUID(),
    article_id: article.id,
    ticker,
    headline: article.headline,
    source_url: article.url,
    article_datetime: article.datetime,
    classified_at: new Date().toISOString(),
    is_material_event: true,
    event_type: classification.event_type,
    affected_ticker: classification.affected_ticker,
    direction_on_primary: classification.direction_on_primary,
    summary: classification.summary,
    confidence: classification.confidence,
  };

  const dateYmd = dateYmdFromUnix(article.datetime);
  await mkdir(dataDir, { recursive: true });
  const filePath = dailyEventsPath(dataDir, dateYmd);

  let existing: DailyEventsFile = { date: dateYmd, events: [] };
  try {
    await access(filePath);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as DailyEventsFile;
    if (Array.isArray(parsed.events)) existing = parsed;
  } catch {
    // new file
  }

  if (!existing.events.some((e) => e.article_id === event.article_id)) {
    existing.events.push(event);
    existing.events.sort((a, b) => b.article_datetime - a.article_datetime);
    await writeFile(filePath, JSON.stringify(existing, null, 2), "utf8");
  }

  return event;
}

export async function listStoredEvents(
  dataDir: string,
  options?: { days?: number; ticker?: string },
): Promise<MaterialNewsEvent[]> {
  const days = options?.days ?? 14;
  const tickerFilter = options?.ticker?.trim().toUpperCase();

  let files: string[] = [];
  try {
    await access(dataDir);
    files = (await readdir(dataDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }

  files.sort((a, b) => b.localeCompare(a));
  const selected = files.slice(0, days);
  const all: MaterialNewsEvent[] = [];

  for (const file of selected) {
    try {
      const raw = await readFile(path.join(dataDir, file), "utf8");
      const parsed = JSON.parse(raw) as DailyEventsFile;
      if (Array.isArray(parsed.events)) all.push(...parsed.events);
    } catch {
      continue;
    }
  }

  const filtered = tickerFilter
    ? all.filter(
        (e) => e.ticker === tickerFilter || e.affected_ticker === tickerFilter,
      )
    : all;

  return filtered.sort((a, b) => b.article_datetime - a.article_datetime);
}
