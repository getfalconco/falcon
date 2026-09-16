import { SEEDED_TICKERS, loadSeededTickers } from "./seeded-tickers.js";
import type { EventsPollStatus, MaterialNewsEvent } from "./types.js";
import { classifyNewsArticle } from "./classify-article.js";
import { resolveEventsDataDir } from "./event-paths.js";
import { appendMaterialEvent } from "./event-store.js";
import {
  fetchFinnhubCompanyNews,
  newsWindowDates,
  sleep,
} from "./finnhub-news.js";
import { SeenArticleStore } from "./seen-articles.js";

/**
 * Delay between per-ticker Finnhub fetches. Env-tunable so the poll stays under
 * the free-tier rate limit as the seeded ticker list grows (28+ tickers at 1.2s
 * was hitting 429s). Default 2.5s ≈ 24 calls/min, well under Finnhub's 60/min.
 */
const TICKER_DELAY_MS = Math.max(
  250,
  Number.parseInt(process.env.NEWS_TICKER_DELAY_MS ?? "2500", 10) || 2500,
);
/** Cap LLM calls per ticker per poll so first run cannot hang for hours. */
const MAX_FRESH_PER_TICKER = 8;

function buildSummary(newEvents: number, articlesChecked: number, errors: string[]): string {
  const base = `${newEvents} event${newEvents === 1 ? "" : "s"} (${articlesChecked} article${articlesChecked === 1 ? "" : "s"} checked)`;
  if (errors.length === 0) return base;
  return `${base} · ${errors.length} ticker warning${errors.length === 1 ? "" : "s"}`;
}

let pollStatus: EventsPollStatus = {
  running: false,
  lastPollAt: null,
  lastError: null,
  lastNewEvents: 0,
  articlesChecked: 0,
  lastSummary: null,
  currentTicker: null,
  tickersCompleted: 0,
  totalTickers: SEEDED_TICKERS.length,
};

function patchStatus(patch: Partial<EventsPollStatus>): void {
  pollStatus = { ...pollStatus, ...patch };
}

export function getEventsPollStatus(): EventsPollStatus {
  return { ...pollStatus };
}

/**
 * Fired after every completed poll (success path). Lets a consumer react to newly
 * landed events — e.g. auto-trigger propagation or send a notification — without
 * this module depending on the propagation / notification layers.
 */
type PollCompleteHook = (status: EventsPollStatus, newEvents: MaterialNewsEvent[]) => void;
let onPollComplete: PollCompleteHook | null = null;

export function setPollCompleteHook(hook: PollCompleteHook | null): void {
  onPollComplete = hook;
}

export async function runNewsEventPoll(options?: {
  dataDir?: string;
  /** Explicit ticker list; when omitted, derived from the seeded graph. */
  tickers?: string[];
  /** Graph file to derive the ticker list from (defaults to the resolved graph). */
  graphPath?: string;
}): Promise<EventsPollStatus> {
  if (pollStatus.running) return getEventsPollStatus();

  // Seeded tickers come from the relationship graph so the poller tracks it
  // dynamically — no hardcoded list to drift out of sync.
  const tickers = options?.tickers ?? (await loadSeededTickers(options?.graphPath));

  patchStatus({
    running: true,
    lastError: null,
    lastNewEvents: 0,
    articlesChecked: 0,
    lastSummary: null,
    currentTicker: null,
    tickersCompleted: 0,
    totalTickers: tickers.length,
  });

  const dataDir = options?.dataDir ?? resolveEventsDataDir();
  const seen = new SeenArticleStore(dataDir);
  await seen.load();

  const { fromYmd, toYmd } = newsWindowDates();
  let newEvents = 0;
  let articlesChecked = 0;
  const tickerErrors: string[] = [];
  const newMaterialEvents: MaterialNewsEvent[] = [];

  try {
    if (!process.env.FINNHUB_API_KEY?.trim()) {
      throw new Error("FINNHUB_API_KEY is not configured");
    }
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i]!;
      patchStatus({ currentTicker: ticker, tickersCompleted: i });

      let articles: Awaited<ReturnType<typeof fetchFinnhubCompanyNews>>;

      try {
        articles = await fetchFinnhubCompanyNews(ticker, fromYmd, toYmd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[events] ${ticker}: fetch threw — ${message}`);
        tickerErrors.push(`${ticker}: ${message}`);
        patchStatus({ tickersCompleted: i + 1 });
        if (i < tickers.length - 1) await sleep(TICKER_DELAY_MS);
        continue;
      }

      if (!articles.ok) {
        console.warn(`[events] ${ticker}: ${articles.error}`);
        tickerErrors.push(`${ticker}: ${articles.error}`);
        patchStatus({ tickersCompleted: i + 1 });
        if (i < tickers.length - 1) await sleep(TICKER_DELAY_MS);
        continue;
      }

      const totalReturned = articles.articles.length;
      const fresh = articles.articles
        .filter((a) => Number.isFinite(a.id) && a.id > 0)
        .filter((a) => !seen.has(a.id))
        .sort((a, b) => b.datetime - a.datetime);

      console.info(
        `[events] ${ticker}: ${totalReturned} articles returned, ${fresh.length} new (classifying up to ${MAX_FRESH_PER_TICKER})`,
      );

      const toClassify = fresh.slice(0, MAX_FRESH_PER_TICKER);

      for (const article of toClassify) {
        articlesChecked++;
        seen.add(article.id);
        patchStatus({ articlesChecked, lastNewEvents: newEvents });

        try {
          const classification = await classifyNewsArticle(ticker, article);
          if (classification?.is_material_event) {
            const stored = await appendMaterialEvent(dataDir, ticker, article, classification);
            newMaterialEvents.push(stored);
            newEvents++;
            patchStatus({ lastNewEvents: newEvents });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[events] classify failed ${ticker} #${article.id}: ${message}`);
        }
      }

      // Mark skipped-as-seen for remaining fresh ids so we don't re-fetch them every poll
      for (const article of fresh.slice(MAX_FRESH_PER_TICKER)) {
        seen.add(article.id);
      }

      patchStatus({ tickersCompleted: i + 1 });

      if (i < tickers.length - 1) {
        await sleep(TICKER_DELAY_MS);
      }
    }

    await seen.persist();

    const summary = buildSummary(newEvents, articlesChecked, tickerErrors);
    const fatalError =
      tickers.length > 0 && tickerErrors.length === tickers.length
        ? tickerErrors[0] ?? "All tickers failed"
        : null;

    patchStatus({
      running: false,
      lastPollAt: new Date().toISOString(),
      lastError: fatalError,
      lastNewEvents: newEvents,
      articlesChecked,
      lastSummary: summary,
      currentTicker: null,
      tickersCompleted: tickers.length,
    });

    console.info(`[events] poll complete — ${summary}`);
    if (tickerErrors.length > 0) {
      console.warn(`[events] ticker warnings:`, tickerErrors.join("; "));
    }

    // Notify consumers (e.g. auto-trigger propagation, desktop notification) after a successful poll.
    try {
      onPollComplete?.(getEventsPollStatus(), newMaterialEvents);
    } catch (hookErr) {
      console.warn("[events] poll-complete hook threw:", hookErr instanceof Error ? hookErr.message : hookErr);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patchStatus({
      running: false,
      lastPollAt: pollStatus.lastPollAt,
      lastError: message,
      lastNewEvents: newEvents,
      articlesChecked,
      lastSummary: null,
      currentTicker: null,
    });
    console.error("[events] poll failed:", message);
  }

  return getEventsPollStatus();
}
