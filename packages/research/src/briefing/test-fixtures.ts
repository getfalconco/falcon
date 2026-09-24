/**
 * Handover briefing: deterministic stand-ins for the outside world.
 *
 * Shared by the assembly tests and by the replay script's offline mode, so
 * "what a coherent set of ports looks like" is written once. Everything is
 * derived from the clock the caller passes in: the same `now` always yields
 * the same report, and a different `now` yields prints that are dated
 * sensibly against its own session window.
 *
 * Test support, not engine surface: it is not re-exported from the barrel.
 */

import type { BaseReplayResult, ReplayedIncident } from "../base/replay.js";
import type { PriorityBand, CompositeTag } from "../base/types.js";
import { addTradingDays } from "../tracker/calendar.js";
import type { QuantContext, TrackerMessage, TrackerMessageType, TrackerPayload } from "../tracker/types.js";
import { resolveBriefingWindow } from "./window.js";
import type {
  BriefingHolding,
  BriefingPorts,
  ChainTickerSlice,
  CorporateCalendarRaw,
  HeldNewsItem,
  HeldQuote,
  MarketHeadline,
  MarketSnapshot,
  QuantSlice,
  RiskLatestLite,
} from "./types.js";

/** Monday 2026-09-21, 08:00 ET: inside the pre-open window, after a plain weekend. */
export const NOW = "2026-09-21T12:00:00.000Z";

export const FIXTURE_HELD: readonly string[] = ["NVDA", "AAPL", "SPY", "IWM"];

export function fixtureHoldings(): BriefingHolding[] {
  return [
    { symbol: "NVDA", shares: 40, cost_usd: 4200 },
    { symbol: "AAPL", shares: 15, cost_usd: 3100 },
    { symbol: "SPY", shares: 10, cost_usd: 5400 },
    { symbol: "IWM", shares: 12, cost_usd: 2600 },
  ];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const MARKET_LEVELS: Record<string, { price: number; previous_close: number }> = {
  "^N225": { price: 38250.1, previous_close: 38010.55 },
  "^HSI": { price: 18120.4, previous_close: 18255.9 },
  "000001.SS": { price: 3050.2, previous_close: 3046.1 },
  "^AXJO": { price: 8105.3, previous_close: 8080.0 },
  "^STOXX50E": { price: 4985.6, previous_close: 4970.1 },
  "^GDAXI": { price: 18890.2, previous_close: 18850.7 },
  "^FTSE": { price: 8290.5, previous_close: 8301.2 },
  "^FCHI": { price: 7610.3, previous_close: 7588.4 },
  "ES=F": { price: 5742.25, previous_close: 5718.5 },
  "NQ=F": { price: 19980.5, previous_close: 19860.25 },
  "YM=F": { price: 42310, previous_close: 42205 },
  "RTY=F": { price: 2235.4, previous_close: 2241.8 },
  "^VIX": { price: 16.85, previous_close: 17.4 },
  "DX-Y.NYB": { price: 101.2, previous_close: 101.05 },
  "CL=F": { price: 71.35, previous_close: 70.9 },
  "GC=F": { price: 2612.4, previous_close: 2598.7 },
  "^TNX": { price: 4.31, previous_close: 4.25 },
};

const ASIA = new Set(["^N225", "^HSI", "000001.SS", "^AXJO"]);

const HELD_LEVELS: Record<string, { price: number; regular_price: number; previous_close: number }> = {
  NVDA: { price: 118.4, regular_price: 116.0, previous_close: 117.2 },
  AAPL: { price: 227.1, regular_price: 228.2, previous_close: 226.5 },
  SPY: { price: 573.9, regular_price: 571.5, previous_close: 569.8 },
  IWM: { price: 221.3, regular_price: 222.0, previous_close: 223.1 },
};

const QUANTS: Record<string, QuantSlice> = {
  NVDA: { daily_vol_30d: 2.9, beta: 1.7 },
  AAPL: { daily_vol_30d: 1.4, beta: 1.1 },
  SPY: { daily_vol_30d: 0.8, beta: 1 },
  IWM: { daily_vol_30d: 1.2, beta: 1.15 },
};

/** A small stable hash, so a symbol outside the tables still gets the same numbers every run. */
function seed(symbol: string): number {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function fixtureSnapshot(symbol: string, now: Date, over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const window = resolveBriefingWindow(now);
  const since = Date.parse(window.overnight_since);
  const t = now.getTime();
  const level = MARKET_LEVELS[symbol] ?? { price: 100 + (seed(symbol) % 900), previous_close: 100 + (seed(symbol) % 900) };

  // Tokyo shut for a local holiday: the provider hands back the last session's
  // print, which predates the US close. The ten-year behaves the same way
  // before the US opens, its last print being the prior afternoon's.
  let marketTime = t - MINUTE;
  let live = true;
  if (symbol === "^N225") {
    marketTime = since - 14 * HOUR;
    live = false;
  } else if (symbol === "^TNX") {
    marketTime = since - HOUR;
    live = false;
  } else if (ASIA.has(symbol)) {
    marketTime = t - 6 * HOUR;
    live = false;
  }

  return {
    symbol,
    price: level.price,
    previous_close: level.previous_close,
    market_time: iso(marketTime),
    in_regular_session: live,
    ...over,
  };
}

export function fixtureQuote(symbol: string, now: Date, over: Partial<HeldQuote> = {}): HeldQuote {
  const s = seed(symbol);
  const base = 20 + (s % 400);
  const level = HELD_LEVELS[symbol] ?? {
    price: Math.round(base * (1 + (((s >>> 8) % 400) - 200) / 10_000) * 100) / 100,
    regular_price: base,
    previous_close: Math.round(base * 0.995 * 100) / 100,
  };
  return { symbol, ...level, session: "pre", as_of: iso(now.getTime() - 2 * MINUTE), ...over };
}

export function fixtureNews(ticker: string, now: Date, over: Partial<HeldNewsItem> = {}): HeldNewsItem {
  return {
    ticker,
    also: [],
    headline: `${ticker} supplier update draws attention before the open`,
    source: "Newswire",
    url: `https://example.com/news/${ticker.toLowerCase()}-supplier-update`,
    published_at: iso(now.getTime() - 3 * HOUR),
    band: "P2",
    tags: [],
    incident_id: `fixture-incident-${ticker}`,
    ...over,
  };
}

/** One article that reached two held names, as the chain reports it: once per ticker. */
export const SHARED_ARTICLE_URL = "https://example.com/markets/chip-export-rules";

function sharedArticle(ticker: string, now: Date): HeldNewsItem {
  return fixtureNews(ticker, now, {
    headline: "Chip export rules widen to cover more handset and data-centre parts",
    url: SHARED_ARTICLE_URL,
    published_at: iso(now.getTime() - 5 * HOUR),
    band: "P1",
    tags: ["event_gap"],
    incident_id: `fixture-incident-export-${ticker}`,
  });
}

export function fixtureSlice(ticker: string, now: Date, over: Partial<ChainTickerSlice> = {}): ChainTickerSlice {
  const target = resolveBriefingWindow(now).target_session_ymd;
  const empty: ChainTickerSlice = { ticker, coverage: "pending", news: [], filings: [], measurements: [], scheduled_earnings: [] };
  let slice = empty;
  if (ticker === "NVDA") {
    slice = {
      ...empty,
      coverage: "tracked",
      news: [sharedArticle("NVDA", now), fixtureNews("NVDA", now)],
      filings: [
        {
          ticker: "NVDA",
          kind: "filing",
          label: "8-K, items 7.01, 9.01 (Regulation FD disclosure)",
          filed_at: iso(now.getTime() - 4 * HOUR),
          url: "https://www.sec.gov/Archives/edgar/data/1045810/fixture-8k.htm",
        },
      ],
      measurements: [
        {
          ticker: "NVDA",
          type: "news_burst",
          detail: "14 articles in 24 hours, 3.5 times the usual daily rate.",
          at: iso(now.getTime() - 2 * HOUR),
        },
      ],
      // After the close, three sessions out: the hour marker is the Tracker's own.
      scheduled_earnings: [{ due_at: `${addTradingDays(target, 3)}T20:00:00.000Z`, confirmed: true, fiscal_period: "Q3 2026" }],
    };
  } else if (ticker === "AAPL") {
    slice = { ...empty, coverage: "tracked", news: [sharedArticle("AAPL", now)] };
  } else if (ticker === "SPY" || ticker === "IWM") {
    slice = { ...empty, coverage: "price_only" };
  }
  return { ...slice, ...over };
}

export function fixtureCorporate(symbol: string, now: Date, over: Partial<CorporateCalendarRaw> = {}): CorporateCalendarRaw {
  const target = resolveBriefingWindow(now).target_session_ymd;
  const none: CorporateCalendarRaw = {
    symbol,
    available: false,
    ex_dividend_date: null,
    dividend_date: null,
    dividend_rate: null,
    earnings_dates: [],
    earnings_estimated: null,
    recent_dividends: [],
    recent_splits: [],
  };
  let raw = none;
  if (symbol === "AAPL") {
    raw = {
      ...none,
      available: true,
      ex_dividend_date: addTradingDays(target, 4),
      dividend_date: addTradingDays(target, 7),
      dividend_rate: 1.04,
      earnings_dates: [addTradingDays(target, 8)],
      earnings_estimated: true,
    };
  } else if (symbol === "NVDA") {
    raw = { ...none, available: true, earnings_dates: [addTradingDays(target, 3)], earnings_estimated: false };
  } else if (!(symbol === "SPY" || symbol === "IWM")) {
    raw = { ...none, available: true };
  }
  return { ...raw, ...over };
}

/**
 * Invented market-wide headlines, dated inside the night and attributed to a
 * generic wire, so the tape story has something to count. Third-party text by
 * construction: no template sentence may repeat one, and a test checks that.
 */
export function fixtureMarketHeadlines(now: Date): MarketHeadline[] {
  const t = now.getTime();
  return [
    {
      id: "fixture-market-futures",
      title: "Equity futures edge higher before the bell as oil extends its climb",
      source: "Newswire",
      url: "https://example.com/markets/futures-before-the-bell",
      published_at: iso(t - 90 * MINUTE),
      related: ["SPY", "QQQ"],
      via: "SPY",
    },
    {
      id: "fixture-market-yields",
      title: "Treasury yields hold near last week's highs into a busy data calendar",
      source: "Newswire",
      url: "https://example.com/markets/yields-hold",
      published_at: iso(t - 4 * HOUR),
      related: ["TLT"],
      via: "TLT",
    },
    {
      id: "fixture-market-gold",
      title: "Gold steadies after a record run as the dollar firms",
      source: "Newswire",
      url: "https://example.com/markets/gold-steadies",
      published_at: iso(t - 7 * HOUR),
      related: ["GC=F", "DX-Y.NYB"],
      via: "GC=F",
    },
  ];
}

export function fixtureRisk(now: Date, over: Partial<RiskLatestLite> = {}): RiskLatestLite {
  return {
    score: 58,
    band: "elevated",
    driver_component: "concentration",
    driver_sentence: "The two largest positions make up most of the invested book.",
    beta_eff: 1.21,
    beta_port: 1.18,
    port_vol_daily_pct: 1.35,
    computed_at: iso(now.getTime() - 20 * MINUTE),
    tickers: [...FIXTURE_HELD],
    ...over,
  };
}

export type FakePortsOptions = {
  /** The clock the fake world is dated against. Defaults to `NOW`. */
  now?: Date;
  /** The tickers the risk snapshot claims to describe. Defaults to the fixture book. */
  riskTickers?: string[];
};

/** Coherent ports for the fixture book; any port can be swapped through `overrides`. */
export function fakePorts(overrides: Partial<BriefingPorts> = {}, options: FakePortsOptions = {}): BriefingPorts {
  const now = options.now ?? new Date(NOW);
  return {
    marketSnapshot: async (symbol) => fixtureSnapshot(symbol, now),
    heldQuote: async (symbol) => fixtureQuote(symbol, now),
    quant: async (symbol) => QUANTS[symbol] ?? null,
    chainSlice: async (ticker) => fixtureSlice(ticker, now),
    riskLatest: async () => fixtureRisk(now, options.riskTickers ? { tickers: [...options.riskTickers] } : {}),
    corporateCalendar: async (symbol) => fixtureCorporate(symbol, now),
    // Filtered by `since` as the real port is, so a clock late in the window
    // still hands back headlines the night carried and none from before it.
    marketNews: async (since) => fixtureMarketHeadlines(now).filter((h) => Date.parse(h.published_at) >= Date.parse(since)),
    calendarOverlay: async () => null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Replay builders (chain-slice tests)
// ---------------------------------------------------------------------------

const QUANT_CONTEXT: QuantContext = {
  beta_90d: null,
  r_squared: null,
  daily_vol_30d: null,
  vol_regime: null,
  move_today: null,
  move_zscore: null,
  residual_move: null,
  residual_zscore: null,
  volume_ratio: null,
  volume_ratio_partial: false,
  momentum_5d: null,
  momentum_20d: null,
  momentum_60d: null,
  pct_from_52w_high: null,
  pct_from_52w_low: null,
  earnings_rhythm: null,
  prev_close: null,
  last_price: null,
  price_asof: null,
  session: "closed",
};

let messageSerial = 0;

export function fixtureMessage(
  type: TrackerMessageType,
  ticker: string,
  timestamp: string,
  payload: Record<string, unknown>,
): TrackerMessage {
  messageSerial += 1;
  return {
    id: `fixture-message-${messageSerial}`,
    schema_version: 1,
    type,
    ticker,
    timestamp,
    source_engine: "tracker",
    context_flags: [],
    quant_context: QUANT_CONTEXT,
    payload: payload as unknown as TrackerPayload,
  };
}

export function fixtureIncident(
  ticker: string,
  band: PriorityBand,
  messages: TrackerMessage[],
  tags: CompositeTag[] = [],
): ReplayedIncident {
  const first = messages[0]?.timestamp ?? NOW;
  return {
    incident: {
      incident_id: `fixture-incident-${ticker}-${band}-${messages.length}-${first}`,
      ticker,
      trigger_type: "organic",
      window_start: first,
      window_end: null,
      window_status: "open",
      composite_tags: tags,
      priority: 50,
      priority_band: band,
      degraded_context: false,
      discovery_floor_applied: false,
      earnings_absorption: false,
      messages,
      quant_context: null,
      user_proximity: "held",
      related_incident_id: null,
      propagation_candidates: [],
    },
    routing: { destinations: [], store_only: true } as unknown as ReplayedIncident["routing"],
  };
}

/** Only `incidents` is read by the slice; the summary is left out rather than invented. */
export function fixtureReplay(incidents: ReplayedIncident[]): BaseReplayResult {
  return { incidents, article_groups: [], summary: {} as BaseReplayResult["summary"] };
}
