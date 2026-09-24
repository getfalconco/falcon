/**
 * Session calendar — contracts.
 *
 * What is scheduled for a US session: the macro releases and FOMC decisions
 * from the curated calendar, options expiries and index rebalances by rule,
 * the earnings dates of the names a reader holds, and the session's own
 * exceptions (an early close, the first day back after a holiday). Every row
 * is deterministic over the curated file, the date rules and two provider
 * reads; nothing here is written by a model.
 *
 * Types only, no imports: this file is published as the renderer-safe half of
 * the engine (`@meridian/research/calendar/contracts`), so nothing here may
 * pull in fs, the network or another engine's Node-only surface.
 */

export const CALENDAR_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** One position as the renderer holds it: the symbol is all the calendar needs, the shares say it is not dust. */
export type CalendarHolding = {
  symbol: string;
  shares: number;
};

export type CalendarRequest = {
  holdings: CalendarHolding[];
  /** Skip the main process's report cache: the reader asked for a fresh read. */
  force?: boolean;
};

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export type SessionPhase = "pre_open" | "in_session" | "between_sessions";

/** Why the gap since the last US close is as long as it is. */
export type SessionGap = "overnight" | "weekend" | "holiday";

/**
 * Which US session a calendar is for, and where the clock stands against it.
 * The close, not the open, flips the target: at 11:00 the session listed is
 * today's, and only after the bell does it become tomorrow's.
 */
export type SessionWindow = {
  /** The US session the calendar lists (NY calendar date). */
  target_session_ymd: string;
  /** The last completed US session before it. */
  prev_session_ymd: string;
  /** That session's close (13:00 ET on an early close), UTC ISO. */
  overnight_since: string;
  /** 20:00 ET on the calendar day before the target, UTC ISO: from here the evening belongs to the next session. */
  window_opens_at: string;
  target_open_at: string;
  target_close_at: string;
  phase: SessionPhase;
  gap: SessionGap;
  /** The target session closes at 13:00 ET. */
  early_close: boolean;
};

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

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
// The day's rows
// ---------------------------------------------------------------------------

export type IndexFamily = "sp" | "nasdaq100" | "russell" | "msci";

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
// The report
// ---------------------------------------------------------------------------

/** The inputs that can fail on their own. The calendar still ships with the section marked. */
export type CalendarSectionKey = "macro_calendar" | "earnings";

export type CalendarDegraded = {
  section: CalendarSectionKey;
  /** For a log, never for a reader: it can carry a provider's own words. */
  detail: string;
  /** Set when only some symbols failed; absent when the whole section did. */
  symbols?: string[];
};

export type CalendarReport = {
  schema_version: number;
  /** UTC ISO, the clock the rows were judged against. A demo report is viewed from this instant. */
  generated_at: string;
  demo: boolean;
  window: SessionWindow;
  /** All-day rows first, then the timed ones in clock order; within one slot the heavier row first. */
  items: CalendarItem[];
  coverage: CalendarCoverage;
  degraded: CalendarDegraded[];
};

// ---------------------------------------------------------------------------
// Ports (what the assembly asks of the world; Node side only)
// ---------------------------------------------------------------------------

/** What the chain (the Tracker) knows of one name's announced earnings dates. */
export type EarningsSlice = {
  scheduled_earnings: Array<{ due_at: string; confirmed: boolean; fiscal_period: string | null }>;
};

/** What the provider's forward calendar says for one symbol. */
export type CorporateCalendarRaw = {
  symbol: string;
  /** False when the provider had nothing at all (funds). */
  available: boolean;
  /** NY calendar dates, straight from the provider's own formatted field. */
  earnings_dates: string[];
  earnings_estimated: boolean | null;
};

export type CalendarPorts = {
  /** Null for a name the chain does not follow; a refusal is raised, never returned as empty. */
  earningsFromChain(ticker: string): Promise<EarningsSlice | null>;
  corporateCalendar(symbol: string): Promise<CorporateCalendarRaw>;
  calendarOverlay?(): Promise<MacroCalendarOverlay | null>;
};

// ---------------------------------------------------------------------------
// IPC results (desktop)
// ---------------------------------------------------------------------------

/** Fixed codes only: no provider text, and so no secret, crosses into the renderer. */
export type CalendarErrorCode = "invalid_request" | "build_failed" | "unavailable";

export type CalendarGetResult =
  | { ok: true; report: CalendarReport; source: "cache" | "fresh" }
  | { ok: false; error: CalendarErrorCode };
