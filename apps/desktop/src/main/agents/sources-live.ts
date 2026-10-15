import { MACRO_CALENDAR } from "@meridian/research/calendar/contracts";
import {
  fetchCorporateCalendar,
  fetchLiveQuote,
  fetchMarketHeadlines,
  fetchQuoteSummaryModules,
  fetchStockChart,
  fetchStockNews,
} from "../stock/market-data-service";
import { getUsStockCatalog, searchUsStocks } from "../stock/us-stock-catalog";
import { invokeChannel } from "../ipc-register";
import { filingForm, graphEdges } from "../research/graph-edges";
import type { NewsFeedResult } from "../../shared/news-feed";
import type { ReadthroughResult } from "../../shared/readthrough-types";
import { filingText, insiderTxn, recentFilings } from "./edgar";
import { filings as filingChangesService } from "../filings/register-filings-handlers";
import {
  materialFromFeed,
  parseConsensus,
  type AgentDataSources,
  type DailyClose,
  type NewsItem,
  type QuoteRead,
  type ReadthroughRead,
} from "./sources";
import { nyYmd } from "./time";

/**
 * The live `AgentDataSources`: existing services, each behind a small cache
 * so many agents on one company cost one request, and a check every few
 * minutes never turns into a request every few minutes per agent.
 */

type Entry<T> = { at: number; value: Promise<T> };

function cached<T>(ttlMs: number): (key: string, load: () => Promise<T>) => Promise<T> {
  const map = new Map<string, Entry<T>>();
  return (key, load) => {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = load();
    map.set(key, { at: Date.now(), value });
    // A failure is not remembered: the next check asks again (its own backoff applies).
    value.catch(() => {
      if (map.get(key)?.value === value) map.delete(key);
    });
    if (map.size > 500) map.delete(map.keys().next().value as string);
    return value;
  };
}

const MIN = 60_000;
const earningsCache = cached<{ dates: string[]; estimated: boolean | null }>(6 * 60 * MIN);
const consensusCache = cached<ReturnType<typeof parseConsensus>>(60 * MIN);
const newsCache = cached<NewsItem[]>(5 * MIN);
const marketNewsCache = cached<NewsItem[]>(5 * MIN);
const quoteCache = cached<QuoteRead>(MIN);
const closesCache = cached<DailyClose[]>(30 * MIN);
const readthroughCache = cached<ReadthroughRead[]>(30 * MIN);

/** The News card's own request, so an agent's read shares the feed cache with it. */
const NEWS_FEED_REQUEST = { days: 3, limit: 300 };


export function createLiveSources(): AgentDataSources {
  return {
    earningsDates: (ticker) =>
      earningsCache(ticker, async () => {
        const cal = await fetchCorporateCalendar(ticker);
        return { dates: [...cal.earningsDates].sort(), estimated: cal.earningsEstimated };
      }),

    filings: (ticker) => recentFilings(ticker),
    filingText: (filing) => filingText(filing),
    insiderTxn: (filing) => insiderTxn(filing),

    quote: (ticker) =>
      quoteCache(ticker, async () => {
        const q = await fetchLiveQuote(ticker);
        const regular =
          q.regularPrice && q.previousClose ? ((q.regularPrice - q.previousClose) / q.previousClose) * 100 : null;
        return {
          symbol: q.symbol,
          price: q.price,
          changePct: q.changePercent,
          regularChangePct: regular,
          previousClose: q.previousClose ?? null,
          session: q.session,
          asOf: new Date(q.asOf).toISOString(),
        };
      }),

    dailyCloses: (ticker) =>
      closesCache(ticker, async () => {
        // Hourly candles over a month, folded to the last print of each New York day.
        const points = await fetchStockChart(ticker, "1M");
        const byDay = new Map<string, number>();
        for (const p of points) {
          if (p.s && p.s !== "reg") continue;
          byDay.set(nyYmd(new Date(p.t)), p.v);
        }
        return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, close]) => ({ date, close }));
      }),

    news: (ticker) =>
      newsCache(ticker, async () =>
        (await fetchStockNews(ticker, 20)).map((n) => ({
          id: n.id,
          title: n.title,
          url: n.url,
          source: n.source,
          publishedAt: n.publishedAt,
        })),
      ),

    marketNews: (sinceIso) =>
      // Keyed by the hour so checks a few minutes apart share one read.
      marketNewsCache(sinceIso.slice(0, 13), async () =>
        (await fetchMarketHeadlines(sinceIso)).map((h) => ({
          id: h.id,
          title: h.title,
          url: h.url,
          source: h.source,
          publishedAt: h.published_at,
        })),
      ),

    consensus: (ticker) =>
      consensusCache(ticker, async () =>
        parseConsensus(
          await fetchQuoteSummaryModules(ticker, ["earningsTrend", "earningsHistory"]),
          new Date().toISOString(),
        ),
      ),

    macroEvents: (fromYmd, toYmd) =>
      MACRO_CALENDAR.events
        .filter((e) => e.date >= fromYmd && e.date <= toYmd)
        .map((e) => ({
          date: e.date,
          timeEt: e.time_et,
          code: e.code,
          title: e.title,
          period: e.period,
          importance: e.importance,
        })),

    macroCoverageUntil: () => MACRO_CALENDAR.coverage.until,

    lookupTicker: async (ticker) => {
      const catalog = await getUsStockCatalog();
      const t = ticker.toUpperCase();
      const hit = catalog.find((e) => e.symbol === t || e.symbol === t.replace("-", ".") || e.symbol === t.replace(".", "-"));
      return hit ? { symbol: hit.symbol, companyName: hit.companyName } : null;
    },

    searchCompany: async (query) =>
      (await searchUsStocks(query, 5))
        .filter((e) => e.exchange !== "INDEX")
        .map((e) => ({ symbol: e.symbol, companyName: e.companyName })),

    // graph-edges.ts keeps the file in memory until it changes on disk.
    linkEdges: () => graphEdges(),
    filingFormOf: (filer) => filingForm(filer),

    materialNews: async (sinceIso) =>
      materialFromFeed(await invokeChannel<NewsFeedResult>("news:feed", NEWS_FEED_REQUEST), Date.parse(sinceIso)),

    // The Stock tab's service: one EDGAR read a day per company, documents kept for good.
    filingChanges: (ticker, covering) => filingChangesService().changes(ticker, covering ? { covering } : undefined),

    readthrough: (holding) =>
      readthroughCache(holding, async () => {
        // The Stock tab's request: every filing link of one name, measured.
        const answer = await invokeChannel<ReadthroughResult>("readthrough:radar", { focus: holding });
        if (!answer || answer.ok !== true) throw new Error("the read-through radar is unavailable");
        return answer.rows.map((r) => ({
          counterparty: r.counterparty,
          holding: r.holding,
          sample: r.sample,
          stats: r.stats
            ? {
                events: r.stats.events,
                withIt: r.stats.withIt,
                avgAbsMove: r.stats.avgAbsMove,
                avgAbsAbnormal: r.stats.avgAbsAbnormal,
                sensitivity: r.stats.sensitivity,
                from: r.stats.from,
                to: r.stats.to,
              }
            : null,
        }));
      }),
  };
}
