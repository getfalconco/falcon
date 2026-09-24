import { createRoot } from "react-dom/client";
import "../globals.css";
import NewsCard from "../components/dashboard/NewsCard";
import type { NewsFeedArticle } from "../../shared/news-feed";

/**
 * Scratch harness: the News card over a made-up feed, so the scopes, the
 * search and the row layout can be looked at without the engine.
 */

const now = Math.floor(Date.now() / 1000);
const story = (
  id: number,
  minutesAgo: number,
  headline: string,
  source: string,
  tickers: string[],
  sectors: string[],
  event: NewsFeedArticle["event"] = null,
): NewsFeedArticle => ({
  id,
  headline,
  summary: "",
  url: `https://example.com/${id}`,
  source,
  datetime: now - minutesAgo * 60,
  tickers,
  event,
  first_seen: new Date().toISOString(),
  sectors,
});

const FEED: NewsFeedArticle[] = [
  story(1, 4, "Nvidia guides above consensus on data-center demand; shares rise after hours", "Reuters", ["NVDA", "AMD", "TSM"], ["Semiconductors"], {
    material: true, event_type: "guidance", affected_ticker: "NVDA", direction: "positive", summary: "", confidence: 0.92,
  }),
  story(2, 27, "Microsoft to cut 3% of workforce as it reallocates spend toward AI infrastructure", "Bloomberg", ["MSFT"], ["Technology"], {
    material: true, event_type: "management_change", affected_ticker: "MSFT", direction: "negative", summary: "", confidence: 0.7,
  }),
  story(3, 95, "Chipmakers slide as export-licence review widens to older accelerators", "Financial Times", ["NVDA", "AMD", "INTC", "AVGO", "QCOM"], ["Semiconductors"]),
  story(4, 240, "Oracle signs multi-year cloud agreement with a European bank", "CNBC", ["ORCL"], ["Technology"], {
    material: true, event_type: "partnership", affected_ticker: "ORCL", direction: "positive", summary: "", confidence: 0.81,
  }),
  story(5, 60 * 26, "Dell raises full-year outlook on AI server backlog", "MarketWatch", ["DELL", "HPQ"], ["Technology Hardware"]),
  story(6, 60 * 50, "Snowflake names new CFO", "Business Wire", ["SNOW"], ["Software"]),
];

(window as unknown as { meridian: unknown }).meridian = {
  getNewsFeed: async () => ({
    ok: true,
    articles: FEED,
    status: {
      running: false, lastPollAt: new Date().toISOString(), lastError: null, lastNewEvents: 2,
      articlesChecked: 40, lastSummary: "2 events (40 articles checked)", currentTicker: null,
      tickersCompleted: 15, totalTickers: 15,
    },
  }),
};

// A book with two of the feed's names, so Positions has something to show.
localStorage.setItem(
  "falcon.paperPositions",
  JSON.stringify({
    NVDA: { symbol: "NVDA", shares: 10, costUsd: 1500 },
    ORCL: { symbol: "ORCL", shares: 5, costUsd: 700 },
  }),
);
localStorage.setItem("falcon.paperBalance", "3000");

createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-screen items-start justify-center gap-6 bg-[#EAEAE6] p-10">
    <div className="h-[560px] w-[380px] shrink-0">
      <NewsCard onDuplicate={() => {}} onRemove={() => {}} />
    </div>
    <div className="h-[560px] w-[640px] shrink-0">
      <NewsCard onDuplicate={() => {}} onRemove={() => {}} />
    </div>
  </div>,
);
