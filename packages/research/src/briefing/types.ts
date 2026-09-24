/**
 * Handover briefing — contracts (spec v1.0).
 *
 * The report a reader meets when they open the app before the US open: what
 * the Asia and Europe sessions did, what the book carried through the night
 * and what it is exposed to, which corporate events touch the names they
 * hold, and what today's calendar holds. Every figure is deterministic; the
 * only model-written part is a short narrative over those same figures, and
 * a template stands in for it whenever the model cannot be reached.
 *
 * Types only, no imports: this file is published as the renderer-safe half of
 * the engine (`@meridian/research/briefing/contracts`), so nothing here may
 * pull in fs, the network or another engine's Node-only surface.
 */

/**
 * 2: reports carry `implications`, and held movers carry beta and daily
 * volatility. 3: reports carry market-wide `headlines` and the `stories` the
 * panel leads with. A cached older report has none of these, so the bump is
 * what keeps one from being served into a panel built around them.
 */
export const BRIEFING_SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** One position as the renderer holds it (the paper account lives there). */
export type BriefingHolding = {
  symbol: string;
  /** Signed: positive for a bought position, negative for a borrowed one. */
  shares: number;
  /** Signed cash basis, paper-account convention. */
  cost_usd: number;
};

export type BriefingRequest = {
  holdings: BriefingHolding[];
  cash: number;
  /** A demo book is never sent to a model and never persisted. */
  demo?: boolean;
  /** Skip the report cache (the manual refresh). */
  force?: boolean;
};

// ---------------------------------------------------------------------------
// Session window
// ---------------------------------------------------------------------------

export type BriefingPhase = "pre_open" | "in_session" | "between_sessions";

/** Why the gap since the last US close is as long as it is. */
export type BriefingHandover = "overnight" | "weekend" | "holiday";

export type BriefingWindow = {
  /** The US session this report hands over to (NY calendar date). */
  target_session_ymd: string;
  /** The last completed US session before it. */
  prev_session_ymd: string;
  /** That session's close (13:00 ET on an early close), UTC ISO. "Overnight" starts here. */
  overnight_since: string;
  /** 20:00 ET on the calendar day before the target: Asia has opened. UTC ISO. */
  window_opens_at: string;
  target_open_at: string;
  target_close_at: string;
  phase: BriefingPhase;
  /** True only inside [window_opens_at, target_open_at). */
  auto_show: boolean;
  handover: BriefingHandover;
  /** The target session closes at 13:00 ET. */
  early_close: boolean;
};

// ---------------------------------------------------------------------------
// Overnight
// ---------------------------------------------------------------------------

export type MarketGroup = "asia" | "europe" | "us_futures" | "macro";

/** How a row's move is expressed: percent, basis points (yields) or points (VIX). */
export type MarketUnit = "pct" | "bp" | "pts";

/**
 * live: its own session is trading now. final: that session has closed since
 * the last US close. stale: the move is withheld, either because the last
 * print predates the last US close (local holiday, not open yet) or because
 * the baseline it would be measured from belongs to a session before that
 * close. unavailable: the fetch failed.
 */
export type MarketState = "live" | "final" | "stale" | "unavailable";

export type MarketRow = {
  symbol: string;
  label: string;
  group: MarketGroup;
  last: number | null;
  prev_close: number | null;
  /** In `unit`. Null whenever `state` is stale or unavailable. */
  move: number | null;
  unit: MarketUnit;
  /** Futures settle; everything else closes. */
  basis: "prev_close" | "prior_settle";
  state: MarketState;
  /** When `last` printed, UTC ISO. */
  as_of: string | null;
};

export type HeldSession = "pre" | "regular" | "post" | "closed";

export type HeldMover = {
  ticker: string;
  last: number;
  /** The close the move is measured from. */
  ref_close: number;
  move_pct: number;
  /** The move in units of the name's own daily volatility; null when untracked. */
  move_z: number | null;
  pnl_usd: number;
  basis: "since_close" | "today";
  session: HeldSession;
  as_of: string;
  /** A split landed in the window, or the move is too large to be a plain print. */
  flag: "corporate_action_check" | null;
  /** The name's beta to the index, when the chain tracks it: how much of the move the market explains. */
  beta: number | null;
  /** Its 30-day daily volatility, in percent: the yardstick for "a normal day" in a scenario. */
  daily_vol_pct: number | null;
};

export type BriefingPriorityBand = "P0" | "P1" | "P2" | "P3";

export type HeldNewsItem = {
  ticker: string;
  /** Other held names the same article reached. */
  also: string[];
  headline: string;
  source: string;
  url: string;
  published_at: string;
  band: BriefingPriorityBand;
  tags: string[];
  incident_id: string;
};

export type HeldFiling = {
  ticker: string;
  kind: "filing" | "insider";
  label: string;
  filed_at: string;
  url: string;
};

export type HeldMeasurementType =
  | "unexplained_move"
  | "volume_anomaly"
  | "drift_event"
  | "gap_event"
  | "news_burst"
  | "insider_cluster";

export type HeldMeasurement = {
  ticker: string;
  type: HeldMeasurementType;
  detail: string;
  at: string;
};

/**
 * tracked: the chain follows the name. price_only: prices and filings, no news
 * quota. pending: not followed yet (just bought). The report says which, so an
 * empty news list is never read as "nothing happened".
 */
export type HeldCoverage = "tracked" | "price_only" | "pending";

// ---------------------------------------------------------------------------
// Book and risk
// ---------------------------------------------------------------------------

export type BriefingBook = {
  position_count: number;
  equity_usd: number;
  cash_usd: number;
  invested_usd: number;
  net_exposure_pct: number;
  gross_exposure_pct: number;
  overnight_pnl_usd: number | null;
  overnight_pnl_pct: number | null;
  top_weights: Array<{ ticker: string; weight: number; side: "long" | "short" }>;
  /** Held symbols no price could be found for. */
  unpriced: string[];
  /**
   * Held symbols whose overnight move could not be measured, so the two
   * `overnight_pnl` figures above are a P&L over the rest of the book while
   * being expressed over the whole of equity: a split in the window (the move
   * is withheld rather than faked) or no pair of prices to measure from.
   * Optional, because a report built elsewhere may not carry it; absent is
   * read as "nothing was left out", which is what a full quote fetch gives.
   */
  pnl_excluded?: string[];
  priced_at: string;
};

export type BriefingRisk = {
  score: number | null;
  band: string | null;
  driver_component: string | null;
  driver_sentence: string | null;
  beta_eff: number | null;
  beta_port: number | null;
  port_vol_daily_pct: number | null;
  computed_at: string;
  /**
   * The engine keeps one risk account; this is whether the snapshot it returned
   * describes the book in the request. False means the figures belong to
   * another book and must not be shown as this one's.
   */
  matches_book: boolean;
};

export type HeldEarnings = {
  ticker: string;
  due_ymd: string;
  /** An unannounced hour is stored as after-close upstream, so it cannot be told apart. */
  timing: "bmo" | "amc_or_unspecified";
  sessions_until: number;
  fiscal_period: string | null;
  confirmed: boolean;
  source: "tracker" | "yahoo";
};

// ---------------------------------------------------------------------------
// Corporate events and today's calendar
// ---------------------------------------------------------------------------

export type IndexFamily = "sp" | "nasdaq100" | "russell" | "msci";

export type CorporateEventKind = "dividend" | "split" | "rebalance" | "earnings";

export type CorporateEvent = {
  id: string;
  kind: CorporateEventKind;
  /** NY calendar date. */
  date: string;
  sessions_until: number;
  ticker: string | null;
  index: IndexFamily | null;
  title: string;
  detail: string;
  /** Held symbols this concerns — for a rebalance, the held funds tracking that index. */
  affects_held: string[];
  /** confirmed: declared by the issuer. estimated: a provider projection. rule: per index methodology. */
  certainty: "confirmed" | "estimated" | "rule";
  source: "yahoo_calendar" | "yahoo_chart" | "tracker" | "rule" | "curated";
};

/** What the corporate-events list can and cannot know, said in the report itself. */
export type CorporateCoverage = {
  dividends: string;
  splits: string;
  /** Held symbols the provider returned nothing for (funds, mostly). */
  unknown_symbols: string[];
};

export type CalendarItemKind = "fomc" | "data" | "opex" | "earnings" | "session" | "rebalance";

export type CalendarItem = {
  id: string;
  kind: CalendarItemKind;
  /** "HH:MM" ET, or null for an all-day item. */
  time_et: string | null;
  /** The same moment as a UTC ISO instant, so a client never converts ET itself. */
  at: string | null;
  title: string;
  detail: string | null;
  importance: 1 | 2 | 3;
  tickers: string[];
  source: string;
};

export type CalendarCoverage = {
  from: string;
  until: string;
  /** NY calendar date, YYYY-MM-DD: when the curated file was compiled. */
  compiled_at: string;
  /** False once the target session is past the curated file's last date. */
  covers_target: boolean;
  days_left: number;
};

// ---------------------------------------------------------------------------
// Curated macro calendar (compiled from official schedules, shipped in the repo)
// ---------------------------------------------------------------------------

export type MacroSource = { id: string; name: string; url: string; retrieved_at: string };

export type MacroEvent = {
  /** NY calendar date. */
  date: string;
  /** "HH:MM" ET; null when the agency gives no time. */
  time_et: string | null;
  kind: "fomc" | "data";
  /** Stable short code: FOMC, CPI, NFP, PCE, GDP, RETAIL, ISM_MFG, CLAIMS... */
  code: string;
  title: string;
  /** The period the release covers, as the agency words it ("August 2026"). */
  period?: string;
  importance: 1 | 2 | 3;
  /** A `MacroSource.id`. */
  source: string;
};

export type IndexEvent = {
  /** The session after whose close the change takes effect (NY calendar date). */
  date: string;
  family: IndexFamily;
  /** A noun phrase ("Russell index reconstitution"): templates splice it into a sentence. */
  title: string;
  source: string;
};

/** A session the algorithmic NYSE calendar gets wrong (an ad-hoc early close). */
export type SessionOverride = {
  date: string;
  early_close: boolean;
  note: string;
  source: string;
};

export type MacroCalendarFile = {
  schema_version: number;
  compiled_at: string;
  coverage: { from: string; until: string };
  /**
   * The last date each source's schedule was published through. `coverage.until`
   * is the minimum over the sources that carry importance-3 rows: an index
   * provider's schedule ending early does not hide a CPI print.
   */
  per_source_until: Record<string, string>;
  sources: MacroSource[];
  events: MacroEvent[];
  index_events: IndexEvent[];
  session_overrides: SessionOverride[];
};

/** Corrections applied over the shipped file at run time, without a release. */
export type MacroCalendarOverlay = {
  events?: MacroEvent[];
  remove_event_ids?: string[];
  index_events?: IndexEvent[];
  session_overrides?: SessionOverride[];
};

// ---------------------------------------------------------------------------
// Implications — what the figures mean for this book
// ---------------------------------------------------------------------------

/**
 * The report's conclusions, drawn from its own figures: what they add up to
 * for the reader's book, not what the reader ought to do about it. Each one
 * carries the data it rests on (`because`) and, where a sensitivity can be
 * computed, an either-way scenario sized on the book. No instruction and no
 * forecast: a scenario says "a move of this size either way is this much of
 * the book", never which way it goes.
 *
 * open_indication: futures times book beta, the book's move implied at the open.
 * name_specific: a held name moving apart from what its beta and the market explain.
 * event_sensitivity: today's largest scheduled release, sized through book beta.
 * earnings_exposure: a held name reporting soon, sized by its weight and its own volatility.
 * index_flow: a rebalance or quarterly expiry at a close where held funds trade.
 * ex_dividend: a held name whose price drops by the dividend at the open, by construction.
 * concentration: one position large enough to carry the book by itself.
 * data_gap: an input the conclusions need is missing, so they stop short.
 */
export type ImplicationKind =
  | "open_indication"
  | "name_specific"
  | "event_sensitivity"
  | "earnings_exposure"
  | "index_flow"
  | "ex_dividend"
  | "concentration"
  | "data_gap";

export type Implication = {
  /** Stable across rebuilds of the same morning: kind plus its subject. */
  id: string;
  kind: ImplicationKind;
  /** The conclusion, one sentence. Percentages only, never an account dollar amount. */
  headline: string;
  /** The figures it rests on, one short sentence. */
  because: string;
  /** "A 1% index move either way is about 1.2% of the book." Null when no sensitivity applies. */
  scenario: string | null;
  /** The scenario's size on this book in dollars, for the panel to show (and mask). Never in any text. */
  scenario_usd: number | null;
  /** How much of the book this concerns, in percent; what the list is ranked by. */
  book_pct: number | null;
  tickers: string[];
};

// ---------------------------------------------------------------------------
// What happened — headlines and the stories built from them
// ---------------------------------------------------------------------------

/**
 * A market-wide headline since the last US close, read off the provider's
 * search news for a fixed set of index, futures and macro symbols (the same
 * keyless provider the stock view's news uses). Third-party text: the
 * narrative summarises it in its own words and never pastes it.
 */
export type MarketHeadline = {
  id: string;
  title: string;
  source: string;
  url: string;
  published_at: string;
  /** Tickers the provider tagged the article with. */
  related: string[];
  /** The query symbol that surfaced it (SPY, QQQ, ^VIX, TLT, CL=F...). */
  via: string;
};

/**
 * market: the tape as a whole (a headline the indices or futures moved on).
 * name: one held name (a headline, a filing, or a move of its own).
 * release: a scheduled item that has already printed this session.
 */
export type StoryScope = "market" | "name" | "release";

/** One figure a story rests on, for the panel to show as a chip beside the sentence. */
export type StoryReaction = {
  label: string;
  symbol: string | null;
  /** In `unit`; null when the print is stale or missing. */
  move: number | null;
  unit: MarketUnit;
};

/**
 * The unit the report leads with: something happened, something reacted, and
 * here is what that means for this book. "Futures fell 0.65%" alone is a
 * number; "futures fell 0.65% after a Middle East headline, which is about
 * 0.6% off the book at the open" is a story. Causes are stated only where a
 * headline in the evidence states them; otherwise the reaction stands beside
 * the event without a claimed link.
 */
export type Story = {
  /** Stable for the same evidence: scope plus its subject. */
  id: string;
  scope: StoryScope;
  /** When it happened, UTC ISO; null when the story is the session itself. */
  at: string | null;
  /** What happened, one sentence in the report's own words. */
  what: string;
  /** How the market or the name reacted, one sentence carrying the figures. */
  reaction: string;
  reactions: StoryReaction[];
  /** What it means for this book, in one sentence, or null when nothing follows for it. */
  meaning: string | null;
  tickers: string[];
  /** Ids of the headlines, filings, movers, calendar items or implications it rests on. */
  evidence: string[];
  /** Whether a model wrote the sentences or the template assembled them. */
  source: "model" | "template";
};

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

export type BriefingNarrative = {
  text: string;
  source: "model" | "template";
  model: string | null;
  generated_at: string;
  /** Hash of the salient facts the text was written from. */
  facts_hash: string;
  /** A model version has been asked for and has not arrived yet. */
  pending: boolean;
  /** Why the template stands in, when it does. */
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type BriefingSectionKey =
  | "markets"
  | "held_quotes"
  | "chain_news"
  | "market_news"
  | "quant"
  | "risk"
  | "corporate_actions"
  | "macro_calendar"
  | "narrative";

/** One input that failed. Every section degrades on its own; the report still ships. */
export type BriefingDegraded = {
  section: BriefingSectionKey;
  detail: string;
  symbols?: string[];
};

export type BriefingReport = {
  schema_version: number;
  generated_at: string;
  /** Built in the renderer from a demo book; never touched a provider. */
  demo: boolean;
  /** Built against a developer-supplied clock. Never true in a packaged build. */
  synthetic_now: boolean;
  window: BriefingWindow;
  overnight: {
    markets: MarketRow[];
    held_movers: HeldMover[];
    held_news: HeldNewsItem[];
    filings: HeldFiling[];
    measurements: HeldMeasurement[];
  };
  held_coverage: Array<{ ticker: string; coverage: HeldCoverage }>;
  book: BriefingBook;
  risk: BriefingRisk | null;
  earnings_next: HeldEarnings[];
  corporate_events: CorporateEvent[];
  corporate_coverage: CorporateCoverage;
  calendar_today: CalendarItem[];
  calendar_coverage: CalendarCoverage;
  /** Market-wide headlines since the last US close, newest first, de-duplicated by url. */
  headlines: MarketHeadline[];
  /** What the report leads with: most consequential first, at most six. */
  stories: Story[];
  /** Most consequential first, at most five. Empty when nothing clears the bar. */
  implications: Implication[];
  /** The one- or two-sentence lead over the stories. */
  narrative: BriefingNarrative;
  facts_hash: string;
  degraded: BriefingDegraded[];
};

// ---------------------------------------------------------------------------
// Ports — everything the assembly needs from the outside world
// ---------------------------------------------------------------------------

/** One chart-meta read of an index, future or macro symbol. */
export type MarketSnapshot = {
  symbol: string;
  price: number | null;
  previous_close: number | null;
  /** When `price` printed (the exchange's own clock), UTC ISO. */
  market_time: string | null;
  /** Whether the symbol's own regular session is trading right now. */
  in_regular_session: boolean;
  /**
   * When the provider's current chart day opened, UTC ISO
   * (`meta.currentTradingPeriod.regular.start` on a Yahoo chart read).
   * `previous_close` is the close of the chart day BEFORE this one, so a chart
   * day that opened at or before the last US close carries a baseline from a
   * session too far back and the move is withheld (see `marketRow`). Optional:
   * a port that cannot say leaves it out, and the move stands as it did.
   */
  session_start?: string | null;
};

/** An extended-hours aware quote for a held name. */
export type HeldQuote = {
  symbol: string;
  /** The latest print, pre/post market included. */
  price: number | null;
  /** The last regular-session price: the previous US close while the US is not trading. */
  regular_price: number | null;
  /** The close before `regular_price`'s session. */
  previous_close: number | null;
  session: HeldSession | null;
  as_of: string | null;
};

export type QuantSlice = { daily_vol_30d: number | null; beta: number | null };

/** What the chain knows about one held name since the last US close. */
export type ChainTickerSlice = {
  ticker: string;
  coverage: HeldCoverage;
  news: HeldNewsItem[];
  filings: HeldFiling[];
  measurements: HeldMeasurement[];
  scheduled_earnings: Array<{ due_at: string; confirmed: boolean; fiscal_period: string | null }>;
};

/** The risk snapshot, reduced to what the briefing prints. */
export type RiskLatestLite = {
  score: number | null;
  band: string | null;
  driver_component: string | null;
  driver_sentence: string | null;
  beta_eff: number | null;
  beta_port: number | null;
  port_vol_daily_pct: number | null;
  computed_at: string;
  /** The tickers the snapshot was computed over. */
  tickers: string[];
};

/** What the provider returned for one symbol's corporate calendar. */
export type CorporateCalendarRaw = {
  symbol: string;
  /** False when the provider had nothing at all (funds). */
  available: boolean;
  /** NY calendar dates, straight from the provider's own formatted field. */
  ex_dividend_date: string | null;
  dividend_date: string | null;
  /** The provider's indicated ANNUAL rate per share, not one payment. */
  dividend_rate: number | null;
  earnings_dates: string[];
  earnings_estimated: boolean | null;
  /** Past distributions and splits, newest last. */
  recent_dividends: Array<{ date: string; amount: number }>;
  recent_splits: Array<{ date: string; numerator: number; denominator: number }>;
};

export type BriefingPorts = {
  marketSnapshot(symbol: string): Promise<MarketSnapshot>;
  heldQuote(symbol: string): Promise<HeldQuote>;
  quant(symbol: string): Promise<QuantSlice | null>;
  chainSlice(ticker: string, held: string[], overnightSince: string): Promise<ChainTickerSlice>;
  riskLatest(): Promise<RiskLatestLite | null>;
  corporateCalendar(symbol: string): Promise<CorporateCalendarRaw>;
  /** Market-wide headlines published at or after `since`, across the fixed query symbols. */
  marketNews(since: string): Promise<MarketHeadline[]>;
  calendarOverlay?(): Promise<MacroCalendarOverlay | null>;
};

// ---------------------------------------------------------------------------
// IPC results (desktop)
// ---------------------------------------------------------------------------

/** Fixed codes only: no provider text, and so no secret, crosses into the renderer. */
export type BriefingErrorCode = "invalid_request" | "build_failed" | "not_found" | "unavailable";

export type BriefingWindowResult =
  | { ok: true; window: BriefingWindow; calendar_coverage: CalendarCoverage }
  | { ok: false; error: BriefingErrorCode };

export type BriefingGetResult =
  | { ok: true; report: BriefingReport; source: "cache" | "fresh" }
  | { ok: false; error: BriefingErrorCode };

export type BriefingNarrativeRequest = { target_session_ymd: string; facts_hash: string };

/**
 * `stories` are the ones settled on in the same model call as the narrative
 * (the report's own, template-written, when the model could not be used), so
 * the panel swaps its lead and its stories together.
 */
export type BriefingNarrativeResult =
  | { ok: true; narrative: BriefingNarrative; stories: Story[] }
  | { ok: false; error: BriefingErrorCode };
