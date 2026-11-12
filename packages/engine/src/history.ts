/**
 * The history behind a hit (Ripple Engine step 4, Validation): "when X had
 * this kind of event, Y moved N% within D days", measured, never estimated.
 *
 * For one card:
 *   1. The past events: the event company's own events of the same kind and
 *      the same sign over the last 5 years, before this one (src/past-events.ts).
 *      Same sign: an EPS beat for a beat (surprise above 0), a miss for a
 *      miss, from the EPS record; a monthly revenue rise from a year earlier
 *      for a rise. A past event whose sign the record does not give is left
 *      out, and so is a monthly report whose text gives no release date (its
 *      6-K can come days after the release).
 *   2. The reaction day of each: the first New York session that could trade
 *      on it. EDGAR's acceptance instant, in New York time: before the 09:30
 *      open, that day; during the session, that day too (part of the day
 *      traded before it); at or after the 16:00 close, or on a day with no
 *      session, the next session. When the EPS record dates the release a day
 *      earlier with a known time (an 8-K filed the morning after), or a
 *      Taiwan monthly report's own dateline is earlier than its 6-K (Taiwan's
 *      afternoon is before New York's open of that date), the earlier
 *      reaction day wins.
 *   3. The hit company's move from the close before the reaction day to the
 *      close `windowDays` sessions later, the reaction day counted (1 = the
 *      reaction day close to close), minus SPY's move between the same two
 *      closes. Adjusted closes, so splits and dividends are not moves.
 *      `windowDays` is the upper end of the hit's own window in trading days
 *      ("1 to 5 trading days" 5, "1 to 4 weeks" 20), capped at 20: past a
 *      month the move is mostly other news, and monthly events overlap.
 *      A window must end before this card's own reaction day.
 *   4. sample, the mean adjusted move (its actual sign), and the share that
 *      went the hit's implied way (above 0 for "up", below 0 for "down").
 *      Null below 6 measured events, and for an "unclear" hit (no implied way).
 *
 * Benchmark: SPY, not SOXX. SOXX holds the event company and most hit
 * companies (NVDA, AMD, TSM, KLAC, LRCX ...), so taking it out would cancel
 * much of the very co-movement a ripple is about, and partly the hit's own
 * move. SPY takes out the market's day.
 *
 * Survivorship: the hit companies are the ones listed today, measured back
 * over the years they traded; companies delisted since are in no history.
 * Half-day sessions are not modelled: a release between 13:00 and 16:00 on a
 * day the market closed at 13:00 counts as during the session.
 */

import type { Direction, RippleCard, RippleHistory } from "@falcon/ripple";
import { signOf, type EventBasis } from "./events.ts";
import type { DailyClose, MarketData, ReportedQuarter } from "./market.ts";
import type { PastEvent } from "./past-events.ts";

export const HISTORY_MIN_SAMPLE = 6;
export const HISTORY_YEARS = 5;
export const MAX_WINDOW_DAYS = 20;
export const BENCHMARK = "SPY";

// ---------------------------------------------------------------------------
// Sessions and reaction days (pure)

export type Session = "before_open" | "during" | "after_close";

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

/** New York's calendar date and session for an instant. Pure. */
export function nySession(ms: number): { date: string; session: Session } {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const session: Session = minutes < OPEN_MIN ? "before_open" : minutes < CLOSE_MIN ? "during" : "after_close";
  return { date: `${p.year}-${p.month}-${p.day}`, session };
}

/**
 * Index in `calendar` (trading dates, oldest first) of the reaction day of a
 * release on New York `date` in `session`: that date when it trades and the
 * release came before its close, else the next trading date. Null when the
 * calendar has no such day, or no day before it to measure from. Pure.
 */
export function reactionIndex(calendar: readonly string[], date: string, session: Session): number | null {
  let lo = 0;
  let hi = calendar.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (calendar[mid]! < date) lo = mid + 1;
    else hi = mid;
  }
  let i = lo;
  if (i < calendar.length && calendar[i] === date && session === "after_close") i++;
  if (i >= calendar.length || i < 1) return null;
  return i;
}

/**
 * The reaction day of a past release: from EDGAR's acceptance instant, or
 * from an earlier date and session the release itself is known by (the EPS
 * record's, a Taiwan dateline) when that gives an earlier day. Pure.
 */
export function eventReactionIndex(calendar: readonly string[], acceptedMs: number, record?: Pick<ReportedQuarter, "date" | "time"> | null): number | null {
  const at = nySession(acceptedMs);
  const fromEdgar = reactionIndex(calendar, at.date, at.session);
  if (!record || record.time === "unknown" || record.date >= at.date) return fromEdgar;
  const fromRecord = reactionIndex(calendar, record.date, record.time);
  if (fromRecord === null) return fromEdgar;
  return fromEdgar === null ? fromRecord : Math.min(fromEdgar, fromRecord);
}

/**
 * The trading days to measure for a hit's window in words: its upper end
 * ("1 to 5 trading days" 5, "1 to 4 weeks" 20, "2 months" 42), capped at
 * MAX_WINDOW_DAYS; 5 when the words give no number. Pure.
 */
export function windowTradingDays(window: string): number {
  const m = /(\d+)(?:\s*(?:to|-|–)\s*(\d+))?\s*(trading days?|days?|sessions?|weeks?|months?)/i.exec(window);
  if (!m) return 5;
  const n = Number(m[2] ?? m[1]);
  const unit = m[3]!.toLowerCase();
  const days = unit.startsWith("week") ? n * 5 : unit.startsWith("month") ? n * 21 : n;
  return Math.max(1, Math.min(MAX_WINDOW_DAYS, Math.round(days)));
}

// ---------------------------------------------------------------------------
// Moves and stats (pure)

export type Move = {
  /** The reaction day, YYYY-MM-DD. */
  reactionDate: string;
  /** The close the move is measured from (the session before the reaction day) and to. */
  fromDate: string;
  toDate: string;
  hitPct: number;
  benchPct: number;
  /** hitPct - benchPct. */
  adjustedPct: number;
};

/**
 * The move over `windowDays` sessions from reaction day `index`: the close
 * before it to the close `windowDays - 1` sessions after it, for the hit and
 * the benchmark, in percent. Null when the window is not complete yet or
 * either has no close on those days (not trading then). Pure.
 */
export function windowMove(
  calendar: readonly string[],
  index: number,
  windowDays: number,
  hit: ReadonlyMap<string, number>,
  bench: ReadonlyMap<string, number>,
): Move | null {
  if (index < 1 || windowDays < 1) return null;
  const fromDate = calendar[index - 1];
  const toDate = calendar[index + windowDays - 1];
  if (!fromDate || !toDate) return null;
  const h0 = hit.get(fromDate);
  const h1 = hit.get(toDate);
  const b0 = bench.get(fromDate);
  const b1 = bench.get(toDate);
  if (!(h0! > 0 && h1! > 0 && b0! > 0 && b1! > 0)) return null;
  const hitPct = (h1! / h0! - 1) * 100;
  const benchPct = (b1! / b0! - 1) * 100;
  return { reactionDate: calendar[index]!, fromDate, toDate, hitPct, benchPct, adjustedPct: hitPct - benchPct };
}

/** Whether a move went the implied way: above 0 for "up", below 0 for "down". Pure. */
export function wentImpliedWay(adjustedPct: number, direction: Exclude<Direction, "unclear">): boolean {
  return direction === "up" ? adjustedPct > 0 : adjustedPct < 0;
}

/**
 * The history line from measured moves: null for an "unclear" hit or fewer
 * than `minSample` moves. avgMovePct keeps the moves' own sign. Pure.
 */
export function summarizeMoves(
  moves: readonly Pick<Move, "adjustedPct">[],
  direction: Direction,
  windowDays: number,
  extra: Pick<RippleHistory, "benchmark" | "from" | "to"> = {},
  minSample = HISTORY_MIN_SAMPLE,
): RippleHistory | null {
  if (direction === "unclear" || moves.length < minSample) return null;
  const sum = moves.reduce((s, m) => s + m.adjustedPct, 0);
  const matched = moves.filter((m) => wentImpliedWay(m.adjustedPct, direction)).length;
  return {
    sample: moves.length,
    avgMovePct: Math.round((sum / moves.length) * 100) / 100,
    hitRate: Math.round((matched / moves.length) * 10_000) / 10_000,
    windowDays,
    ...extra,
  };
}

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T12:00:00Z`) / DAY_MS);

/**
 * The EPS record's quarter for each earnings release: the one dated the
 * release's New York date or a day either side, the nearest first; each
 * quarter used once. The release's sign is the surprise's. Pure.
 */
export function matchQuarters(events: readonly PastEvent[], quarters: readonly ReportedQuarter[]): Array<{ event: PastEvent; quarter: ReportedQuarter | null }> {
  const used = new Set<number>();
  const out: Array<{ event: PastEvent; quarter: ReportedQuarter | null }> = [];
  for (const event of [...events].sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt))) {
    const day = dayNumber(nySession(Date.parse(event.acceptedAt)).date);
    let best = -1;
    for (let i = 0; i < quarters.length; i++) {
      if (used.has(i)) continue;
      const gap = Math.abs(dayNumber(quarters[i]!.date) - day);
      if (gap > 1) continue;
      if (best < 0 || gap < Math.abs(dayNumber(quarters[best]!.date) - day)) best = i;
    }
    if (best >= 0) used.add(best);
    const quarter = best >= 0 ? quarters[best]! : null;
    out.push({ event: { ...event, sign: quarter ? signOf(quarter.surprisePct) : null }, quarter });
  }
  return out;
}

// ---------------------------------------------------------------------------
// One card's history (reads through the injected sources)

export type HitHistory = {
  ticker: string;
  history: RippleHistory | null;
  /** Why it is null, or what it rests on. */
  note: string;
  moves: Move[];
};

export type HistoryDeps = {
  market: MarketData;
  /** The event company's past events of a kind since a date (src/past-events.ts in a run, a fixture in tests). */
  pastEvents: (ticker: string, kind: EventBasis["kind"], sinceYmd: string) => Promise<PastEvent[]>;
  nowMs?: number;
  log?: (line: string) => void;
};

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function closesMap(rows: DailyClose[]): Map<string, number> {
  return new Map(rows.map((r) => [r.date, r.close]));
}

const fmt = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

/** Memo per run: the same company's events and prices are read once. */
export function memoDeps(deps: HistoryDeps): HistoryDeps {
  const events = new Map<string, Promise<PastEvent[]>>();
  const closes = new Map<string, Promise<DailyClose[]>>();
  const eps = new Map<string, Promise<ReportedQuarter[]>>();
  const once = <T>(m: Map<string, Promise<T>>, k: string, f: () => Promise<T>): Promise<T> => {
    if (!m.has(k)) {
      const p = f();
      p.catch(() => m.delete(k));
      m.set(k, p);
    }
    return m.get(k)!;
  };
  return {
    ...deps,
    pastEvents: (t, kind, since) => once(events, `${t}|${kind}|${since}`, () => deps.pastEvents(t, kind, since)),
    market: {
      name: deps.market.name,
      dailyCloses: (t, from, to) => once(closes, `${t}|${from}|${to}`, () => deps.market.dailyCloses(t, from, to)),
      earnings: (t, from, to) => once(eps, `${t}|${from}|${to}`, () => deps.market.earnings(t, from, to)),
    },
  };
}

/**
 * The history of every hit on a card. Throws only when the event's own
 * record (past events, the EPS record, the benchmark) cannot be read; a hit
 * whose prices cannot be read gets null with a note.
 */
export async function cardHistory(card: RippleCard, basis: EventBasis | null, deps: HistoryDeps): Promise<HitHistory[]> {
  const log = deps.log ?? (() => undefined);
  const nullAll = (note: string): HitHistory[] => card.hits.map((h) => ({ ticker: h.ticker, history: null, note, moves: [] }));
  if (!basis) return nullAll("this kind of event has no history yet");
  if (basis.sign === null) return nullAll("the event's own size is not on record, so similar past events cannot be picked");

  const nowMs = deps.nowMs ?? Date.now();
  const eventMs = Date.parse(card.event.occurredAt);
  const since = ymd(eventMs - HISTORY_YEARS * 365.25 * DAY_MS);
  const today = ymd(nowMs);
  const ticker = card.event.ticker;

  let past = (await deps.pastEvents(ticker, basis.kind, since)).filter((e) => Date.parse(e.acceptedAt) < eventMs && !card.event.id.endsWith(e.accession));
  let records = new Map<string, ReportedQuarter | null>();
  if (basis.kind === "earnings") {
    const quarters = await deps.market.earnings(ticker, ymd(Date.parse(`${since}T00:00:00Z`) - 3 * DAY_MS), today);
    const matched = matchQuarters(past, quarters);
    past = matched.map((m) => m.event);
    records = new Map(matched.map((m) => [m.event.accession, m.quarter]));
  }
  const unsigned = past.filter((e) => e.sign === null).length;
  // A monthly report's 6-K can reach EDGAR days after the release (UMC's often
  // does): without the release's own date its reaction day is not known.
  const undated = basis.kind === "monthly_revenue" ? past.filter((e) => e.sign === basis.sign && !e.releasedOn).length : 0;
  const similar = past.filter((e) => e.sign === basis.sign && (basis.kind !== "monthly_revenue" || e.releasedOn));
  const word = basis.kind === "earnings" ? (basis.sign > 0 ? "EPS beats" : basis.sign < 0 ? "EPS misses" : "in-line releases") : basis.sign > 0 ? "revenue rises" : basis.sign < 0 ? "revenue falls" : "flat months";
  log(`  history ${ticker}: ${past.length} past ${basis.kind.replace("_", " ")} events since ${since}, ${similar.length} ${word} like this one${unsigned ? `, ${unsigned} with no figure on record (left out)` : ""}${undated ? `, ${undated} with no release date in the text (left out)` : ""}`);

  const calendarFrom = ymd(Date.parse(`${since}T00:00:00Z`) - 10 * DAY_MS);
  const benchRows = await deps.market.dailyCloses(BENCHMARK, calendarFrom, today);
  if (benchRows.length < 250) throw new Error(`${BENCHMARK} closes unavailable (${benchRows.length} days)`);
  const calendar = benchRows.map((r) => r.date);
  const bench = closesMap(benchRows);
  const at = nySession(eventMs);
  const currentReaction = reactionIndex(calendar, at.date, at.session);
  // The card's own reaction day; a past window must end before it.
  const cutoff = currentReaction === null ? "9999-12-31" : calendar[currentReaction]!;

  const out: HitHistory[] = [];
  for (const hit of card.hits) {
    const windowDays = windowTradingDays(hit.window);
    if (hit.direction === "unclear") {
      out.push({ ticker: hit.ticker, history: null, note: "direction unclear: no implied way to test", moves: [] });
      continue;
    }
    let hitRows: DailyClose[];
    try {
      hitRows = await deps.market.dailyCloses(hit.ticker, calendarFrom, today);
    } catch (err) {
      out.push({ ticker: hit.ticker, history: null, note: `prices unreadable (${err instanceof Error ? err.message : String(err)})`, moves: [] });
      continue;
    }
    const closes = closesMap(hitRows);
    const moves: Move[] = [];
    let unmeasured = 0;
    for (const e of similar) {
      const earlier = e.releasedOn ? { date: e.releasedOn, time: "before_open" as const } : records.get(e.accession);
      const idx = eventReactionIndex(calendar, Date.parse(e.acceptedAt), earlier);
      const move = idx === null ? null : windowMove(calendar, idx, windowDays, closes, bench);
      if (!move || move.toDate >= cutoff) {
        unmeasured++;
        continue;
      }
      moves.push(move);
    }
    moves.sort((a, b) => a.reactionDate.localeCompare(b.reactionDate));
    const extra = moves.length ? { benchmark: BENCHMARK, from: moves[0]!.reactionDate, to: moves[moves.length - 1]!.reactionDate } : {};
    const history = summarizeMoves(moves, hit.direction, windowDays, extra);
    const matched = moves.filter((m) => wentImpliedWay(m.adjustedPct, hit.direction as "up" | "down")).length;
    const avg = moves.length ? moves.reduce((s, m) => s + m.adjustedPct, 0) / moves.length : 0;
    const note = moves.length
      ? `${matched} of ${moves.length} ${hit.direction} vs ${BENCHMARK}, avg ${fmt(avg)}, ${windowDays}d${unmeasured ? ` (${unmeasured} not measurable)` : ""}${history ? "" : `: under ${HISTORY_MIN_SAMPLE}, not shown`}`
      : `no measurable past event${unmeasured ? ` (${unmeasured} without prices)` : ""}`;
    log(`    ${hit.ticker} (${hit.direction}, "${hit.window}"): ${note}`);
    out.push({ ticker: hit.ticker, history, note, moves });
  }
  return out;
}
