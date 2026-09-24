/**
 * Session calendar: the demo report (Ctrl+P presentation mode).
 *
 * Builds a complete `CalendarReport` from the demo book without touching a
 * provider or the chain, so the calendar can be shown on stage with no
 * network and no keys. Every row is drawn from the injected `rand` (the demo
 * seed's generator) and every instant is derived from the window the caller
 * passes in: no clock is read here, and the same seed and window always give
 * the same report.
 *
 * The rows are worded the way the engine words them, so a demo and a real
 * report never list the same kind of day two ways on the one surface where an
 * audience is watching.
 */

import type { CalendarCoverage, CalendarHolding, CalendarItem, CalendarReport, HeldEarnings, SessionWindow } from "./calendar-types";

/**
 * Mirrors the engine's CALENDAR_SCHEMA_VERSION: 1, the shape this file
 * writes. Kept as a literal so a report built here is stamped with the shape
 * this file actually writes: importing the constant would stamp every demo
 * report with whatever the engine has moved on to, whether or not the fields
 * came with it.
 */
const DEMO_SCHEMA_VERSION = 1;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The report is stamped 2 h 14 min before the open (07:16 ET on a normal
 * day): the morning a reader meets the calendar on, with every timed row
 * still ahead of the "now" line.
 */
const LEAD_BEFORE_OPEN_MS = (2 * 60 + 14) * MINUTE_MS;

/** The 09:30 ET open, in minutes of the day, the anchor every ET wall time is placed against. */
const OPEN_MINUTES_ET = 9 * 60 + 30;

/** A position under this many shares is a rounding residue, not a holding. */
const FLAT_SHARES = 1e-9;

/** About one demo in four has a held name reporting on the session it lists. */
const EARNINGS_TODAY_CHANCE = 0.25;

/**
 * The funds the demo book can hold. A fund never reports earnings, so the
 * roll for "a held name reports today" is made over the companies only.
 */
const DEMO_FUNDS: ReadonlySet<string> = new Set([
  "SPY", "VOO", "QQQ", "VTI", "SCHD", "IWM", "SMH", "XLK", "ARKK", "GLD", "TLT", "VXUS", "IBIT", "JEPI",
]);

type DemoRelease = {
  code: string;
  title: string;
  time: "08:30" | "10:00";
  importance: 1 | 2 | 3;
  source: string;
  weekly?: boolean;
};

const DEMO_RELEASES: DemoRelease[] = [
  { code: "CPI", title: "Consumer Price Index", time: "08:30", importance: 3, source: "bls" },
  { code: "PPI", title: "Producer Price Index", time: "08:30", importance: 2, source: "bls" },
  { code: "RETAIL", title: "Retail sales", time: "08:30", importance: 3, source: "census" },
  { code: "CLAIMS", title: "Initial jobless claims", time: "08:30", importance: 2, source: "dol", weekly: true },
  { code: "DURABLES", title: "Durable goods orders", time: "08:30", importance: 2, source: "census" },
  { code: "HOUSING", title: "Housing starts", time: "08:30", importance: 1, source: "census" },
  { code: "ISM_MFG", title: "ISM Manufacturing PMI", time: "10:00", importance: 3, source: "ism" },
  { code: "ISM_SVC", title: "ISM Services PMI", time: "10:00", importance: 2, source: "ism" },
  { code: "JOLTS", title: "Job openings (JOLTS)", time: "10:00", importance: 2, source: "bls" },
  { code: "SENTIMENT", title: "Consumer sentiment", time: "10:00", importance: 2, source: "umich" },
  { code: "NEW_HOMES", title: "New home sales", time: "10:00", importance: 1, source: "census" },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function intBetween(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Draws `n` items without replacement, in draw order. */
function pickSome<T>(rand: () => number, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ymdToMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function msToYmd(ms: number): string {
  return iso(ms).slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  return msToYmd(ymdToMs(ymd) + days * DAY_MS);
}

function fiscalPeriod(ymd: string): string {
  const year = Number(ymd.slice(0, 4));
  const quarter = Math.ceil(Number(ymd.slice(5, 7)) / 3);
  return quarter === 1 ? `Q4 ${year - 1}` : `Q${quarter - 1} ${year}`;
}

/**
 * The engine's own wording. Upstream an unannounced hour is stored as after
 * the close, so the real report cannot say "after the close" on its own, and
 * a demo that did would promise a precision the product does not have.
 */
function earningsTimingWords(e: HeldEarnings): string {
  return e.timing === "bmo" ? "before the open" : "after the close, or at an hour not yet announced";
}

/** One row per symbol, upper-cased, with residue and unreadable rows dropped. */
function mergeHoldings(positions: readonly CalendarHolding[]): CalendarHolding[] {
  const merged = new Map<string, CalendarHolding>();
  for (const p of positions) {
    const symbol = typeof p.symbol === "string" ? p.symbol.trim().toUpperCase() : "";
    if (symbol === "" || !Number.isFinite(p.shares) || Math.abs(p.shares) < FLAT_SHARES) continue;
    const existing = merged.get(symbol);
    if (existing) existing.shares += p.shares;
    else merged.set(symbol, { symbol, shares: p.shares });
  }
  return [...merged.values()].filter((h) => Math.abs(h.shares) >= FLAT_SHARES);
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

type Clock = {
  openMs: number;
  generatedMs: number;
  targetYmd: string;
};

/**
 * Every instant in the report hangs off the target open. A window that does
 * not parse (hand-built in a preview, or a contract drift) falls back to a
 * fixed instant instead of throwing: demo mode is switched on in front of an
 * audience, and a blank card there is worse than a report with odd dates.
 */
function resolveClock(window: SessionWindow): Clock {
  const ymdOk = /^\d{4}-\d{2}-\d{2}$/.test(window.target_session_ymd) && Number.isFinite(ymdToMs(window.target_session_ymd));
  let openMs = Date.parse(window.target_open_at);
  if (!Number.isFinite(openMs)) {
    openMs = ymdOk ? ymdToMs(window.target_session_ymd) + 13.5 * HOUR_MS : Date.UTC(2026, 0, 5, 14, 30);
  }
  return { openMs, generatedMs: openMs - LEAD_BEFORE_OPEN_MS, targetYmd: ymdOk ? window.target_session_ymd : msToYmd(openMs) };
}

/** An "HH:MM" ET wall time on the target day as an instant, placed relative to the 09:30 open. */
function etInstant(clock: Clock, timeEt: string): string {
  const [h, m] = timeEt.split(":").map(Number);
  return iso(clock.openMs + (h * 60 + m - OPEN_MINUTES_ET) * MINUTE_MS);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * A held company reporting on the session, about one time in four. Confirmed
 * and from the chain, as the engine has it for a date it can vouch for; the
 * hour is a coin toss between the two the engine can tell apart.
 */
function buildEarnings(rand: () => number, companies: readonly string[], clock: Clock): HeldEarnings[] {
  if (companies.length === 0 || rand() >= EARNINGS_TODAY_CHANCE) return [];
  const [ticker] = pickSome(rand, companies, 1);
  return [
    {
      ticker,
      due_ymd: clock.targetYmd,
      timing: rand() < 0.5 ? "bmo" : "amc_or_unspecified",
      sessions_until: 0,
      fiscal_period: fiscalPeriod(clock.targetYmd),
      confirmed: true,
      source: "tracker",
    },
  ];
}

function buildCalendar(rand: () => number, window: SessionWindow, clock: Clock, earnings: readonly HeldEarnings[]): CalendarItem[] {
  const items: CalendarItem[] = [];
  const priorMonth = addDays(`${clock.targetYmd.slice(0, 7)}-01`, -1).slice(0, 7);

  // Session items are the exceptions only, worded as the engine words them. An
  // ordinary session gets no line in the real report, so it gets none here: a
  // "Regular session" row on stage would be a row no user ever sees.
  if (window.early_close) {
    items.push({
      id: "demo-session-early-close",
      kind: "session",
      time_et: null,
      at: null,
      title: "Early close at 13:00 ET",
      detail: "US equities close at 13:00 ET this session.",
      importance: 2,
      tickers: [],
      source: "rule",
    });
  }
  if (window.gap === "holiday") {
    items.push({
      id: "demo-session-after-holiday",
      kind: "session",
      time_et: null,
      at: null,
      title: "First session after a US market holiday",
      detail: "Markets abroad traded while the US was closed.",
      importance: 1,
      tickers: [],
      source: "rule",
    });
  }

  // A decision day carries little else: the agencies keep the 08:30 slot
  // clear of first-tier releases, so the demo shows one or the other.
  if (rand() < 1 / 3) {
    items.push({
      id: "demo-fomc",
      kind: "fomc",
      time_et: "14:00",
      at: etInstant(clock, "14:00"),
      title: "FOMC rate decision",
      detail: "Statement at 14:00 ET, press conference at 14:30 ET.",
      importance: 3,
      tickers: [],
      source: "fed",
    });
  } else {
    for (const release of pickSome(rand, DEMO_RELEASES, intBetween(rand, 2, 4))) {
      items.push({
        id: `demo-data-${release.code}`,
        kind: "data",
        time_et: release.time,
        at: etInstant(clock, release.time),
        title: release.title,
        // The period is numeric on purpose: one month's name is also a modal
        // verb the copy rules ban, and a "2026-05" never trips them.
        detail: release.weekly ? "Covers the prior week." : `Covers ${priorMonth}.`,
        importance: release.importance,
        tickers: [],
        source: release.source,
      });
    }
  }

  if (rand() < 0.25) {
    items.push({
      id: "demo-opex",
      kind: "opex",
      time_et: null,
      at: null,
      title: "Monthly options expiry",
      detail: "Standard monthly equity and index options expire at the close.",
      importance: 2,
      tickers: [],
      source: "rule",
    });
  }

  for (const e of earnings) {
    if (e.sessions_until !== 0) continue;
    const timing = earningsTimingWords(e);
    items.push({
      id: `demo-earnings-${e.ticker}`,
      kind: "earnings",
      time_et: null,
      at: null,
      title: `${e.ticker} earnings report`,
      detail: `${timing.charAt(0).toUpperCase()}${timing.slice(1)}.`,
      // A held name reporting is about this book, so the engine ranks it with
      // the first-tier releases.
      importance: 3,
      tickers: [e.ticker],
      source: e.source,
    });
  }

  // All-day items lead, then the clock; within one slot the heavier item first.
  return items.sort((a, b) => {
    if (a.time_et === null || b.time_et === null) {
      if (a.time_et !== b.time_et) return a.time_et === null ? -1 : 1;
    } else if (a.time_et !== b.time_et) {
      return a.time_et < b.time_et ? -1 : 1;
    }
    return b.importance - a.importance || (a.id < b.id ? -1 : 1);
  });
}

function buildCalendarCoverage(rand: () => number, clock: Clock): CalendarCoverage {
  // Anchored to the target instead of to a fixed year, so the demo never
  // shows the "calendar is running out" state merely because it is December.
  const until = addDays(clock.targetYmd, intBetween(rand, 90, 210));
  return {
    from: addDays(clock.targetYmd, -intBetween(rand, 150, 240)),
    until,
    // A calendar date, as in the engine: the curated file records the day it
    // was compiled, not an instant.
    compiled_at: addDays(clock.targetYmd, -intBetween(rand, 5, 30)),
    covers_target: true,
    days_left: Math.round((ymdToMs(until) - ymdToMs(clock.targetYmd)) / DAY_MS),
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export function buildDemoCalendar(rand: () => number, window: SessionWindow, holdings: readonly CalendarHolding[]): CalendarReport {
  const clock = resolveClock(window);
  const companies = mergeHoldings(holdings)
    .map((h) => h.symbol)
    .filter((symbol) => !DEMO_FUNDS.has(symbol));

  const earnings = buildEarnings(rand, companies, clock);
  const items = buildCalendar(rand, window, clock, earnings);
  const coverage = buildCalendarCoverage(rand, clock);

  // Forced to the pre-open phase because that is the moment the report is
  // stamped at, and the one the card is designed around: viewed from its own
  // stamp, a demo is always the morning of the session it lists.
  const reportWindow: SessionWindow = { ...window, phase: "pre_open" };

  return {
    schema_version: DEMO_SCHEMA_VERSION,
    generated_at: iso(clock.generatedMs),
    demo: true,
    window: reportWindow,
    items,
    coverage,
    degraded: [],
  };
}
