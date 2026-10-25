import { createRoot } from "react-dom/client";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import "../globals.css";
import PortfolioCard from "../components/dashboard/PortfolioCard";
import { addDaysYmd, nyToday } from "../../shared/earnings-view";
import type { StockToday } from "../../shared/today-move";

// ?lang=tr-TR shows the card in that language (kept, as a pick would be).
{
  const lang = new URLSearchParams(location.search).get("lang");
  if (isLanguageCode(lang)) setLanguage(lang);
  applyLanguage();
}

/**
 * Scratch harness: the real Assets card over a seeded paper account with one
 * short and two longs, so the short marker can be checked without trading.
 */

localStorage.setItem(
  "falcon.paperPositions",
  JSON.stringify({
    NVDA: { symbol: "NVDA", shares: 12, costUsd: 2100 },
    INTC: { symbol: "INTC", shares: -40, costUsd: -900 },
    AAPL: { symbol: "AAPL", shares: 5, costUsd: 1200 },
  }),
);
localStorage.setItem("falcon.paperBalance", "5000");

const QUOTES: Record<string, number> = { NVDA: 182.4, INTC: 21.15, AAPL: 244.9 };

(window as any).meridian = {
  getLiveQuote: async (symbol: string) =>
    QUOTES[symbol] != null
      ? { ok: true, quote: { symbol, price: QUOTES[symbol], session: "closed" } }
      : { ok: false },
  getStockQuote: async (symbol: string) =>
    QUOTES[symbol] != null ? { ok: true, quote: { symbol, price: QUOTES[symbol] } } : { ok: false },
  // NVDA's session is unusual for it: the mark by the ticker, the record on hover.
  getStockTodayMoves: async (tickers: string[]) => {
    const now = Date.now();
    const day = nyToday();
    const nvda: StockToday = {
      ticker: "NVDA",
      day,
      previousDay: addDaysYmd(day, -1),
      since: new Date(now - 14 * 3_600_000).toISOString(),
      asOf: new Date(now).toISOString(),
      move: -0.0612,
      market: { symbol: "SPY", move: 0.0031 },
      sector: { symbol: "XLK", move: -0.0084 },
      beta: 1.62,
      sigma: 0.0181,
      sessions: 60,
      abnormal: -0.0662,
      ratio: 3.66,
      unusual: true,
      filings: [{ kind: "current", form: "8-K", items: ["5.02"], at: new Date(now - 3_600_000).toISOString(), url: "https://www.sec.gov/" }],
      linked: [],
      news: [{ title: "x", url: "https://example.com", source: "Reuters", at: new Date(now - 7_200_000).toISOString() }],
      peers: [],
      peersRead: 4,
      degraded: [],
    };
    return { ok: true, unusual: tickers.includes("NVDA") ? [nvda] : [] };
  },
};

createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-screen items-center justify-center bg-surface-0 p-10">
    <div className="w-[380px] shrink-0">
      <PortfolioCard masked={false} onToggleMasked={() => {}} />
    </div>
  </div>,
);
