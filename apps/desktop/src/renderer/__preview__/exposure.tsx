import { createRoot } from "react-dom/client";
import "./fonts";
import "../globals.css";
import ExposureTab from "../components/exposure/ExposureTab";
import ExposureCard from "../components/exposure/ExposureCard";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage, useT } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import { STOCK_OPEN_EVENT, type StockOpenDetail } from "../lib/stock-open";
import { computeExposure, type ExposureEdge, type ExposureRequest, type ExposureResult } from "../../shared/exposure";
import FIXTURE from "./exposure-fixture.json";

/**
 * Scratch harness for the Exposure tab and the Exposure card against a
 * stubbed main process, laid out the way the home page draws the tab (under
 * the heading row), with the card below it at a dashboard card's size.
 *
 * The stub runs the real computation (shared/exposure.ts) over a slice of
 * the checked-in filing graph (the 10-K and 20-F links of NVDA, AMD, AVGO,
 * QCOM, MSFT, AMKR, LMT, NOC and HPE, quotes elided), so the rows are what
 * main would answer for this book. No provider, key or model.
 *
 *   ?theme=dark        draw in that theme
 *   ?lang=tr-TR        show the chrome in that language
 *   ?state=error       every request fails
 *   ?state=restart     a bridge without the exposure channel
 *   ?state=loading     the request never answers
 *   ?names=0           no positions, no watchlist
 *   ?book=funds        the account holds only funds
 *
 * Probes: `window.__exposure.asks` lists the requests, `.opened` the
 * stocks a row opened, `.research` the tickers sent to the research queue.
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
const state = params.get("state");
const noNames = params.get("names") === "0";
const funds = params.get("book") === "funds";

const PRICES: Record<string, number> = { NVDA: 182, AMD: 160, AVGO: 330, QCOM: 165, MSFT: 510, LMT: 470, NOC: 560, AAPL: 230, ZZZ: 40, SPY: 640, QQQ: 560 };
const positions: Record<string, PaperPosition> = {};
if (!noNames) {
  const book: ReadonlyArray<readonly [string, number]> = funds
    ? [
        ["SPY", 60],
        ["QQQ", 40],
      ]
    : [
        ["NVDA", 160],
        ["AMD", 90],
        ["AVGO", 40],
        ["QCOM", 50],
        ["MSFT", 20],
        ["LMT", 12],
        ["NOC", 10],
        ["AAPL", 30],
        ["ZZZ", 100],
        ["SPY", 15],
      ];
  for (const [symbol, shares] of book) positions[symbol] = { symbol, shares, costUsd: shares * (PRICES[symbol] ?? 100) * 0.9 };
}
seedPaperAccount({ cash: 9_500, positions });
localStorage.setItem(
  "meridian-watchlist",
  JSON.stringify(noNames ? [] : [{ ticker: "AMKR", companyName: "Amkor Technology" }, { ticker: "HPE", companyName: "Hewlett Packard Enterprise" }]),
);

const NAMES: Record<string, string> = {
  HPE: "Hewlett Packard Enterprise Company Common Stock",
  AMKR: "Amkor Technology, Inc. Common Stock",
  NVDA: "NVIDIA Corporation Common Stock",
  AMD: "Advanced Micro Devices, Inc. Common Stock",
  AVGO: "Broadcom Inc. Common Stock",
  QCOM: "QUALCOMM Incorporated Common Stock",
  MSFT: "Microsoft Corporation Common Stock",
};
const FORMS: Record<string, "10-K" | "20-F"> = { NVDA: "10-K", AMD: "10-K", AVGO: "10-K", QCOM: "10-K", MSFT: "10-K", AMKR: "10-K", LMT: "10-K", NOC: "10-K", HPE: "10-K" };

const probe = { asks: [] as ExposureRequest[], opened: [] as string[], research: [] as string[] };
(window as unknown as { __exposure: typeof probe }).__exposure = probe;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function summary(request: ExposureRequest): Promise<ExposureResult> {
  probe.asks.push(request);
  if (state === "loading") return new Promise(() => undefined);
  await wait(300);
  if (state === "error") return { ok: false, error: "unavailable" };
  return {
    ok: true,
    summary: computeExposure(FIXTURE as ExposureEdge[], request, {
      formOf: (t) => FORMS[t] ?? null,
      nameOf: (t) => NAMES[t] ?? null,
      // HNHPF trades over the counter: not in the listing directory the app opens.
      isListed: (t) => t !== "HNHPF",
    }),
  };
}

async function liveQuote(symbol: string) {
  const price = PRICES[symbol];
  if (price === undefined) return { ok: false as const, error: "none" };
  return { ok: true as const, quote: { symbol, companyName: symbol, price, change: 0, changePercent: 0, session: "regular" as const, asOf: Date.now() } };
}

(window as unknown as { meridian: unknown }).meridian =
  state === "restart"
    ? { getLiveQuote: liveQuote }
    : {
        getExposureSummary: summary,
        getLiveQuote: liveQuote,
        openExternal: async () => undefined,
        syncPortfolioHoldings: async (symbols: string[]) => {
          probe.research.push(...symbols);
          return { ok: true, queued: symbols, covered: [] };
        },
      };

window.addEventListener(STOCK_OPEN_EVENT, (event) => {
  probe.opened.push((event as CustomEvent<StockOpenDetail>).detail.ticker);
});

function Heading() {
  const t = useT();
  return <span className="font-baskerville text-[30px] text-[#1d1b1b]">{t("home.tab.exposure")}</span>;
}

createRoot(document.getElementById("root")!).render(
  <div
    className="h-screen overflow-y-auto pt-16"
    // The page behind the home page in each theme: cream, or the app's near-black.
    style={{ minWidth: 1060, background: document.documentElement.dataset.theme === "dark" ? "hsl(0 0% 3.5%)" : "#EAEAE6" }}
  >
    <div className="select-none pl-9">
      <Heading />
    </div>
    <ExposureTab />
    <div className="px-8 pb-12">
      <div style={{ width: 300, height: 560 }}>
        <ExposureCard onOpenExposure={() => document.querySelector("#root > div")?.scrollTo({ top: 0, behavior: "smooth" })} />
      </div>
    </div>
  </div>,
);
