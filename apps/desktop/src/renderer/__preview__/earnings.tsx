import { createRoot } from "react-dom/client";
import "../globals.css";
import EarningsTab from "../components/earnings/EarningsTab";
import EarningsCard from "../components/dashboard/EarningsCard";
import { onAgentsOpenRequest } from "../components/agents/agents-store";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage, useT } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import type {
  EarningsDetailResult,
  EarningsQuarter,
  EarningsReaction,
  EarningsReactionsResult,
  EarningsRequest,
  EarningsResult,
  EarningsRow,
} from "../../shared/earnings-types";
import { nyWallMs, weekStartOf } from "../../shared/earnings-time";
import { addDaysYmd, nyToday } from "../../shared/earnings-view";
import type { ImpliedMove, ImpliedMovesResult, ImpliedRequestItem } from "../../shared/implied-move";

/**
 * Scratch harness for the Earnings tab and the Earnings card against a
 * stubbed main process, laid out the way the home page draws the tab (under
 * the heading row), with the card below it at a dashboard card's size. The
 * rows are fixtures for the harness only: no provider, key or model.
 *
 *   ?theme=dark        draw in that theme
 *   ?lang=tr-TR        show the chrome in that language
 *   ?state=error       every request fails
 *   ?state=restart     a bridge without the earnings channel
 *   ?state=loading     the request never answers
 *   ?state=empty       no reports in the window
 *   ?names=0           no positions, no watchlist
 *   ?market=missing    the market calendar could not be read (no All scope)
 *
 * Probes: `window.__earnings.asks` lists the requests; `window.__earnings.agent`
 * the brief of the last "Create agent".
 *
 * The fixtures: TSM reported today before the open (watched; a filing links
 * it to held NVDA and AMD), JPM earlier this week, AAPL today after the
 * close, ARGX with a two-estimate consensus that runs from a loss to a
 * profit, and the rest upcoming. Add `#open=TSM` to open a row's drawer.
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
const state = params.get("state");
const noNames = params.get("names") === "0";
const marketMissing = params.get("market") === "missing";

const positions: Record<string, PaperPosition> = {};
if (!noNames) {
  for (const [symbol, shares] of [
    ["NVDA", 120],
    ["AMD", 90],
    ["AAPL", 80],
    ["JPM", 50],
    ["XOM", 40],
  ] as const) {
    positions[symbol] = { symbol, shares, costUsd: shares * 150 };
  }
}
seedPaperAccount({ cash: 18_400, positions });
localStorage.setItem(
  "meridian-watchlist",
  JSON.stringify(
    noNames
      ? []
      : [
          { ticker: "TSM", companyName: "Taiwan Semiconductor" },
          { ticker: "ARGX", companyName: "argenx" },
          { ticker: "MSFT", companyName: "Microsoft" },
          { ticker: "LLY", companyName: "Eli Lilly" },
        ],
  ),
);

const today = nyToday();
const d = (n: number) => addDaysYmd(today, n);
/** A day earlier this week (Monday at the earliest), for the reports already out. */
const earlier = (n: number) => (d(-n) < weekStartOf(today) ? weekStartOf(today) : d(-n));
const at = (ymd: string, hh: number, mm: number) => new Date(nyWallMs(ymd, hh, mm)).toISOString();

function r(over: Partial<EarningsRow> & Pick<EarningsRow, "ticker" | "date">): EarningsRow {
  return {
    company: null,
    windowEnd: null,
    time: "unknown",
    status: "confirmed",
    phase: over.date < today ? "pending" : "upcoming",
    releasedAt: null,
    fiscalPeriod: null,
    epsEstimate: null,
    epsActual: null,
    epsCurrency: "USD",
    consensus: null,
    revenueEstimate: null,
    revenueActual: null,
    revenueCurrency: "USD",
    revenueEstimateUsd: null,
    revenueActualUsd: null,
    fx: null,
    source: "yahoo",
    lastSurprise: null,
    sector: null,
    held: false,
    watchlist: false,
    tracked: false,
    readsThrough: [],
    reason: over.held ? "held" : over.watchlist ? "watchlist" : null,
    marketCap: null,
    ...over,
  };
}

const link = (ticker: string, namedBy: string, named: string, category: string, tier: "critical" | "important", form: "10-K" | "20-F", filingDate: string) => ({
  ticker,
  held: true,
  watchlist: false,
  category,
  tier,
  namedBy,
  named,
  form,
  filingDate,
  sourceUrl: "https://www.sec.gov/",
});

const TWD = 0.03087;
const MINE: EarningsRow[] = [
  r({
    ticker: "TSM",
    date: today,
    company: "Taiwan Semiconductor Manufacturing Company Ltd.",
    time: "bmo",
    phase: "reported",
    releasedAt: at(today, 2, 8),
    fiscalPeriod: "Q3 2026",
    epsEstimate: 4.52,
    epsActual: 4.6,
    revenueEstimate: 1_486_000_000_000,
    revenueActual: 1_494_243_000_000,
    revenueCurrency: "TWD",
    revenueEstimateUsd: Math.round(1_486_000_000_000 * TWD),
    revenueActualUsd: Math.round(1_494_243_000_000 * TWD),
    fx: { currency: "TWD", rate: TWD, asOf: today },
    sector: "Technology",
    watchlist: true,
    tracked: true,
    lastSurprise: { quarterEnd: "2026-09-30", epsActual: 4.6, epsEstimate: 4.52, surprisePct: 1.67 },
    readsThrough: [link("NVDA", "NVDA", "TSM", "supplier", "important", "10-K", "2026-02-25"), link("AMD", "AMD", "TSM", "supplier", "important", "10-K", "2026-02-04")],
  }),
  r({
    ticker: "JPM",
    date: earlier(2),
    company: "JPMorgan Chase & Co.",
    time: "bmo",
    phase: "reported",
    releasedAt: at(earlier(2), 6, 30),
    fiscalPeriod: "Q3 2026",
    epsEstimate: 5.94,
    epsActual: 5.75,
    revenueEstimate: 51.14e9,
    revenueActual: 50.17e9,
    sector: "Financials",
    held: true,
    tracked: true,
    lastSurprise: { quarterEnd: "2026-09-30", epsActual: 5.75, epsEstimate: 5.94, surprisePct: -3.23 },
  }),
  r({ ticker: "AAPL", date: today, company: "Apple Inc.", time: "amc", fiscalPeriod: "Q4 2026", epsEstimate: 1.77, revenueEstimate: 101.5e9, consensus: { analysts: 28, low: 1.68, high: 1.84, thin: false }, sector: "Technology", held: true, tracked: true, lastSurprise: { quarterEnd: "2026-06-27", epsActual: 1.57, epsEstimate: 1.43, surprisePct: 9.79 } }),
  r({ ticker: "ARGX", date: d(7), company: "argenx SE American Depositary Shares", time: "bmo", fiscalPeriod: "Q3 2026", epsEstimate: -9.775, consensus: { analysts: 2, low: -27.83, high: 8.28, thin: true }, revenueEstimate: 1_634_209_500, sector: "Healthcare", watchlist: true, lastSurprise: { quarterEnd: "2026-06-30", epsActual: 7.32, epsEstimate: 6.19, surprisePct: 18.17 } }),
  r({ ticker: "AMD", date: d(12), company: "Advanced Micro Devices, Inc.", time: "amc", fiscalPeriod: "Q3 2026", epsEstimate: 1.32, revenueEstimate: 9.6e9, consensus: { analysts: 34, low: 1.2, high: 1.41, thin: false }, sector: "Technology", held: true, tracked: true, lastSurprise: { quarterEnd: "2026-06-27", epsActual: 1.18, epsEstimate: 1.1, surprisePct: 7.27 } }),
  r({ ticker: "MSFT", date: d(13), company: "Microsoft Corporation", time: "amc", fiscalPeriod: "Q1 2027", epsEstimate: 4.72, revenueEstimate: 90.7e9, sector: "Technology", watchlist: true, tracked: true, lastSurprise: { quarterEnd: "2026-06-30", epsActual: 4.74, epsEstimate: 4.24, surprisePct: 11.81 } }),
  r({ ticker: "XOM", date: d(15), company: "Exxon Mobil Corporation", time: "bmo", epsEstimate: 3.77, revenueEstimate: 103e9, sector: "Energy", held: true, tracked: true, lastSurprise: { quarterEnd: "2026-06-30", epsActual: 4.11, epsEstimate: 3.63, surprisePct: 13.26 } }),
  r({ ticker: "LLY", date: d(20), company: "Eli Lilly and Company", status: "estimated", windowEnd: d(24), sector: "Healthcare", watchlist: true, lastSurprise: { quarterEnd: "2026-06-30", epsActual: 6.1, epsEstimate: 6.32, surprisePct: -3.48 } }),
  r({ ticker: "NVDA", date: d(27), company: "NVIDIA Corporation", time: "amc", status: "estimated", epsEstimate: 2.47, revenueEstimate: 108.98e9, sector: "Technology", held: true, tracked: true, lastSurprise: { quarterEnd: "2026-07-26", epsActual: 2.22, epsEstimate: 2.09, surprisePct: 6.22 } }),
];
const TRACKED: EarningsRow[] = [
  ...MINE.filter((x) => x.tracked),
  r({ ticker: "IBM", date: d(6), company: "International Business Machines Corporation", time: "amc", epsEstimate: 2.87, revenueEstimate: 16.8e9, sector: "Technology", tracked: true, lastSurprise: { quarterEnd: "2026-06-30", epsActual: 2.93, epsEstimate: 2.93, surprisePct: -0.1 } }),
  r({ ticker: "CEG", date: d(22), company: "Constellation Energy Corporation", status: "estimated", sector: "Utilities", tracked: true }),
];
const FOR_YOU: EarningsRow[] = [
  ...MINE,
  r({ ticker: "QCOM", date: d(13), company: "QUALCOMM Incorporated", time: "amc", status: "unknown", source: "finnhub", epsEstimate: 2.87, revenueEstimate: 10.9e9, sector: "Technology", reason: "linked", marketCap: 182e9, readsThrough: [{ ...link("AAPL", "QCOM", "AAPL", "customer", "critical", "10-K", "2025-10-31") }] }),
  r({ ticker: "IBM", date: d(6), company: "International Business Machines Corporation", time: "amc", status: "unknown", source: "finnhub", epsEstimate: 2.87, revenueEstimate: 16.8e9, sector: "Technology", reason: "sector", marketCap: 236e9, lastSurprise: { quarterEnd: "2026-06-30", epsActual: 2.93, epsEstimate: 2.93, surprisePct: -0.1 } }),
  r({ ticker: "NFLX", date: d(5), company: "Netflix, Inc.", time: "amc", status: "unknown", source: "finnhub", epsEstimate: 6.98, revenueEstimate: 11.5e9, sector: "Communication Services", reason: "large", marketCap: 512e9 }),
  r({ ticker: "KO", date: d(12), company: "The Coca-Cola Company", time: "bmo", status: "unknown", source: "finnhub", epsEstimate: 0.91, revenueEstimate: 13.3e9, sector: "Consumer Staples", reason: "large", marketCap: 397e9 }),
  r({ ticker: "JNJ", date: d(5), company: "Johnson & Johnson", time: "bmo", status: "unknown", source: "finnhub", epsEstimate: 2.71, revenueEstimate: 23.8e9, sector: "Healthcare", reason: "large", marketCap: 402e9 }),
];
const ALL: EarningsRow[] = [
  ...TRACKED,
  r({ ticker: "TSLA", date: d(6), company: "Tesla, Inc.", time: "amc", status: "unknown", source: "finnhub", epsEstimate: 0.45, revenueEstimate: 28.4e9, sector: "Consumer Discretionary" }),
  r({ ticker: "KO", date: d(12), company: "The Coca-Cola Company", time: "bmo", status: "unknown", source: "finnhub", epsEstimate: 0.91, revenueEstimate: 13.3e9 }),
  ...Array.from({ length: 52 }, (_, i) =>
    r({ ticker: `Z${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, date: d(6), company: `Fixture Holdings ${i + 1}`, status: "unknown", source: "finnhub" }),
  ),
];

const move = (date: string, reactionDay: string, m: number, releasedAt: string | null = null) => ({ date, reactionDay, releasedAt, move: m });
const REACTIONS: Record<string, EarningsReaction> = {
  TSM: { usualMove: 0.041, normalDailyMove: 0.0172, asOf: d(-1), moves: [move("2025-10-16", "2025-10-16", 0.032), move("2026-01-15", "2026-01-15", -0.046), move("2026-04-16", "2026-04-16", 0.051), move("2026-07-16", "2026-07-16", -0.035)] },
  JPM: { usualMove: 0.024, normalDailyMove: 0.0108, asOf: d(-1), moves: [move("2026-01-13", "2026-01-13", -0.019), move("2026-04-14", "2026-04-14", 0.031), move("2026-07-14", "2026-07-14", 0.018), move(earlier(2), earlier(2), -0.034, at(earlier(2), 6, 30))] },
  AAPL: { usualMove: 0.033, normalDailyMove: 0.0121, asOf: d(-1), moves: [] },
  ARGX: { usualMove: 0.058, normalDailyMove: 0.0189, asOf: d(-1), moves: [] },
  AMD: { usualMove: 0.067, normalDailyMove: 0.0241, asOf: d(-1), moves: [] },
  MSFT: { usualMove: 0.039, normalDailyMove: 0.0113, asOf: d(-1), moves: [] },
  XOM: { usualMove: 0.016, normalDailyMove: 0.0119, asOf: d(-1), moves: [] },
  NVDA: { usualMove: 0.062, normalDailyMove: 0.0236, asOf: d(-1), moves: [] },
  IBM: { usualMove: 0.071, normalDailyMove: 0.0135, asOf: d(-1), moves: [] },
};
const LIVE: Record<string, number> = { TSM: -2.95, JPM: 0.42, NVDA: -1.18, AMD: -0.84 };
const QUARTERS: EarningsQuarter[] = [
  { periodEnd: "2025-12-31", fiscalQuarter: "4Q2025", reportedAt: at("2026-01-15", 1, 40), epsActual: 3.14, epsEstimate: 2.98, revenueActual: 1_046_090_000_000 },
  { periodEnd: "2026-03-31", fiscalQuarter: "1Q2026", reportedAt: null, epsActual: 3.49, epsEstimate: 3.33, revenueActual: 1_134_103_000_000 },
  { periodEnd: "2026-06-30", fiscalQuarter: "2Q2026", reportedAt: at("2026-07-16", 2, 10), epsActual: 4.31, epsEstimate: 3.89, revenueActual: 1_270_380_000_000 },
  { periodEnd: "2026-09-30", fiscalQuarter: "3Q2026", reportedAt: at(today, 2, 8), epsActual: 4.6, epsEstimate: 4.52, revenueActual: 1_494_243_000_000 },
];

const asks: EarningsRequest[] = [];
const probe = { asks, agent: null as string | null };
(window as unknown as { __earnings: unknown }).__earnings = probe;
const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function upcoming(req: EarningsRequest): Promise<EarningsResult> {
  asks.push(req);
  if (state === "loading") return new Promise(() => {});
  await wait(350);
  if (state === "error") return { ok: false, error: "unavailable" };
  if (req.scope === "all" && marketMissing) return { ok: false, error: "scope_unavailable" };
  const rows = state === "empty" ? [] : req.scope === "foryou" ? FOR_YOU : req.scope === "mine" ? MINE : req.scope === "tracked" ? TRACKED : ALL;
  return {
    ok: true,
    scope: req.scope,
    from: weekStartOf(today),
    to: d((req.days ?? 28) - 1),
    today,
    rows: [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker)),
    builtAt: new Date().toISOString(),
    scopes: { tracked: true, all: !marketMissing },
    unavailable: req.scope === "tracked" ? ["SNOW"] : [],
    marketCalendar: marketMissing ? "missing" : "fresh",
  };
}

async function reactions(tickers: string[]): Promise<EarningsReactionsResult> {
  await wait(250);
  return { ok: true, reactions: Object.fromEntries(tickers.map((t) => [t, REACTIONS[t] ?? null])) };
}

async function detail(ticker: string): Promise<EarningsDetailResult> {
  await wait(200);
  const row = ALL.find((x) => x.ticker === ticker);
  return {
    ok: true,
    detail: {
      ticker,
      quarters: ticker === "TSM" ? QUARTERS : [],
      revenueCurrency: row?.revenueCurrency ?? "USD",
      epsCurrency: "USD",
      reaction: REACTIONS[ticker] ?? null,
    },
  };
}

async function liveQuote(symbol: string) {
  const pct = LIVE[symbol];
  if (pct === undefined) return { ok: false as const, error: "none" };
  return { ok: true as const, quote: { symbol, companyName: symbol, price: 100, change: pct, changePercent: pct, session: "regular" as const, asOf: Date.now() } };
}

/** Implied moves as main read them on 2026-10-15 after the close (Yahoo option chains, Stock tab report history). */
const IMPLIED: Record<string, Omit<ImpliedMove, "ticker" | "reportDate" | "reactionDay">> = {
  NFLX: { spot: 72.61, expiry: d(8), nextExpiry: d(15), strike: 73, straddle: 6.44, raw: 0.088679, move: 0.07952, adjusted: true, sessions: 6, basis: "mid", quotedAt: new Date().toISOString(), history: { n: 12, above: 7, median: 0.094, from: "2023-10-18", to: "2026-07-16" } },
  IBM: { spot: 234.12, expiry: d(8), nextExpiry: d(15), strike: 235, straddle: 17.71, raw: 0.075665, move: 0.068512, adjusted: true, sessions: 6, basis: "mid", quotedAt: new Date().toISOString(), history: { n: 12, above: 5, median: 0.064, from: "2023-10-25", to: "2026-07-22" } },
  TSLA: { spot: 362.44, expiry: d(8), nextExpiry: d(11), strike: 362.5, straddle: 27.05, raw: 0.074641, move: 0.054342, adjusted: true, sessions: 6, basis: "mid", quotedAt: new Date().toISOString(), history: { n: 12, above: 7, median: 0.087, from: "2023-10-18", to: "2026-07-22" } },
  AMD: { spot: 214.3, expiry: d(15), nextExpiry: null, strike: 215, straddle: 16.1, raw: 0.0751, move: 0.0751, adjusted: false, sessions: 3, basis: "last", quotedAt: new Date().toISOString(), history: { n: 3, above: null, median: null, from: "2025-11-04", to: "2026-08-04" } },
};

async function impliedMoves(reports: ImpliedRequestItem[]): Promise<ImpliedMovesResult> {
  await wait(300);
  const moves: Record<string, ImpliedMove | null> = {};
  for (const r of reports) {
    const v = IMPLIED[r.ticker];
    moves[r.ticker] = v ? { ...v, ticker: r.ticker, reportDate: r.date, reactionDay: r.date } : null;
  }
  return { ok: true, moves };
}

(window as unknown as { meridian: unknown }).meridian =
  state === "restart"
    ? {}
    : { getEarningsUpcoming: upcoming, getEarningsReactions: reactions, getEarningsDetail: detail, getImpliedMoves: impliedMoves, getLiveQuote: liveQuote, openExternal: async () => undefined };

// The Agents tab is not in this harness; a create request is recorded instead.
onAgentsOpenRequest((focus) => {
  probe.agent = focus.kind === "create" ? (focus.brief ?? "") : null;
});

function Heading() {
  const t = useT();
  return <span className="font-baskerville text-[30px] text-[#1d1b1b]">{t("home.tab.earnings")}</span>;
}

// `#open=TSM` opens that row's drawer once the list is drawn, for screenshots.
const openParam = /open=([A-Z.]+)/.exec(location.hash)?.[1];
if (openParam) {
  const tryOpen = (n: number) => {
    const li = document.querySelector<HTMLElement>(`li[aria-label$=" ${openParam}"]`);
    if (li) li.click();
    else if (n > 0) setTimeout(() => tryOpen(n - 1), 150);
  };
  setTimeout(() => tryOpen(40), 600);
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
    <EarningsTab />
    <div className="px-8 pb-12">
      <div style={{ width: 300, height: 560 }}>
        <EarningsCard onOpenEarnings={() => document.querySelector("#root > div")?.scrollTo({ top: 0, behavior: "smooth" })} />
      </div>
    </div>
  </div>,
);
