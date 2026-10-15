import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { applyTheme } from "../lib/theme";
import { isLanguageCode } from "../lib/i18n/languages";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import { STOCK_OPEN_EVENT, type StockOpenDetail } from "../lib/stock-open";
import "../globals.css";
import GraphSection from "../components/stock-tab/sections/GraphSection";
import ChainNewsSection from "../components/stock-tab/sections/ChainNewsSection";
import { extractEgo, normalizeLinks, type RawGraphEdge, type StockGraphResult } from "../../shared/stock-graph";
import type { NewsFeedArticle } from "../../shared/news-feed";
import graphUrl from "../../../data/graph.json?url";

/**
 * Scratch harness for the Stock tab's Graph and Chain news sections, over the
 * checked-in filing graph and a made-up news feed. ?t=NVDA picks the stock,
 * ?theme=dark and ?lang=tr-TR as in the other harnesses, ?empty=1 shows a
 * stock with no graph.
 */

const params = new URLSearchParams(location.search);
{
  const lang = params.get("lang");
  if (isLanguageCode(lang)) setLanguage(lang);
  applyLanguage();
}
applyTheme(params.get("theme") === "dark" ? "dark" : "light");

const positions: Record<string, PaperPosition> = {};
for (const symbol of ["AMD", "AAPL", "MSFT", "INTC"]) {
  positions[symbol] = { symbol, shares: 10, costUsd: 1000 } as PaperPosition;
}
seedPaperAccount({ cash: 10_000, positions });

// Fetched, not imported: the file is large, and the type checker need not read it.
let edgesPromise: Promise<RawGraphEdge[]> | null = null;
function graphEdges(): Promise<RawGraphEdge[]> {
  edgesPromise ??= fetch(graphUrl).then((r) => r.json() as Promise<{ edges: RawGraphEdge[] }>).then((g) => g.edges);
  return edgesPromise;
}

const formOf = (ticker: string) => (["TSM", "UMC", "SONY", "BNTX", "SHEL", "JD", "AZN"].includes(ticker) ? "20-F" : "10-K") as "10-K" | "20-F";

const now = Math.floor(Date.now() / 1000);
const story = (id: number, hoursAgo: number, headline: string, tickers: string[], falconHeadline?: string): NewsFeedArticle => ({
  id,
  headline,
  summary: "",
  url: `https://example.com/${id}`,
  source: "Reuters",
  datetime: now - Math.round(hoursAgo * 3600),
  tickers,
  event: null,
  first_seen: new Date().toISOString(),
  sectors: [],
  falcon: falconHeadline
    ? {
        decision: "show",
        reason: "material",
        headline: falconHeadline,
        headline_source: "falcon",
        article_key: "",
        event_type: null,
        materiality: "standard",
        direction: null,
        tickers,
        primary: null,
        duplicate_of: null,
      }
    : undefined,
});

const FEED: NewsFeedArticle[] = [
  story(1, 0.5, "TSMC lifts 2026 capex as advanced packaging demand grows", ["TSM"], "TSMC raises its 2026 capital spending plan"),
  story(2, 3, "HPE posts quarterly results with AI server backlog", ["HPE"], "HPE reports quarterly results and a larger server backlog"),
  story(3, 6, "ASML ships first high-NA tools to a second customer", ["ASML"]),
  story(4, 9, "Intel delays its next foundry node", ["INTC"], "Intel moves its next foundry node to 2027"),
  story(5, 20, "Nvidia and TSMC talk capacity", ["NVDA", "TSM"]),
  story(6, 26, "Samsung memory prices climb for a third month", ["SSNLF"]),
  story(7, 30, "Marvell wins a custom silicon contract", ["MRVL"]),
  story(8, 40, "Amkor opens an Arizona packaging site", ["AMKR"], "Amkor opens its Arizona packaging site"),
  story(9, 50, "Oracle signs a multi-year cloud agreement", ["ORCL"]),
];

window.meridian = {
  ...(window.meridian ?? {}),
  openExternal: async (url: string) => {
    console.info("[preview] open", url);
  },
  getStockGraph: async (ticker: string, options?: { related?: string[] }): Promise<StockGraphResult> => {
    const edges = await graphEdges();
    if (params.get("empty") === "1") ticker = "QQQQ";
    const { links, names } = normalizeLinks(edges, { minConfidence: 0.5, formOf });
    return { ok: true, graph: extractEgo(links, names, ticker, { keep: options?.related ?? [] }) };
  },
  getNewsFeed: async () => ({ ok: true, articles: FEED, status: {} }),
  getCachedNewsFeed: async () => ({ ok: true, articles: FEED, status: {}, fetchedAt: Date.now() }),
  getNewsArticle: async () => ({ ok: false, error: "preview" }),
  getNewsArticleReading: async () => ({ ok: false, error: "preview" }),
} as unknown as Window["meridian"];

function Harness() {
  const [ticker, setTicker] = useState(params.get("t") ?? "NVDA");
  useEffect(() => {
    const onOpen = (e: Event) => setTicker((e as CustomEvent<StockOpenDetail>).detail.ticker);
    window.addEventListener(STOCK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(STOCK_OPEN_EVENT, onOpen);
  }, []);
  return (
    <div className="min-h-screen bg-[var(--surface-0)] p-6">
      <div className="mx-auto max-w-[860px] space-y-8">
        <section>
          <h2 className="mb-3 text-[13px] font-medium text-[#6b7280]">Graph {ticker}</h2>
          <GraphSection ticker={ticker} />
        </section>
        <section>
          <h2 className="mb-3 text-[13px] font-medium text-[#6b7280]">Chain news</h2>
          <ChainNewsSection ticker={ticker} />
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
