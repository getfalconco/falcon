import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./fonts";
import "../globals.css";
import AllocationCard from "../components/dashboard/AllocationCard";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { seedPaperAccount } from "../lib/paper-account";

/**
 * Scratch harness for the Allocation card over a seeded paper account and a
 * stubbed main process (quotes, linked brokerages). Fixtures only.
 *
 *   ?theme=dark        draw in that theme
 *   ?lang=tr-TR        show the card in that language
 *   ?state=empty       no account at all (the connect empty state)
 *   ?book=cash         a new account, all cash
 *   ?book=wide         every class, with two tiny ones folded into Other
 *   ?linked=25000      a linked brokerage total
 *   ?plan=60           a planned 60/40 split kept on this machine
 *   ?masked=1          the privacy mask
 *
 * "Move" sells half the stocks into cash, to watch the arc glide.
 */
const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
{
  const lang = params.get("lang");
  if (isLanguageCode(lang)) setLanguage(lang);
  applyLanguage();
}

const state = params.get("state");
const book = params.get("book");
const linked = Number(params.get("linked") ?? 0);
const plan = params.get("plan");
try {
  // Each load starts from its own query, not from what the last one left.
  localStorage.clear();
  if (plan != null) localStorage.setItem("falcon.ui.allocationPlan.v1", plan);
  else localStorage.removeItem("falcon.ui.allocationPlan.v1");
} catch {
  /* harness */
}

const PRICES: Record<string, number> = { NVDA: 182.4, AAPL: 244.9, SPY: 671.2, "BTC-USD": 108_250, "ETH-USD": 3_910, "AAPL250117C00150000": 4.1 };

const pos = (symbol: string, shares: number) => ({ symbol, shares, costUsd: shares * PRICES[symbol]! * 0.9 });
const REFERENCE = {
  cash: 21_076,
  positions: {
    NVDA: pos("NVDA", 100),
    AAPL: pos("AAPL", 57.03),
    "BTC-USD": pos("BTC-USD", 0.135),
  },
};
const WIDE = {
  cash: 9_000,
  positions: {
    NVDA: pos("NVDA", 120),
    SPY: pos("SPY", 20),
    "BTC-USD": pos("BTC-USD", 0.05),
    "ETH-USD": pos("ETH-USD", 0.09),
    "AAPL250117C00150000": pos("AAPL250117C00150000", 50),
  },
};

if (state !== "empty") {
  if (book === "cash") seedPaperAccount({ cash: 10_000, positions: {} });
  else if (book === "wide") seedPaperAccount(WIDE);
  else seedPaperAccount(REFERENCE);
}

(window as unknown as { meridian: unknown }).meridian = {
  getLiveQuote: async (symbol: string) =>
    PRICES[symbol] != null
      ? { ok: true, quote: { symbol, companyName: symbol, price: PRICES[symbol], change: 0, changePercent: 0, session: "regular", asOf: Date.now() } }
      : { ok: false, error: "none" },
  getStockQuote: async (symbol: string) => (PRICES[symbol] != null ? { ok: true, quote: { symbol, price: PRICES[symbol] } } : { ok: false }),
  getBrokerageNetWorth: async () =>
    linked > 0
      ? { ok: true, networth: { connected: true, total: linked, accounts: [{ id: "a", name: "Brokerage", institution: "Broker", totalValue: linked }] } }
      : { ok: true, networth: { connected: false, total: 0, accounts: [] } },
};

function Harness() {
  const [masked, setMasked] = useState(params.get("masked") === "1");
  const dark = document.documentElement.dataset.theme === "dark";
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-10" style={{ background: dark ? "hsl(0 0% 3.5%)" : "#EAEAE6" }}>
      <div className="group/card relative h-[560px] w-[340px] shrink-0">
        <AllocationCard masked={masked} />
      </div>
      <div className="flex gap-2 text-[12px]">
        <button
          type="button"
          className="rounded-full bg-fill-selected px-3 py-1 text-content-primary"
          onClick={() => {
            seedPaperAccount({ ...REFERENCE, cash: REFERENCE.cash + 10_000, positions: { ...REFERENCE.positions, NVDA: pos("NVDA", 45) } });
            window.dispatchEvent(new Event("falcon:paper-account-changed"));
          }}
        >
          Move
        </button>
        <button type="button" className="rounded-full bg-fill-selected px-3 py-1 text-content-primary" onClick={() => setMasked((m) => !m)}>
          Mask
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
