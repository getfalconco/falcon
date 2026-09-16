/**
 * Filing and earnings history, rebuilt point-in-time (§3, §4).
 *
 * Tracker persists only the last four earnings announcements, but it keeps the
 * FULL filing list unpruned — 8-K item codes with EDGAR acceptance timestamps
 * going back years. Everything here is derived from that, offline, with no
 * network call.
 *
 * The acceptance timestamp is what makes entry timing honest. A release
 * accepted at 20:30 UTC is not information you had at that session's close, so
 * an `after_close` event forbids a `signal_close` entry (§6). Getting this
 * wrong is the single easiest way to manufacture a backtest edge that cannot
 * exist, which is why it is decided here from the timestamp rather than
 * assumed by the strategy.
 */

import { sessionTimes } from "../tracker/calendar.js";
import type { FilingRecord, TickerState } from "../tracker/types.js";
import type { TradingCalendar } from "./calendar.js";

/** 8-K item code that carries a results release. */
export const EARNINGS_ITEM = "2.02";

export type FilingEvent = {
  ticker: string;
  form: string;
  accession: string;
  /** EDGAR filing date. */
  filed_at: string;
  accepted_at: string | null;
  items: string[];
  /** Trading session this event is attributed to. */
  session: string;
  /**
   * True when the filing became public at or after that session's close, so a
   * rule triggering on it cannot enter at that close.
   */
  after_close: boolean;
};

/** How a filing's acceptance instant sits against its own session. */
function acceptanceHour(filing: FilingRecord): "bmo" | "dmh" | "amc" | null {
  if (!filing.acceptedAt) return null;
  const accepted = new Date(filing.acceptedAt);
  if (Number.isNaN(accepted.getTime())) return null;
  const times = sessionTimes(filing.filedAt);
  // Not a trading day by the algorithmic calendar (weekend, holiday, or an
  // ad-hoc closure): treat as after the close, the conservative direction.
  if (!times) return "amc";
  if (accepted.getTime() < times.openUtc.getTime()) return "bmo";
  if (accepted.getTime() >= times.closeUtc.getTime()) return "amc";
  return "dmh";
}

/**
 * Maps one filing onto the session a rule may act on, and whether that
 * session's close is still available.
 *
 * Unknown acceptance time is treated as after the close — an unknown is never
 * resolved in the backtest's favour.
 */
export function attributeFiling(filing: FilingRecord, calendar: TradingCalendar): { session: string; after_close: boolean } | null {
  if (calendar.has(filing.filedAt)) {
    const hour = acceptanceHour(filing);
    return { session: filing.filedAt, after_close: hour === "amc" || hour == null };
  }
  // Filed on a non-session (weekend/holiday): the market's first chance to
  // react is the next session's open, and its close is therefore available.
  const next = calendar.onOrAfter(filing.filedAt);
  if (!next) return null;
  return { session: next, after_close: false };
}

export type FilingEventOptions = {
  /** Only keep these forms. Defaults to 8-K. */
  forms?: string[];
  /** Only keep filings carrying at least one of these item codes. */
  items?: string[];
};

/** Every filing event for a ticker, oldest first. */
export function buildFilingEvents(
  state: TickerState,
  calendar: TradingCalendar,
  options: FilingEventOptions = {},
): FilingEvent[] {
  const forms = new Set((options.forms ?? ["8-K"]).map((f) => f.toUpperCase()));
  const wanted = options.items ? new Set(options.items) : null;
  const out: FilingEvent[] = [];
  for (const filing of state.filings ?? []) {
    if (!filing || typeof filing.filedAt !== "string") continue;
    if (!forms.has((filing.form ?? "").toUpperCase())) continue;
    const items = Array.isArray(filing.items) ? filing.items : [];
    if (wanted && !items.some((i) => wanted.has(i))) continue;
    const attributed = attributeFiling(filing, calendar);
    if (!attributed) continue;
    out.push({
      ticker: state.ticker.toUpperCase(),
      form: filing.form,
      accession: filing.accessionNumber,
      filed_at: filing.filedAt,
      accepted_at: filing.acceptedAt ?? null,
      items,
      session: attributed.session,
      after_close: attributed.after_close,
    });
  }
  return out.sort((a, b) => a.session.localeCompare(b.session) || a.accession.localeCompare(b.accession));
}

/**
 * Full earnings announcement history from item 2.02 filings — the whole run,
 * not Tracker's trailing four.
 */
export function buildEarningsHistory(state: TickerState, calendar: TradingCalendar): FilingEvent[] {
  return buildFilingEvents(state, calendar, { forms: ["8-K"], items: [EARNINGS_ITEM] });
}

// ---------------------------------------------------------------------------
// Point-in-time earnings proximity
// ---------------------------------------------------------------------------

export type NextEarnings = {
  due_session: string;
  sessions_until: number;
};

/**
 * The next earnings announcement as of `session`, or null when none is close
 * enough to count as known.
 *
 * The honesty problem: historically the only record that an announcement
 * happened is the 8-K itself, so reconstructing "earnings in N sessions"
 * necessarily reads a future filing. Companies do pre-announce their date,
 * typically a few weeks out, so a bounded horizon approximates what was
 * genuinely knowable. Beyond the horizon the event is invisible to the rule —
 * which is the conservative direction, and the approximation is declared on
 * every report page rather than buried here.
 */
export function nextEarningsAsOf(
  session: string,
  announcements: FilingEvent[],
  calendar: TradingCalendar,
  horizonSessions: number,
): NextEarnings | null {
  for (const event of announcements) {
    if (event.session <= session) continue;
    const until = calendar.between(session, event.session);
    if (until == null) continue;
    if (until > horizonSessions) return null;
    return { due_session: event.session, sessions_until: until };
  }
  return null;
}

/**
 * Whether an earnings announcement falls within `sessions` either side of
 * `session` — the §5 `no_earnings_within` filter.
 *
 * Looking back is free; looking forward is bounded by the same knowledge
 * horizon, so the filter cannot reject a signal on the strength of a date
 * nobody could have known.
 */
export function earningsWithin(
  session: string,
  sessions: number,
  announcements: FilingEvent[],
  calendar: TradingCalendar,
  horizonSessions: number,
): boolean {
  for (const event of announcements) {
    const delta = calendar.between(session, event.session);
    if (delta == null) continue;
    if (delta <= 0 && delta >= -sessions) return true;
    if (delta > 0 && delta <= sessions && delta <= horizonSessions) return true;
  }
  return false;
}

/**
 * Mean absolute 1-session move on past earnings reactions, as of `session`
 * (Tracker's `earnings_rhythm`, §3.8). Needs at least two observations; null
 * otherwise rather than a number built from one event.
 */
export function earningsRhythmAsOf(
  session: string,
  announcements: FilingEvent[],
  returnBySession: Map<string, number | null>,
  calendar: TradingCalendar,
  maxObservations = 8,
): number | null {
  const moves: number[] = [];
  for (let i = announcements.length - 1; i >= 0 && moves.length < maxObservations; i--) {
    const event = announcements[i];
    if (event.session > session) continue;
    // An after-close release moves the NEXT session; anything else moves its own.
    const reaction = event.after_close ? calendar.shift(event.session, 1) : event.session;
    if (!reaction || reaction > session) continue;
    const ret = returnBySession.get(reaction);
    if (ret == null || !Number.isFinite(ret)) continue;
    moves.push(Math.abs(ret));
  }
  if (moves.length < 2) return null;
  return moves.reduce((a, b) => a + b, 0) / moves.length;
}
