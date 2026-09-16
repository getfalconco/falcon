import { createRoot } from "react-dom/client";
import "../globals.css";
import PortfolioCard from "../components/dashboard/PortfolioCard";

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
};

createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-screen items-center justify-center bg-[#EAEAE6] p-10">
    <div className="w-[380px] shrink-0">
      <PortfolioCard masked={false} onToggleMasked={() => {}} />
    </div>
  </div>,
);
