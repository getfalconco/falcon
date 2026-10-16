import { createRoot } from "react-dom/client";
import "./fonts";
import "../globals.css";
import StockTab from "../components/stock-tab/StockTab";
import { createFixtureAgents } from "../components/agents/agent-fixtures";
import { onAgentsOpenRequest } from "../components/agents/agents-store";
import { installAgentsAdapter } from "../lib/agents-client";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage, useT } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import { stockTabStore } from "../lib/stock-tab-store";
import { STOCK_OPEN_EVENT, type StockOpenDetail } from "../lib/stock-open";
import { holdingsOneHop, type StockContextRequest } from "../../shared/stock-context";
import type { LinkEdge } from "../../shared/earnings-links";
import type { StockThesis, StockThesisResult } from "../../shared/stock-thesis";
import type { ChartTimeframe, PricePoint, StockOverviewData } from "../../shared/stock-types";
import { extractEgo, normalizeLinks, type RawGraphEdge, type StockGraphResult } from "../../shared/stock-graph";
import type { NewsFeedArticle } from "../../shared/news-feed";
import type { ReadthroughRequest, ReadthroughResult, ReadthroughRow, ReadthroughStats } from "../../shared/readthrough-types";
import { addDaysYmd, nyToday } from "../../shared/earnings-view";
import graphUrl from "../../../data/graph.json?url";
import guidanceFixture from "./guidance-fixture.json";
import type { GuidanceTrack } from "../../shared/guidance-types";
import type { StockToday, StockTodayResult } from "../../shared/today-move";

/**
 * Scratch harness for the Stock tab against a stubbed main process, laid out
 * the way the home page draws a tab (under the heading row). Every figure is
 * a fixture for the harness only: no provider, key or model.
 *
 *   ?stock=NVDA        open a held name (the default)
 *   ?stock=TSM         open a name not held, one filing hop from holdings
 *   ?stock=none        no stock opened yet: the empty state
 *   ?theme=dark        draw in that theme
 *   ?lang=tr-TR        show the chrome in that language
 *   ?thesis=written    a thesis already saved for the stock
 *   ?thesis=fail       every save fails
 *   ?guidance=slow     the guidance section stays loading for a minute
 *   ?today=empty       the session is unusual and nothing is on record
 *   ?today=calm        an ordinary session: no Today block at all
 *
 * The Graph and Chain news sections read the checked-in filing graph
 * (data/graph.json) and a short made-up news feed, as their own harness
 * (stock-graph.tsx) does.
 *
 * Probes: `window.__stockTab.theses` is the stubbed thesis store,
 * `window.__stockTab.agent` the last agent/report the Agents tab was asked for,
 * `window.__stockTab.readthroughAsks` the read-through requests (none while hidden).
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
const stockParam = (params.get("stock") ?? "NVDA").toUpperCase();
const thesisParam = params.get("thesis");
const guidanceParam = params.get("guidance");
const todayParam = params.get("today");

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

const positions: Record<string, PaperPosition> = {};
for (const [symbol, shares, cost] of [
  ["NVDA", 120, 120 * 96.4],
  ["AMD", 90, 90 * 141.2],
  ["AAPL", 80, 80 * 188.5],
  ["JPM", 50, 50 * 212.0],
  ["XOM", 40, 40 * 109.3],
] as const) {
  positions[symbol] = { symbol, shares, costUsd: cost };
}
seedPaperAccount({ cash: 18_400, positions });

const COMPANIES: Record<string, { name: string; exchange: string; price: number; change: number }> = {
  NVDA: { name: "NVIDIA Corporation", exchange: "NasdaqGS", price: 182.41, change: 2.37 },
  TSM: { name: "Taiwan Semiconductor Manufacturing Company Limited", exchange: "NYSE", price: 301.12, change: -4.18 },
  AMD: { name: "Advanced Micro Devices, Inc.", exchange: "NasdaqGS", price: 158.33, change: -1.02 },
  AAPL: { name: "Apple Inc.", exchange: "NasdaqGS", price: 247.9, change: 0.88 },
  JPM: { name: "JPMorgan Chase & Co.", exchange: "NYSE", price: 301.5, change: 1.4 },
  XOM: { name: "Exxon Mobil Corporation", exchange: "NYSE", price: 112.6, change: -0.35 },
  MSFT: { name: "Microsoft Corporation", exchange: "NasdaqGS", price: 512.2, change: 3.1 },
};

const quoteOf = (symbol: string) => {
  const c = COMPANIES[symbol];
  if (!c) return null;
  const jitter = Math.sin(Date.now() / 7000) * 0.08;
  const price = Math.round((c.price + jitter) * 100) / 100;
  return {
    symbol,
    companyName: c.name,
    price,
    change: c.change,
    changePercent: (c.change / (price - c.change)) * 100,
    session: "regular" as const,
    asOf: Date.now(),
    previousClose: price - c.change,
    regularPrice: price,
  };
};

/** A seeded walk, so each range draws the same line on every reload. */
function series(symbol: string, timeframe: ChartTimeframe): PricePoint[] {
  const n = { "1D": 78, "1W": 140, "1M": 22, YTD: 190, "1Y": 252, ALL: 400 }[timeframe];
  const end = COMPANIES[symbol]?.price ?? 100;
  let seed = [...`${symbol}${timeframe}`].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: number[] = [end];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! * (1 + (rand() - 0.52) * 0.03));
  out.reverse();
  const step = { "1D": 5 * 60_000, "1W": 30 * 60_000, "1M": 86_400_000, YTD: 86_400_000, "1Y": 86_400_000, ALL: 7 * 86_400_000 }[timeframe];
  return out.map((v, i) => ({ t: Date.now() - (n - i) * step, v }));
}

function overview(symbol: string): StockOverviewData {
  const c = COMPANIES[symbol] ?? { name: symbol, exchange: "NYSE", price: 100, change: 0 };
  const nvda = symbol === "NVDA";
  return {
    quote: { symbol, companyName: c.name, price: c.price, change: c.change, changePercent: (c.change / c.price) * 100 },
    series: [],
    previousClose: c.price - c.change,
    atClose: { price: c.price, change: c.change, changePercent: (c.change / c.price) * 100 },
    stats: {
      prevClose: `$${(c.price - c.change).toFixed(2)}`,
      peRatio: nvda ? "51.84" : "n/a",
      weekRange52: `$${(c.price * 0.62).toFixed(2)} - $${(c.price * 1.08).toFixed(2)}`,
      marketCap: nvda ? "$4.45T" : "$1.56T",
      dayRange: `$${(c.price - 3.1).toFixed(2)} - $${(c.price + 1.2).toFixed(2)}`,
      eps: nvda ? "$3.52" : "$9.41",
      open: `$${(c.price - 1.4).toFixed(2)}`,
      dividendYield: nvda ? "0.02%" : "1.21%",
      volume: nvda ? "168.2M" : "11.4M",
    },
    company: {
      symbol,
      ipoDate: nvda ? "Jan 22, 1999" : "Oct 8, 1997",
      ceo: nvda ? "Jensen Huang" : "C. C. Wei",
      fullTimeEmployees: nvda ? "36,000" : "83,825",
      sector: "Technology",
      industry: "Semiconductors",
      country: nvda ? "United States" : "Taiwan",
      exchange: c.exchange,
      description: nvda
        ? "NVIDIA Corporation provides graphics and compute and networking solutions in the United States, Taiwan, China, and internationally. The Graphics segment offers GeForce GPUs for gaming and PCs, the GeForce NOW game streaming service and related infrastructure, and solutions for gaming platforms. The Compute and Networking segment comprises data center accelerated computing platforms, networking products, automotive platforms and autonomous driving solutions, and Jetson for robotics and other embedded platforms. The company was founded in 1993 and is headquartered in Santa Clara, California."
        : "Taiwan Semiconductor Manufacturing Company Limited manufactures, packages, tests, and sells integrated circuits and other semiconductor devices in Taiwan, China, Europe, the Middle East, Africa, Japan, the United States, and internationally.",
    },
  };
}

const SEC = "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000012/nvda-20260125.htm";
const EDGES: LinkEdge[] = [
  { root_ticker: "NVDA", counterparty_ticker: "TSM", category: "supplier", strength_tier: "critical", confidence: 0.96, evidence_quote: "We utilize foundries such as TSMC", source_url: SEC, accession_number: "0001045810-26-000012", form: "10-K", filing_date: "2026-02-25" },
  { root_ticker: "AAPL", counterparty_ticker: "TSM", category: "supplier", strength_tier: "critical", confidence: 0.93, evidence_quote: "TSMC manufactures substantially all", source_url: SEC, accession_number: "0000320193-25-000079", form: "10-K", filing_date: "2025-10-31" },
  { root_ticker: "AMD", counterparty_ticker: "TSM", category: "supplier", strength_tier: "important", confidence: 0.91, evidence_quote: "We rely on TSMC", source_url: SEC, accession_number: "0000002488-26-000004", form: "10-K", filing_date: "2026-02-04" },
];

// Fetched, not imported: the file is large, and the type checker need not read it.
let graphRead: Promise<RawGraphEdge[]> | null = null;
const graphFile = () =>
  (graphRead ??= fetch(graphUrl)
    .then((r) => r.json() as Promise<{ edges: RawGraphEdge[] }>)
    .then((g) => g.edges));
const formOfFiler = (t: string) => (["TSM", "UMC", "SONY", "ASML"].includes(t) ? "20-F" : "10-K") as "10-K" | "20-F";
const nowSec = Math.floor(Date.now() / 1000);
const story = (id: number, hoursAgo: number, headline: string, tickers: string[]): NewsFeedArticle => ({
  id,
  headline,
  summary: "",
  url: `https://example.com/${id}`,
  source: "Reuters",
  datetime: nowSec - Math.round(hoursAgo * 3600),
  tickers,
  event: null,
  first_seen: new Date().toISOString(),
  sectors: [],
});
const FEED: NewsFeedArticle[] = [
  story(1, 0.5, "TSMC lifts 2026 capex as advanced packaging demand grows", ["TSM"]),
  story(2, 4, "ASML ships first high-NA tools to a second customer", ["ASML"]),
  story(3, 9, "Intel moves its next foundry node to 2027", ["INTC"]),
  story(4, 26, "Samsung memory prices climb for a third month", ["SSNLF"]),
];

const theses = new Map<string, StockThesis>();
if (thesisParam === "written") {
  theses.set(stockParam, {
    ticker: stockParam,
    text: "Data center demand keeps rising and the networking line is growing faster than compute.",
    updated_at: new Date().toISOString(),
  });
}

async function getThesis(ticker: string): Promise<StockThesisResult> {
  await wait(250);
  return { ok: true, thesis: theses.get(ticker.toUpperCase()) ?? null };
}

async function setThesis(ticker: string, text: string): Promise<StockThesisResult> {
  await wait(300);
  if (thesisParam === "fail") return { ok: false, error: "unavailable" };
  const t = ticker.toUpperCase();
  const clean = text.replace(/\s+$/u, "");
  if (!clean) {
    theses.delete(t);
    return { ok: true, thesis: null };
  }
  const thesis = { ticker: t, text: clean, updated_at: new Date().toISOString() };
  theses.set(t, thesis);
  return { ok: true, thesis };
}

const riskSnapshot = {
  schema_version: 3,
  computed_at: new Date().toISOString(),
  account: "paper",
  trigger: ["manual"],
  invested_fraction: 0.79,
  position_count: 5,
  score: 58,
  band: "moderate",
  components: null,
  driver: null,
  weights: [],
  blend_weights: { concentration: 0.2, market: 0.2, volatility: 0.2, network: 0.2, event: 0.1, sharpe: 0.1 },
  degraded: [],
  graph_version: null,
  empty: false,
  positions: [
    { ticker: "NVDA", side: "long", account_weight: 0.26, beta: 1.87, daily_vol_pct: 2.94, risk_share: 0.4417, earnings: null, correlation: null },
    { ticker: "AMD", side: "long", account_weight: 0.17, beta: 1.62, daily_vol_pct: 3.3, risk_share: 0.2311, earnings: null, correlation: null },
  ],
};

/** Read-through rows for the open name: measured links, a few too thin for figures, one never measured. */
function readthroughFixture(request: ReadthroughRequest): ReadthroughResult {
  const today = nyToday();
  const focus = (request.focus ?? "NVDA").toUpperCase();
  const spec: Array<[string, ReadthroughRow["relation"], number, number, number, number | null, ReadthroughRow["kind"], number | null, ReadthroughRow["time"]]> = [
    // counterparty, relation, with, sample, mean |abnormal|, usual day, kind, days from today, time
    ["TSM", "supplier", 6, 8, 0.024, 0.011, "upcoming", 1, "bmo"],
    ["MU", "competitor", 4, 7, 0.016, 0.011, "upcoming", 9, "amc"],
    ["AVGO", "competitor", 5, 8, 0.013, 0.011, "later", null, "unknown"],
    ["ASML", "supplier", 3, 5, 0.019, null, "recent", -2, "bmo"],
    ["SMCI", "customer", 0, 2, 0, 0, "upcoming", 20, "unknown"],
    ["INTC", "competitor", 0, 0, 0, 0, "later", null, "unknown"],
  ];
  const rows: ReadthroughRow[] = spec
    .filter(([c]) => c !== focus)
    .map(([counterparty, relation, withIt, sample, abnormal, normal, kind, days, time]) => {
      const stats: ReadthroughStats | null =
        sample >= 3
          ? {
              events: sample,
              withIt,
              avgAbsMove: abnormal + 0.004,
              avgAbsAbnormal: abnormal,
              avgFollow: 0.004,
              avgNextFollow: 0.001,
              nextEvents: sample,
              normalAbsAbnormal: normal,
              sensitivity: normal ? abnormal / normal : null,
              surpriseEvents: 0,
              withSurprise: 0,
              beta: 1.4,
              betaFallback: false,
              from: addDaysYmd(today, -730),
              to: addDaysYmd(today, -60),
            }
          : null;
      return {
        id: `${counterparty}>${focus}`,
        counterparty,
        counterpartyName: COMPANIES[counterparty]?.name ?? null,
        holding: focus,
        held: focus in positions,
        watchlist: false,
        relation,
        tier: "critical",
        namedBy: focus,
        form: "10-K",
        filingDate: "2026-02-25",
        sourceUrl: SEC,
        kind,
        date: days === null ? null : addDaysYmd(today, days),
        time,
        status: days === null ? null : "confirmed",
        report: null,
        sample,
        stats,
        events: [],
        weight: 1,
        score: stats?.sensitivity ?? 0,
      };
    });
  return { ok: true, today, builtAt: new Date().toISOString(), rows, links: rows.length, truncated: false, degraded: [] };
}

/** The open stock's session: an unusual one with a record of every kind, unless `?today=` says otherwise. */
function todayFixture(ticker: string): StockTodayResult {
  const day = nyToday();
  const at = (hoursAfterPreviousClose: number) => new Date(Date.now() - (14 - hoursAfterPreviousClose) * 3_600_000).toISOString();
  const d: StockToday = {
    ticker,
    day,
    previousDay: addDaysYmd(day, -1),
    since: at(0),
    asOf: new Date().toISOString(),
    move: -0.0612,
    market: { symbol: "SPY", move: 0.0031 },
    sector: { symbol: "XLK", move: -0.0084 },
    beta: 1.62,
    sigma: 0.0181,
    sessions: 60,
    abnormal: -0.0662,
    ratio: 3.66,
    unusual: todayParam !== "calm",
    filings:
      todayParam === "empty"
        ? []
        : [
            { kind: "current", form: "8-K", items: ["5.02"], at: at(1.2), url: SEC },
            { kind: "insider", name: "Colette Kress", role: "EVP and CFO", code: "S", value: 18_420_000, plan: true, at: at(2.5), url: SEC },
            { kind: "insider_other", count: 2, at: at(3), url: SEC },
            { kind: "schedule", schedule: "13G", amendment: true, at: at(12), url: SEC },
          ],
    linked:
      todayParam === "empty"
        ? []
        : [
            { ticker: "TSM", name: "Taiwan Semiconductor", category: "supplier", namedBy: ticker, linkUrl: SEC, event: "report", items: [], at: null, url: null },
            { ticker: "AMD", name: null, category: "competitor", namedBy: "AMD", linkUrl: SEC, event: "filing", items: ["1.01"], at: at(11), url: SEC },
          ],
    news: todayParam === "empty" ? [] : [{ title: "Commerce Department widens export license review to advanced accelerators", url: "https://example.com/7", source: "Reuters", at: at(13.5) }],
    peers: todayParam === "empty" ? [] : [
      { ticker: "AMD", move: -0.041 },
      { ticker: "AVGO", move: -0.032 },
    ],
    peersRead: 5,
    degraded: [],
  };
  return { ok: true, today: d };
}

const probe = { theses, agent: null as string | null, readthroughAsks: [] as ReadthroughRequest[] };
(window as unknown as { __stockTab: unknown }).__stockTab = probe;

(window as unknown as { meridian: unknown }).meridian = {
  getLiveQuote: async (symbol: string) => {
    const q = quoteOf(symbol.toUpperCase());
    return q ? { ok: true as const, quote: q } : { ok: false as const, error: "none" };
  },
  getStockQuote: async (symbol: string) => {
    const q = quoteOf(symbol.toUpperCase());
    if (!q) throw new Error("none");
    return { symbol: q.symbol, companyName: q.companyName, price: q.price, change: q.change, changePercent: q.changePercent };
  },
  getStockOverview: async (symbol: string) => {
    await wait(400);
    return overview(symbol.toUpperCase());
  },
  getStockChart: async (symbol: string, timeframe: ChartTimeframe) => {
    await wait(250);
    return series(symbol.toUpperCase(), timeframe);
  },
  getStockPanelData: async () => {
    throw new Error("not in the harness");
  },
  getStockContext: async (request: StockContextRequest) => {
    await wait(200);
    return { ok: true as const, links: holdingsOneHop(EDGES, request.ticker, request.held) };
  },
  getStockThesis: getThesis,
  setStockThesis: setThesis,
  getRiskLatest: async () => ({ ok: true as const, snapshot: riskSnapshot, riskCardEnabled: true }),
  getStep1ResearchResult: async () => ({ ok: false as const, error: "none" }),
  getStep1ResearchQuota: async () => ({ ok: true as const, quota: { limit: 5, used: 1, remaining: 4, resetAt: null, allowed: true } }),
  openExternal: async () => undefined,
  getStockGraph: async (ticker: string, options?: { related?: string[] }): Promise<StockGraphResult> => {
    const { links, names } = normalizeLinks(await graphFile(), { minConfidence: 0.5, formOf: formOfFiler });
    return { ok: true, graph: extractEgo(links, names, ticker, { keep: options?.related ?? [] }) };
  },
  getNewsFeed: async () => ({ ok: true, articles: FEED, status: {} }),
  getCachedNewsFeed: async () => ({ ok: true, articles: FEED, status: {}, fetchedAt: Date.now() }),
  getNewsArticle: async () => ({ ok: false, error: "preview" }),
  getNewsArticleReading: async () => ({ ok: false, error: "preview" }),
  // Tracks read from the real EDGAR releases (main/guidance), kept as a fixture; any other ticker guides nothing.
  getStockTabGuidance: async (ticker: string) => {
    await wait(guidanceParam === "slow" ? 60_000 : 700);
    const track = (guidanceFixture as unknown as Record<string, GuidanceTrack>)[ticker.toUpperCase()];
    return { ok: true as const, track: track ?? { ticker, releases: 8, latest: null, rows: [], patterns: [] } };
  },
  getStockToday: async (ticker: string): Promise<StockTodayResult> => {
    await wait(350);
    return todayFixture(ticker.toUpperCase());
  },
  getReadthroughRadar: async (request: ReadthroughRequest): Promise<ReadthroughResult> => {
    probe.readthroughAsks.push(request);
    await wait(300);
    return readthroughFixture(request);
  },
};

installAgentsAdapter(createFixtureAgents({ latency: 150 }));
onAgentsOpenRequest((focus) => {
  probe.agent = focus.kind === "agent" ? `${focus.id}:${focus.reportId ?? ""}` : null;
});

// The page's own door: a ticker pressed anywhere opens it here.
window.addEventListener(STOCK_OPEN_EVENT, (event) => {
  const detail = (event as CustomEvent<StockOpenDetail>).detail;
  if (detail?.ticker) stockTabStore().open({ symbol: detail.ticker, companyName: detail.companyName });
});

if (stockParam === "NONE") {
  // Nothing opened yet: the tab starts from the search bar's recent picks.
  localStorage.setItem(
    "meridian-recent-stock-search",
    JSON.stringify(["NVDA", "TSM", "AAPL"].map((symbol) => ({ symbol, companyName: COMPANIES[symbol]!.name }))),
  );
} else {
  for (const s of ["AMD", "AAPL", "TSM", "NVDA"]) {
    if (s !== stockParam) stockTabStore().open({ symbol: s, companyName: COMPANIES[s]?.name });
  }
  stockTabStore().open({ symbol: stockParam, companyName: COMPANIES[stockParam]?.name, exchange: COMPANIES[stockParam]?.exchange });
}

function Heading() {
  const t = useT();
  return <span className="font-baskerville text-[30px] text-[#1d1b1b]">{t("stocktab.tab.label")}</span>;
}

createRoot(document.getElementById("root")!).render(
  <main
    className="h-screen overflow-y-auto pt-16"
    // The page behind the home page in each theme: cream, or the app's near-black.
    style={{ minWidth: 1060, background: document.documentElement.dataset.theme === "dark" ? "hsl(0 0% 3.5%)" : "#EAEAE6" }}
  >
    <div className="select-none pl-9">
      <Heading />
    </div>
    <StockTab />
  </main>,
);
