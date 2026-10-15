import { createRoot } from "react-dom/client";
import "../globals.css";
import CalendarTab from "../components/calendar/CalendarTab";
import { useGuidanceTrack } from "../components/stock-tab/use-guidance";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";
import { mulberry32 } from "../lib/demo-mode";
import { seedPaperAccount, type PaperPosition } from "../lib/paper-account";
import { buildDemoBriefing } from "../../shared/briefing-demo";
import { resolveBriefingWindow, type BriefingHolding } from "../../shared/briefing-types";
import type { EstimateRevisions } from "../../shared/estimate-revisions";
import type { GuidanceTrack } from "../../shared/guidance-types";
import type { ImpliedMove, ImpliedRequestItem } from "../../shared/implied-move";
import type { ReadthroughRequest, ReadthroughResult, ReadthroughRow } from "../../shared/readthrough-types";
import guidanceFixture from "./guidance-fixture.json";
import {
  validateUserEventInput,
  type CalendarCorporateEvent,
  type CalendarSector,
  type UserCalendarEvent,
} from "../../shared/calendar-events";

/**
 * Scratch harness for the Calendar tab against a stubbed main process, laid
 * out the way the home page draws it (under the greeting row). Market rows
 * come from the real curated calendar and rules; the handover report is the
 * demo builder's; the corporate dates and sectors below are fixtures for the
 * harness only, so no provider, key or model is involved. The reader's own
 * events live in memory for the page's life.
 *
 *   ?theme=dark        draw in that theme
 *   ?lang=tr-TR        show the chrome in that language
 *   ?view=month        open on that view (day | week | month), kept like a real pick
 *   ?state=old-main    a bridge without the calendar handlers: the restart notes
 *   ?corp=error        the corporate read fails
 *   ?empty=1           no holdings, no watchlist, no own events
 *   ?facts=none        the earnings card's figures all come back empty
 *                      (options, estimates, read-through; no guidance read)
 *
 * The earnings card's figures are fixtures too: TSM (watchlist) reports in
 * four days with options, estimates and two held names' read-through; NVDA
 * in 33 days (past the report's reach, outside the options window) with its
 * guidance track already read this run (as if the Stock tab had opened it),
 * so its estimates and pattern lines show. XOM's report row has no figures.
 *
 * Probes: `window.__calendarTab.writes` lists the user-event writes.
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
const state = params.get("state");
const empty = params.get("empty") === "1";

const viewParam = params.get("view");
if (viewParam === "day" || viewParam === "week" || viewParam === "month") {
  try {
    const raw = JSON.parse(localStorage.getItem("falcon.ui.calendar.v1") ?? "{}");
    localStorage.setItem("falcon.ui.calendar.v1", JSON.stringify({ ...raw, view: viewParam }));
  } catch {
    /* harness only */
  }
}

const HOLDINGS: BriefingHolding[] = empty
  ? []
  : [
      { symbol: "NVDA", shares: 120, cost_usd: 21_000 },
      { symbol: "AAPL", shares: 80, cost_usd: 16_500 },
      { symbol: "JPM", shares: 50, cost_usd: 12_400 },
      { symbol: "XOM", shares: 40, cost_usd: 4_400 },
      { symbol: "SPY", shares: 45, cost_usd: 26_500 },
    ];
const CASH = 18_400;
const positions: Record<string, PaperPosition> = {};
for (const h of HOLDINGS) positions[h.symbol] = { symbol: h.symbol, shares: h.shares, costUsd: h.cost_usd };
seedPaperAccount({ cash: CASH, positions });
localStorage.setItem(
  "meridian-watchlist",
  JSON.stringify(
    empty
      ? []
      : [
          { ticker: "LLY", companyName: "Eli Lilly" },
          { ticker: "MSFT", companyName: "Microsoft" },
          { ticker: "JPM", companyName: "JPMorgan Chase" },
          { ticker: "TSM", companyName: "Taiwan Semiconductor" },
        ],
  ),
);

const now = new Date();
const window_ = resolveBriefingWindow(now);
const report = { ...buildDemoBriefing(mulberry32(7), window_, HOLDINGS, CASH), demo: false, generated_at: now.toISOString(), window: window_ };

/** A date this many days from today, YYYY-MM-DD. */
function day(offset: number): string {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SECTORS: Record<string, CalendarSector | null> = { TSM: "Technology", NVDA: "Technology", AAPL: "Technology", MSFT: "Technology", JPM: "Financials", XOM: "Energy", LLY: "Healthcare", SPY: "Funds & ETFs" };
const CORPORATE: CalendarCorporateEvent[] = [
  { id: `earn:JPM:${day(3)}`, kind: "earnings", ticker: "JPM", date: day(3), title: "JPM earnings report", detail: "Date from the data provider. The hour is not given.", estimated: false, words: { title: { code: "earnings", params: { ticker: "JPM" } }, detail: [{ code: "earningsDated" }] } },
  { id: `earn:TSM:${day(4)}`, kind: "earnings", ticker: "TSM", date: day(4), title: "TSM earnings report", detail: "Date from the data provider. The hour is not given.", estimated: false, words: { title: { code: "earnings", params: { ticker: "TSM" } }, detail: [{ code: "earningsDated" }] } },
  { id: `earn:NVDA:${day(33)}`, kind: "earnings", ticker: "NVDA", date: day(33), title: "NVDA earnings report", detail: null, estimated: true },
  { id: `earn:MSFT:${day(16)}`, kind: "earnings", ticker: "MSFT", date: day(16), title: "MSFT earnings report", detail: "Date estimated by the data provider; the company has not confirmed it.", estimated: true, words: { title: { code: "earnings", params: { ticker: "MSFT" } }, detail: [{ code: "earningsEstimated" }] } },
  { id: `earn:LLY:${day(20)}`, kind: "earnings", ticker: "LLY", date: day(20), title: "LLY earnings report", detail: null, estimated: true },
  { id: `earn:XOM:${day(21)}`, kind: "earnings", ticker: "XOM", date: day(21), title: "XOM earnings report", detail: null, estimated: true },
  { id: `div:XOM:${day(2)}`, kind: "ex_dividend", ticker: "XOM", date: day(2), title: "XOM ex-dividend date", detail: "Indicated annual rate $3.96 per share. Shares held before this date carry the payment.", estimated: false, words: { title: { code: "exDividend", params: { ticker: "XOM" } }, detail: [{ code: "indicatedRate", params: { amount: 3.96 } }, { code: "heldBefore" }] } },
  { id: `pay:XOM:${day(12)}`, kind: "dividend_payment", ticker: "XOM", date: day(12), title: "XOM dividend payment", detail: "The payment date the provider lists for the current dividend.", estimated: false, words: { title: { code: "dividendPayment", params: { ticker: "XOM" } }, detail: [{ code: "payment" }] } },
  { id: `div:AAPL:${day(-5)}`, kind: "ex_dividend", ticker: "AAPL", date: day(-5), title: "AAPL ex-dividend date", detail: "$0.26 per share went ex-dividend, read from the price history.", estimated: false, words: { title: { code: "exDividend", params: { ticker: "AAPL" } }, detail: [{ code: "wentEx", params: { amount: 0.26 } }] } },
];

let seq = 0;
const iso = (offsetDays: number, hour: number, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};
const stamp = new Date().toISOString();
let userEvents: UserCalendarEvent[] = empty
  ? []
  : [
      { id: "ue_seed00001", title: "Portfolio review", all_day: false, date: null, end_date: null, start_at: iso(0, 10), end_at: iso(0, 11), ticker: null, sector: null, color: "violet", notes: "Rebalance notes in the doc.", created_at: stamp, updated_at: stamp },
      { id: "ue_seed00002", title: "NVDA call prep", all_day: false, date: null, end_date: null, start_at: iso(1, 15, 30), end_at: iso(1, 16, 15), ticker: "NVDA", sector: "Technology", color: "blue", notes: "", created_at: stamp, updated_at: stamp },
      { id: "ue_seed00003", title: "Conference", all_day: true, date: day(1), end_date: day(3), start_at: null, end_at: null, ticker: null, sector: null, color: "pink", notes: "", created_at: stamp, updated_at: stamp },
    ];
const writes: unknown[] = [];
(window as unknown as { __calendarTab: unknown }).__calendarTab = { writes };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const calendarBridge =
  state === "old-main"
    ? {}
    : {
        listCalendarUserEvents: async () => {
          await wait(120);
          return { ok: true as const, events: userEvents };
        },
        createCalendarUserEvent: async (input: unknown) => {
          writes.push({ create: input });
          const v = validateUserEventInput(input);
          if (!v.ok) return v;
          const event: UserCalendarEvent = { id: `ue_new${String(++seq).padStart(5, "0")}`, ...v.value, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          userEvents = [...userEvents, event];
          return { ok: true as const, event };
        },
        updateCalendarUserEvent: async (id: string, input: unknown) => {
          writes.push({ update: id, input });
          const v = validateUserEventInput(input);
          if (!v.ok) return v;
          const old = userEvents.find((e) => e.id === id);
          if (!old) return { ok: false as const, error: "That event no longer exists." };
          const event = { ...old, ...v.value, updated_at: new Date().toISOString() };
          userEvents = userEvents.map((e) => (e.id === id ? event : e));
          return { ok: true as const, event };
        },
        deleteCalendarUserEvent: async (id: string) => {
          writes.push({ delete: id });
          userEvents = userEvents.filter((e) => e.id !== id);
          return { ok: true as const };
        },
        getCalendarCorporate: async ({ symbols }: { symbols: string[] }) => {
          await wait(400);
          if (params.get("corp") === "error") return { ok: false as const, error: "unavailable" as const };
          const set = new Set(symbols);
          return {
            ok: true as const,
            events: CORPORATE.filter((e) => set.has(e.ticker)),
            sectors: Object.fromEntries(symbols.map((s) => [s, SECTORS[s] ?? null])),
            unavailable: [],
            skipped: [],
          };
        },
      };

// --- The earnings card's figures ---------------------------------------------
const noFacts = params.get("facts") === "none";

const IMPLIED: Record<string, Omit<ImpliedMove, "ticker" | "reportDate" | "reactionDay">> = {
  TSM: { spot: 302.4, expiry: day(8), nextExpiry: day(15), strike: 300, straddle: 19.1, raw: 0.0632, move: 0.0548, adjusted: true, sessions: 6, basis: "mid", quotedAt: new Date().toISOString(), history: { n: 12, above: 4, median: 0.041, from: "2023-10-19", to: "2026-07-17" } },
  NVDA: { spot: 181.2, expiry: day(10), nextExpiry: day(17), strike: 180, straddle: 13.9, raw: 0.0767, move: 0.0712, adjusted: true, sessions: 8, basis: "mid", quotedAt: new Date().toISOString(), history: { n: 12, above: 6, median: 0.069, from: "2023-08-23", to: "2026-08-26" } },
};
const ESTIMATE_MOVES: Record<string, [number, number, number]> = { TSM: [0.052, 14, 1], NVDA: [0.018, 22, 6], JPM: [-0.004, 3, 4] };

function estimatesFor(ticker: string): EstimateRevisions | null {
  const move = ESTIMATE_MOVES[ticker];
  if (!move) return null;
  const [pct, up, down] = move;
  const now = 1.84;
  const then = now / (1 + pct);
  const change = { kind: "pct" as const, value: pct, from: then, to: now };
  return {
    ticker,
    readAt: new Date().toISOString(),
    periods: [
      { period: "0q", periodEnd: day(-16), currency: "USD", analysts: 24, now, ago30: then, change7: change, change30: change, change90: change, up7: 2, down7: 0, up30: up, down30: down, revenue: null },
    ],
  };
}

function radarRow(counterparty: string, holding: string, withIt: number, events: number): ReadthroughRow {
  return {
    id: `${counterparty}>${holding}`,
    counterparty,
    counterpartyName: null,
    holding,
    held: true,
    watchlist: false,
    relation: "supplier",
    tier: "critical",
    namedBy: holding,
    form: "10-K",
    filingDate: "2026-02-25",
    sourceUrl: null,
    kind: "upcoming",
    date: day(4),
    time: "unknown",
    status: "confirmed",
    report: null,
    sample: events,
    stats: { events, withIt, avgAbsMove: 0.024, avgAbsAbnormal: 0.017, avgFollow: 0.006, avgNextFollow: 0.001, nextEvents: events, normalAbsAbnormal: 0.011, sensitivity: 1.5, surpriseEvents: 0, withSurprise: 0, beta: 1.3, betaFallback: false, from: day(-730), to: day(-90) },
    events: [],
    weight: 1,
    score: 1.5,
  };
}

const factsBridge = {
  getImpliedMoves: async (reports: ImpliedRequestItem[]) => {
    await wait(350);
    const moves: Record<string, ImpliedMove | null> = {};
    for (const r of reports) {
      const v = noFacts ? undefined : IMPLIED[r.ticker];
      moves[r.ticker] = v ? { ...v, ticker: r.ticker, reportDate: r.date, reactionDay: r.date } : null;
    }
    return { ok: true as const, moves };
  },
  getEstimateRevisions: async (tickers: string[]) => {
    await wait(250);
    return { ok: true as const, estimates: Object.fromEntries(tickers.map((t) => [t, noFacts ? null : estimatesFor(t)])) };
  },
  getReadthroughRadar: async (_request: ReadthroughRequest): Promise<ReadthroughResult> => {
    await wait(300);
    const rows = noFacts ? [] : [radarRow("TSM", "NVDA", 6, 8), radarRow("TSM", "AAPL", 5, 8)];
    return { ok: true, today: day(0), builtAt: new Date().toISOString(), rows, links: rows.length, truncated: false, degraded: [] };
  },
  getStockTabGuidance: async (ticker: string) => {
    await wait(200);
    const track = noFacts ? undefined : (guidanceFixture as unknown as Record<string, GuidanceTrack>)[ticker.toUpperCase()];
    return { ok: true as const, track: track ?? { ticker, releases: 8, latest: null, rows: [], patterns: [] } };
  },
};

/** NVDA's guidance track, read once the way the Stock tab would have: the calendar itself never asks. */
function GuidanceAlreadyRead() {
  useGuidanceTrack(empty ? null : "NVDA");
  return null;
}

(window as unknown as { meridian: unknown }).meridian = {
  ...calendarBridge,
  ...factsBridge,
  getBriefingWindow: async () => ({ ok: true, window: report.window, calendar_coverage: report.calendar_coverage }),
  getBriefing: async () => {
    await wait(300);
    return { ok: true, report, source: "cache" };
  },
  getBriefingNarrative: async () => ({ ok: false, error: "not_found" }),
  searchStockSymbols: async (q: string) =>
    [
      { symbol: "NVDA", companyName: "NVIDIA Corporation" },
      { symbol: "AAPL", companyName: "Apple Inc." },
      { symbol: "AMD", companyName: "Advanced Micro Devices" },
      { symbol: "JPM", companyName: "JPMorgan Chase & Co." },
      { symbol: "XOM", companyName: "Exxon Mobil Corporation" },
    ].filter((s) => s.symbol.startsWith(q.toUpperCase()) || s.companyName.toUpperCase().includes(q.toUpperCase())),
};

createRoot(document.getElementById("root")!).render(
  <div
    className="h-screen overflow-y-auto pt-16"
    // The page behind the home page in each theme: cream, or the app's near-black.
    style={{ minWidth: 1060, background: document.documentElement.dataset.theme === "dark" ? "hsl(0 0% 3.5%)" : "#EAEAE6" }}
  >
    <div className="select-none pl-9">
      <span className="font-baskerville text-[30px] text-[#1d1b1b]">Afternoon, Kuzey</span>
    </div>
    <GuidanceAlreadyRead />
    <CalendarTab />
  </div>,
);
