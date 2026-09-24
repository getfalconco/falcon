/**
 * Handover briefing: what the report's figures mean for this book.
 *
 * The rest of the report says what happened: futures moved, a held name moved,
 * a release is scheduled. This module turns those same figures into the few
 * conclusions a reader wants first: what the move since the close comes to for
 * the book, which held move is the name's own rather than the market's, which
 * scheduled event the book is most exposed to and how much either way. Each
 * conclusion carries the figures it rests on. None says what to do and none
 * says which way anything goes: a scenario is sized in both directions.
 *
 * Pure and renderer-safe: it imports types and other pure briefing modules
 * (the session calendar leans on `Intl` alone), so the renderer's demo draws
 * its conclusions with this code instead of a copy. The only clock is the
 * report's own `generated_at`.
 *
 * `book_pct` is the size a conclusion stands for, in percent of equity, and it
 * comes on two scales: for the open and a name's own move it is the move
 * itself, and for a standing exposure (an event, the index funds, a dividend, a
 * large position) it is the book's move per 1% of the thing named. The two are
 * not comparable, so the ranking takes the scale first and the size second:
 * without that, an event sensitivity, which is the same figure every morning,
 * outranks the concrete open indication on any morning the futures moved less
 * than 1%, and on a crowded one pushes it off the list entirely.
 */

import { nyYmd, weekdayOf } from "../tracker/calendar.js";
import { expiryEventsBetween } from "./expiry.js";
import type {
  BriefingPhase,
  BriefingReport,
  CalendarItem,
  CorporateEvent,
  HeldCoverage,
  HeldMover,
  Implication,
  ImplicationKind,
  IndexFamily,
  MarketRow,
} from "./types.js";

export type ImplicationInput = Pick<
  BriefingReport,
  | "generated_at"
  | "window"
  | "overnight"
  | "held_coverage"
  | "book"
  | "risk"
  | "earnings_next"
  | "corporate_events"
  | "calendar_today"
> & {
  /**
   * Headlines per held name since the last US close, by upper-case ticker,
   * counted before `overnight.held_news` was cut to its display cap. Optional:
   * a caller that cannot supply it gets wording scoped to what the report
   * lists, never a claim about what the night held (see `newsClause`).
   */
  news_counts?: Record<string, number>;
};

export type ImplicationPosition = { ticker: string; market_value: number };

/** The contract's cap: past five, the list is the table again. */
export const MAX_IMPLICATIONS = 5;

const MAX_NAME_SPECIFIC = 2;
const MAX_EARNINGS = 2;

/** The index the book is sized against: the S&P 500 contract, which trades through the night. */
const INDEX_SYMBOL = "ES=F";

/**
 * Below this, in percent of the book, the open reads as "little change". A
 * figure like "a rise of about 0.04%" is inside a single tick of the futures
 * and would lead the report with noise.
 */
const LITTLE_CHANGE_PCT = 0.1;

/**
 * The held names' own quotes are mentioned beside the futures only when they
 * part by this many percentage points. Pre-market prints are thin, so a
 * smaller gap is as likely to be a stale quote as a real difference.
 */
const QUOTE_GAP_PTS = 0.5;

/**
 * A residual below 1% is inside what beta estimates get wrong on any quiet
 * night; calling that "its own" would find a story in estimation error. A
 * volatile name has to clear its own normal day as well, since a 1.5% residual
 * on a name that moves 3% a day is an ordinary night for it.
 */
const MIN_RESIDUAL_PCT = 1;

/** Without a market move to take out, a name's move counts as out of the ordinary at this many normal days. */
const FALLBACK_Z = 1.5;

/** Held names under 1% of the book: their own story moves the book by basis points, so it does not lead it. */
const MIN_NAME_WEIGHT = 0.01;

/** Earnings on a name under 3% of the book: even a large report-day move is a rounding error on the book. */
const MIN_EARNINGS_WEIGHT = 0.03;

/** One trading week: far enough to see a report coming, near enough that it belongs in a morning handover. */
const EARNINGS_SESSIONS = 5;
const REBALANCE_SESSIONS = 5;

/** One position at a quarter of the invested book is where its move alone is a large share of the book's. */
const CONCENTRATION_SHARE = 0.25;

/**
 * Names without a beta count as zero in the summed book beta, so a book mostly
 * without betas would read as barely moving with the market. Past half the
 * invested book the sum is a fair estimate; short of it the report says the
 * figure is missing instead of printing an understated one.
 */
const BETA_COVERAGE = 0.5;

/**
 * A book this close to market-neutral is not swung by a release through the
 * index; "a 1% index move is about 0.04% of the book" would rank a non-event.
 */
const MIN_EVENT_BETA = 0.1;

/**
 * A position with no quote is carried at what it cost (see `valuePosition`),
 * which can be years old. Under a tenth of the invested book that moves the
 * weights by less than the arithmetic's own precision; past it, every
 * conclusion sized on a weight rests on a basis rather than on a price, and
 * the report says so.
 */
const MIN_UNPRICED_SHARE = 0.1;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Ties in the ranking fall to this order, so the same figures always give the same list. */
const KIND_ORDER: Record<ImplicationKind, number> = {
  data_gap: 0,
  open_indication: 1,
  name_specific: 2,
  event_sensitivity: 3,
  earnings_exposure: 4,
  index_flow: 5,
  ex_dividend: 6,
  concentration: 7,
};

/** How the families read in a sentence; `INDEX_FAMILY_LABEL` is a table label ("S&P 500 family"). */
const FAMILY_WORDS: Record<IndexFamily, string> = {
  sp: "S&P",
  nasdaq100: "Nasdaq-100",
  russell: "Russell",
  msci: "MSCI",
};
const FAMILY_ORDER: readonly IndexFamily[] = ["sp", "nasdaq100", "russell", "msci"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Arrays from another process (the demo builds its report in the renderer) are not trusted to be arrays. */
function list<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * A symbol as it may appear in a sentence. The contract keeps "$" out of every
 * sentence, and a ticker is the one piece of text here that arrives from a
 * user's typing, so anything outside a symbol's shape is dropped.
 */
function symbol(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, "") : "";
}

/**
 * A label or title written by another module. Those are held to the same copy
 * rules where they are written (the calendar validator refuses a title that
 * breaks them); this only guarantees the two properties the contract states
 * outright, no "$" and no long dash, whoever wrote the text.
 */
function plain(text: unknown): string {
  return typeof text === "string"
    ? text
        .replace(/\$/g, "")
        .replace(/[\u2012-\u2015]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

/** A figure the report already carries, quoted as given: at most two decimals, no trailing zeros. */
function given(value: number): string {
  return String(roundTo(Math.abs(value), 2));
}

/**
 * A figure derived here: two significant digits, never more than two
 * decimals. "About 1.3%" is what the arithmetic supports; "1.3024%" would claim
 * a precision that a beta estimate times a futures print does not have.
 */
function about(value: number): string {
  const size = Math.abs(value);
  const decimals = size >= 10 ? 0 : size >= 1 ? 1 : 2;
  return String(roundTo(size, decimals));
}

/** "about 0.92%", or "under 0.01%" where two decimals would print a zero. */
function aboutPct(value: number): string {
  const text = about(value);
  return text === "0" ? "under 0.01%" : `about ${text}%`;
}

function moveWords(move: number): string {
  const size = given(move);
  if (size === "0") return "flat";
  return `${move > 0 ? "up" : "down"} ${size}%`;
}

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** "Thursday, September 24", or the raw date when it cannot be read. */
function dayAndDate(ymd: string): string {
  if (!YMD.test(ymd)) return plain(ymd);
  const month = MONTHS[Number(ymd.slice(5, 7)) - 1];
  const weekday = WEEKDAYS[weekdayOf(ymd)];
  return month && weekday ? `${weekday}, ${month} ${Number(ymd.slice(8, 10))}` : ymd;
}

/**
 * The target session, as a sentence names it.
 *
 * The phase alone cannot decide this. The window opens at 20:00 ET on the
 * calendar day BEFORE the target, so from 20:00 to midnight the phase is
 * already `pre_open` while the date is still yesterday's, and that slice is
 * exactly when the panel shows itself. Saying "today" there names Sunday when
 * it means Monday, and the corporate rail beside these sentences, which
 * compares the event's date with New York's, would be saying "Monday" at the
 * same moment. So the word comes from the two dates, as it does there.
 */
function sessionWords(ctx: Context): { day: string; possessive: string } {
  const target = ctx.input.window.target_session_ymd;
  if (ctx.phase !== "between_sessions" && ctx.todayYmd !== null && ctx.todayYmd === target) {
    return { day: "today", possessive: "today's" };
  }
  const weekday = ctx.phase === "between_sessions" || !YMD.test(target) ? null : WEEKDAYS[weekdayOf(target)];
  return weekday
    ? { day: `on ${weekday}`, possessive: `${weekday}'s` }
    : { day: "in the next session", possessive: "the next session's" };
}

function betaClause(beta: number): string {
  return beta < 0
    ? `the book moves about ${given(beta)}% the other way for each 1% the index moves`
    : `the book moves about ${given(beta)}% for each 1% the index moves`;
}

// ---------------------------------------------------------------------------
// What every rule reads
// ---------------------------------------------------------------------------

type Context = {
  input: ImplicationInput;
  phase: BriefingPhase;
  equity: number;
  /** Signed market value by upper-case ticker. */
  values: Map<string, number>;
  /** Signed share of equity by upper-case ticker. */
  weights: Map<string, number>;
  index: { row: MarketRow; move: number } | null;
  beta: number | null;
  /** Share of the invested book whose names carry a beta in this report. */
  betaCoverage: number;
  /** Held names carried at their cost basis because no price was found. */
  unpriced: string[];
  /** Held names the book's overnight P&L leaves out, so it covers less than the equity it is expressed over. */
  pnlExcluded: string[];
  nowMs: number;
  /** New York's calendar date at `generated_at`, or null when the clock cannot be read. */
  todayYmd: string | null;
};

/** The index move the book is sized against, when there is one since the close. */
function indexMove(markets: MarketRow[]): { row: MarketRow; move: number } | null {
  const row = markets.find((r) => r && r.symbol === INDEX_SYMBOL);
  if (!row || (row.state !== "live" && row.state !== "final") || row.unit !== "pct") return null;
  const move = finite(row.move);
  return move === null ? null : { row, move };
}

/**
 * The book's beta, and the share of the invested book that figure is known for.
 *
 * The coverage is always the held names' own betas, whichever path supplies the
 * beta itself. The risk engine fills in 1.0 for every name it has no beta for
 * (`resolveBetas` in risk/components.ts) and records the substitution only in
 * its own degraded list, which the briefing never receives; taking its figure
 * as covered would publish a placeholder as a measurement and leave `betaGap`
 * unable to fire for a book of names the chain does not follow yet.
 *
 * The figure itself is the risk engine's when its snapshot is of this book,
 * since that engine nets borrowed positions the way the risk card does. It is
 * built from `beta_port`, not `beta_eff`: `beta_eff` is an absolute value
 * (risk/types.ts: "absolute value, shorts reduce it") already multiplied by the
 * invested fraction the SNAPSHOT saw, so it points a net-short book the wrong
 * way and sizes the book the reader held when the snapshot was computed.
 * `beta_port` is signed and carries no cash, so this request's own invested
 * fraction is what turns it into a beta on equity.
 */
function bookBeta(input: ImplicationInput, values: Map<string, number>, equity: number): { beta: number | null; coverage: number } {
  const invested = finite(input.book?.invested_usd);
  if (invested === null || invested <= 0) return { beta: null, coverage: 0 };

  let covered = 0;
  let sum = 0;
  const seen = new Set<string>();
  for (const mover of list(input.overnight.held_movers)) {
    const ticker = symbol(mover?.ticker);
    const beta = finite(mover?.beta);
    const value = values.get(ticker);
    if (seen.has(ticker) || beta === null || value === undefined) continue;
    seen.add(ticker);
    covered += Math.abs(value);
    sum += (value / equity) * beta;
  }
  const coverage = covered / invested;
  if (coverage < BETA_COVERAGE) return { beta: null, coverage };

  const risk = input.risk;
  const port = finite(risk?.beta_port);
  // The engine keeps one risk account; its figures describe this book only when
  // it says so. A zero is read as an unset field rather than as a neutral book.
  if (risk && risk.matches_book === true && port !== null && port !== 0) {
    return { beta: port * (invested / equity), coverage };
  }
  return { beta: sum, coverage };
}

function context(input: ImplicationInput, positions: ImplicationPosition[]): Context | null {
  const equity = finite(input.book?.equity_usd);
  // Weights against a wiped-out or negative equity are sign-flipped or
  // infinite; no conclusion sized on them would be true.
  if (equity === null || equity <= 0) return null;

  const values = new Map<string, number>();
  for (const p of list(positions)) {
    const ticker = symbol(p?.ticker);
    const value = finite(p?.market_value);
    if (ticker === "" || value === null || value === 0) continue;
    values.set(ticker, (values.get(ticker) ?? 0) + value);
  }
  // Two rows of one symbol can net to nothing; a zero weight left in the map
  // would read as a held name, and its sign as neither bought nor borrowed.
  for (const [ticker, value] of values) if (value === 0) values.delete(ticker);
  // No book, nothing to conclude about it: the markets table speaks for itself.
  if (values.size === 0) return null;

  const weights = new Map([...values].map(([ticker, value]) => [ticker, value / equity]));
  const { beta, coverage } = bookBeta(input, values, equity);
  const nowMs = Date.parse(input.generated_at);
  return {
    input,
    phase: input.window.phase,
    equity,
    values,
    weights,
    index: indexMove(list(input.overnight.markets)),
    beta,
    betaCoverage: coverage,
    // Named by the book, which values every position, rather than by the
    // movers, which only list the names that had a usable quote.
    unpriced: [...new Set(list(input.book?.unpriced).map(symbol).filter((t) => values.has(t)))],
    pnlExcluded: [...new Set(list(input.book?.pnl_excluded).map(symbol).filter((t) => values.has(t)))],
    nowMs,
    todayYmd: Number.isFinite(nowMs) ? nyYmd(new Date(nowMs)) : null,
  };
}

function implication(
  kind: ImplicationKind,
  subject: string,
  text: { headline: string; because: string; scenario?: string | null },
  sizes: { scenario_usd?: number | null; book_pct: number | null },
  tickers: string[] = [],
): Implication {
  const usd = sizes.scenario_usd ?? null;
  return {
    id: `${kind}:${subject}`,
    kind,
    headline: text.headline,
    because: text.because,
    scenario: text.scenario ?? null,
    scenario_usd: usd === null || !Number.isFinite(usd) ? null : roundTo(Math.abs(usd), 2),
    book_pct: sizes.book_pct === null || !Number.isFinite(sizes.book_pct) ? null : roundTo(sizes.book_pct, 2),
    tickers,
  };
}

// ---------------------------------------------------------------------------
// open_indication
// ---------------------------------------------------------------------------

function openIndication(ctx: Context): Implication | null {
  if (ctx.index === null || ctx.beta === null) return null;
  const { row, move } = ctx.index;
  const implied = move * ctx.beta;
  const direction = implied > 0 ? "rise" : "drop";
  const small = Math.abs(implied) < LITTLE_CHANGE_PCT;
  const inSession = ctx.phase === "in_session";

  // During the session the futures move since the settle already happened in
  // the book, so the same product reads as the market's part of the book's day
  // rather than as where the book opens.
  const headline = inSession
    ? small
      ? "The market's move since the close accounts for little change in the book."
      : `The market's move since the close accounts for a ${direction} of about ${about(implied)}% in the book.`
    : small
      ? "Overnight futures point to little change for the book at the open."
      : `Overnight futures point to a ${direction} of about ${about(implied)}% for the book at the open.`;

  let because = `${plain(row.label) || "S&P 500 futures"} are ${moveWords(move)} since the close, and ${betaClause(ctx.beta)}`;
  const quoted = finite(ctx.input.book.overnight_pnl_pct);
  // The book's overnight figure is expressed over the whole of equity while it
  // is set as soon as ONE position priced, so on a degraded quote fetch it can
  // rest on a corner of the book. Comparing that with the futures and calling
  // the book ahead or behind would state a divergence for the whole book from
  // evidence about a fraction of it, so the clause waits for a full book: every
  // position priced, and every one of them inside the P&L (a name with a split
  // in the window is valued and left out of the figure, so it thins the same
  // comparison without ever appearing in `unpriced`).
  const partial = ctx.unpriced.length > 0 || ctx.pnlExcluded.length > 0;
  if (!partial && quoted !== null && Math.abs(quoted - implied) >= QUOTE_GAP_PTS) {
    const versus = inSession ? "the market's share" : "what the futures imply";
    because += `; the held names' own quotes put the book ${moveWords(quoted)} so far, ${quoted > implied ? "ahead of" : "behind"} ${versus}`;
  }

  return implication("open_indication", "book", { headline, because: `${because}.` }, { book_pct: implied });
}

// ---------------------------------------------------------------------------
// name_specific
// ---------------------------------------------------------------------------

function coverageOf(ctx: Context, ticker: string): HeldCoverage | null {
  const row = list(ctx.input.held_coverage).find((c) => symbol(c?.ticker) === ticker);
  return row ? row.coverage : null;
}

/**
 * Headlines on the name in the report's own list, counting the ones it shares
 * with another held name. An item whose timestamp cannot be read is counted:
 * it is a headline the report carries, whatever its date says.
 */
function headlinesListed(ctx: Context, ticker: string): number {
  const since = Date.parse(ctx.input.window.overnight_since);
  let count = 0;
  for (const item of list(ctx.input.overnight.held_news)) {
    const names = [item?.ticker, ...list(item?.also)].map(symbol);
    const at = Date.parse(item?.published_at);
    if (!names.includes(ticker)) continue;
    if (Number.isFinite(at) && Number.isFinite(since) && at < since) continue;
    count += 1;
  }
  return count;
}

/**
 * What the report can say about the cause.
 *
 * Two absences are not a quiet night and are never worded as one. A name the
 * chain does not follow for news has an empty list whatever happened. And the
 * list the report prints is capped across the whole book, so on a busy morning
 * a tracked name's own headlines can be cut by items about other names: the
 * only claim the printed list supports by itself is one about the report.
 * `news_counts`, taken before that cap, is what lets the stronger sentence be
 * said at all.
 */
function newsClause(ctx: Context, ticker: string): string {
  const coverage = coverageOf(ctx, ticker);
  if (coverage === "price_only") return `${ticker} is followed for prices only, so the cause is not in this report`;
  if (coverage !== "tracked") return `${ticker} has no news coverage yet, so the cause is not in this report`;

  const listed = headlinesListed(ctx, ticker);
  if (listed > 0) return `the report lists ${listed} ${listed === 1 ? "headline" : "headlines"} on ${ticker} since the close`;

  const counts = ctx.input.news_counts;
  const raw = counts && typeof counts === "object" ? finite(counts[ticker]) : null;
  if (raw === null) return `no headline on ${ticker} in this report accounts for it`;
  const total = Math.max(0, Math.round(raw));
  return total > 0
    ? `${total} ${total === 1 ? "headline" : "headlines"} on ${ticker} came out since the close, none of them in this report`
    : `no headline on ${ticker} since the close accounts for it`;
}

function nameSpecific(ctx: Context): Implication[] {
  const found: Implication[] = [];
  // The engine lists each name once; a list built elsewhere (the demo) may
  // not, and two lines about one name would repeat an id the panel keys on.
  const seen = new Set<string>();
  for (const mover of list(ctx.input.overnight.held_movers)) {
    const ticker = symbol(mover?.ticker);
    const weight = ctx.weights.get(ticker);
    const move = finite(mover?.move_pct);
    // A flagged move is a split or a print too large to trust; a conclusion
    // drawn from it would present a bookkeeping artefact as the name's story.
    if (!mover || mover.flag !== null || ticker === "" || weight === undefined || move === null || seen.has(ticker)) continue;
    if (Math.abs(weight) < MIN_NAME_WEIGHT) continue;
    seen.add(ticker);

    const beta = finite(mover.beta);
    const made = ctx.index !== null && beta !== null ? residualMove(ctx, mover, ticker, move, beta, weight) : sizeMove(ctx, mover, ticker, move, weight);
    if (made) found.push(made);
  }
  return found
    .sort((a, b) => Math.abs(b.book_pct ?? 0) - Math.abs(a.book_pct ?? 0) || byText(a.id, b.id))
    .slice(0, MAX_NAME_SPECIFIC);
}

/** The market's part taken out through the name's beta; what is left is the name's own. */
function residualMove(ctx: Context, mover: HeldMover, ticker: string, move: number, beta: number, weight: number): Implication | null {
  const explained = beta * ctx.index!.move;
  const residual = move - explained;
  const vol = finite(mover.daily_vol_pct);
  if (Math.abs(residual) < Math.max(MIN_RESIDUAL_PCT, vol ?? MIN_RESIDUAL_PCT)) return null;

  const news = newsClause(ctx, ticker);
  // "Its own" is said only when at least half of the move is: a 3% drop of
  // which the market explains 2% is mostly the market's, and the sentence then
  // names the part that is left over instead.
  const mostlyOwn = move !== 0 && Math.sign(residual) === Math.sign(move) && Math.abs(residual) >= Math.abs(explained);

  let headline: string;
  let because: string;
  if (mostlyOwn) {
    headline = `${ticker}'s ${given(move)}% ${move > 0 ? "rise" : "drop"} is its own, not the market's.`;
    const market =
      Math.abs(explained) < 0.05
        ? "The market explains almost none of it"
        : Math.sign(explained) === Math.sign(move)
          ? `The market explains about ${about(explained)}% of it`
          : `The market alone points to a ${explained > 0 ? "rise" : "drop"} of about ${about(explained)}% for it`;
    because = `${market}, and ${news}.`;
  } else {
    headline =
      residual < 0
        ? `${ticker} trails what the market explains for it by about ${about(residual)}%.`
        : `${ticker} runs about ${about(residual)}% ahead of what the market explains for it.`;
    because = `It is ${moveWords(move)} since the close, against a ${explained > 0 ? "rise" : "drop"} of about ${about(explained)}% from the market alone, and ${news}.`;
  }
  return implication("name_specific", ticker, { headline, because }, { book_pct: residual * weight }, [ticker]);
}

/**
 * No market part can be taken out (no futures move, or no beta for the name),
 * so the move is measured against the name's own normal day instead.
 */
function sizeMove(ctx: Context, mover: HeldMover, ticker: string, move: number, weight: number): Implication | null {
  const z = finite(mover.move_z);
  const vol = finite(mover.daily_vol_pct);
  if (z === null || vol === null || Math.abs(z) < FALLBACK_Z || move === 0) return null;
  const why = ctx.index === null ? "futures carry no move to compare it with" : "no beta is known to take the market's part out";
  return implication(
    "name_specific",
    ticker,
    {
      headline: `${ticker}'s ${given(move)}% ${move > 0 ? "rise" : "drop"} is about ${given(z)} times its normal day.`,
      because: `Its normal daily move is ${given(vol)}% and ${why}; ${newsClause(ctx, ticker)}.`,
    },
    { book_pct: move * weight },
    [ticker],
  );
}

// ---------------------------------------------------------------------------
// event_sensitivity
// ---------------------------------------------------------------------------

function eventSensitivity(ctx: Context): Implication | null {
  if (ctx.beta === null || Math.abs(ctx.beta) < MIN_EVENT_BETA || !Number.isFinite(ctx.nowMs)) return null;
  const ahead = list(ctx.input.calendar_today)
    .filter(
      (item): item is CalendarItem & { at: string } =>
        !!item &&
        (item.kind === "fomc" || item.kind === "data") &&
        item.importance === 3 &&
        typeof item.at === "string" &&
        Date.parse(item.at) > ctx.nowMs,
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || byText(a.id, b.id));
  const first = ahead[0];
  if (!first) return null;

  const title = plain(first.title) || "A major release";
  const clock = typeof first.time_et === "string" && /^\d{2}:\d{2}$/.test(first.time_et) ? ` at ${first.time_et} ET` : "";
  // Named as the first release ahead, never as the session's largest swing
  // factor. The comparison above is deliberately narrow, timed macro releases
  // only, while a held name's report is written into the same calendar as an
  // importance-3 item of another kind and is sized elsewhere in this list,
  // often larger: a superlative here would contradict a line ranked above it.
  // The size the book carries into it is the sensitivity below, not a rank.
  const headline =
    ahead.length === 1
      ? `${title}${clock} is the first top-tier release ahead this session.`
      : `${title}${clock} is the first of this session's ${ahead.length} top-tier releases.`;

  const at = Date.parse(first.at);
  const open = Date.parse(ctx.input.window.target_open_at);
  const close = Date.parse(ctx.input.window.target_close_at);
  const verb = first.kind === "fomc" ? "lands" : "prints";
  const when = !Number.isFinite(open) || !Number.isFinite(close)
    ? `It ${verb} this session`
    : at < open
      ? `It ${verb} before the open`
      : at < close
        ? `It ${verb} mid-session`
        : `It ${verb} after the close`;

  const size = Math.abs(ctx.beta);
  return implication(
    "event_sensitivity",
    first.id,
    {
      headline,
      because: `${when}, and ${betaClause(ctx.beta)}.`,
      scenario: `A 1% index move either way is about ${given(size)}% of the book.`,
    },
    { scenario_usd: size * 0.01 * ctx.equity, book_pct: size },
  );
}

// ---------------------------------------------------------------------------
// earnings_exposure
// ---------------------------------------------------------------------------

function earningsExposure(ctx: Context): Implication[] {
  const vols = new Map(list(ctx.input.overnight.held_movers).map((m) => [symbol(m?.ticker), finite(m?.daily_vol_pct)]));
  const found: Array<{ made: Implication; sessions: number }> = [];

  // Nearest first, so a name listed twice is spoken of by its next report only.
  const seen = new Set<string>();
  const upcoming = list(ctx.input.earnings_next)
    .filter((e) => !!e)
    .sort((a, b) => (finite(a.sessions_until) ?? Infinity) - (finite(b.sessions_until) ?? Infinity));
  for (const e of upcoming) {
    const ticker = symbol(e.ticker);
    const weight = ctx.weights.get(ticker);
    const sessions = finite(e.sessions_until);
    if (weight === undefined || sessions === null || sessions < 0 || sessions > EARNINGS_SESSIONS || seen.has(ticker)) continue;
    if (Math.abs(weight) < MIN_EARNINGS_WEIGHT) continue;
    const bmo = e.timing === "bmo";
    // A report released before this session's open is already in the price
    // while the session trades; the name's own move speaks for it by then.
    if (sessions === 0 && bmo && ctx.phase === "in_session") continue;
    seen.add(ticker);

    const share = `${about(weight * 100)}% of the book`;
    // `words.day` carries the day the sentence means: "today" only when New
    // York's date is the target session's, and the session's own weekday in the
    // evening slice before midnight, when the phase is already pre_open.
    const words = sessionWords(ctx);
    const due =
      sessions === 0
        ? ctx.phase === "between_sessions"
          ? bmo
            ? "reports before the next open"
            : "reports after the next session's close, or at an hour not yet announced,"
          : bmo
            ? `reports ${words.day} before the open`
            : `reports ${words.day} after the close, or at an hour not yet announced,`
        : `reports in ${sessions} ${sessions === 1 ? "session" : "sessions"}`;
    const headline = `${ticker} ${due} and is ${share}.`;

    const timing = bmo ? "before the open" : "after the close or at an hour not yet announced";
    const unconfirmed = e.confirmed === true ? "" : ", on a date the company has not confirmed";
    const vol = vols.get(ticker) ?? null;
    const date = `The report is due ${dayAndDate(String(e.due_ymd))}, ${timing}${unconfirmed}`;
    const because = vol === null ? `${date}.` : `${date}; its normal daily move is ${given(vol)}%.`;

    // "Twice its normal day" on purpose, and never "its usual earnings move":
    // the report carries no history of this name's report-day moves, so a
    // figure presented as one would be invented. Two normal days is a
    // yardstick the reader can check against the volatility beside it.
    const scenarioPct = vol === null ? null : 2 * vol * Math.abs(weight);
    const made = implication(
      "earnings_exposure",
      ticker,
      {
        headline,
        because,
        scenario:
          vol === null || scenarioPct === null
            ? null
            : `A move of twice its normal day (${about(2 * vol)}%) either way is ${aboutPct(scenarioPct)} of the book.`,
      },
      {
        // A dollar size for a position carried at its cost basis would put a
        // confident figure on a value nobody has priced, so it is withheld;
        // the percentages beside it are the report's own weights either way.
        scenario_usd: vol === null || ctx.unpriced.includes(ticker) ? null : ((2 * vol) / 100) * Math.abs(ctx.values.get(ticker) ?? 0),
        // Without a volatility there is no scenario to size, so the name is
        // ranked by its move per 1%, the same unit as a standing exposure.
        book_pct: scenarioPct ?? Math.abs(weight),
      },
      [ticker],
    );
    found.push({ made, sessions });
  }

  return found
    .sort((a, b) => Math.abs(b.made.book_pct ?? 0) - Math.abs(a.made.book_pct ?? 0) || a.sessions - b.sessions || byText(a.made.id, b.made.id))
    .slice(0, MAX_EARNINGS)
    .map((f) => f.made);
}

// ---------------------------------------------------------------------------
// index_flow
// ---------------------------------------------------------------------------

function isQuarterlyExpiry(ymd: string): boolean {
  try {
    return expiryEventsBetween(ymd, ymd).some((e) => e.kind === "quarterly_expiry");
  } catch {
    // A date the rule cannot read gets no expiry clause rather than a wrong one.
    return false;
  }
}

function indexFlow(ctx: Context): Implication | null {
  const heldFunds = (e: CorporateEvent): string[] => list(e.affects_held).map(symbol).filter((t) => t !== "" && ctx.weights.has(t));
  const due = list(ctx.input.corporate_events).filter((e): e is CorporateEvent => {
    const sessions = finite(e?.sessions_until);
    return (
      !!e &&
      e.kind === "rebalance" &&
      // Checked before the nearest date is chosen, so an event that names no
      // position in this book cannot hide a later one that does.
      heldFunds(e).length > 0 &&
      typeof e.date === "string" &&
      YMD.test(e.date) &&
      sessions !== null &&
      sessions >= 0 &&
      sessions <= REBALANCE_SESSIONS
    );
  });
  if (due.length === 0) return null;

  // One line for the nearest close: the S&P and Nasdaq-100 quarterly dates are
  // the same session, and two lines about one closing auction repeat it.
  const date = due.map((e) => e.date).sort(byText)[0]!;
  const events = due.filter((e) => e.date === date);
  const funds = [...new Set(events.flatMap(heldFunds))];

  const families = FAMILY_ORDER.filter((f) => events.some((e) => e.index === f));
  const titles = events.map((e) => plain(e.title).toLowerCase());
  const what = titles.every((t) => t.includes("quarterly"))
    ? "quarterly index rebalance"
    : titles.every((t) => t.includes("reconstitution"))
      ? "index reconstitution"
      : "index rebalance";
  const sessions = finite(events[0]!.sessions_until) ?? 0;
  const when = sessions === 0 ? `at ${sessionWords(ctx).possessive} close` : `at the close on ${dayAndDate(date)}`;
  const trackers =
    families.length === 0
      ? "the index"
      : `the ${listOf(families.map((f) => FAMILY_WORDS[f]))} ${families.length === 1 && families[0] === "nasdaq100" ? "index" : "indices"}`;
  const expiry = isQuarterlyExpiry(date) ? ", the same close as the quarterly options and futures expiry" : "";

  return implication(
    "index_flow",
    date,
    {
      headline: `${listOf(funds)} ${funds.length === 1 ? "trades" : "trade"} into the ${what} ${when}.`,
      because: `Funds that track ${trackers} adjust to their new weights at that close${expiry}.`,
    },
    { book_pct: funds.reduce((sum, t) => sum + Math.abs(ctx.weights.get(t) ?? 0), 0) },
    funds,
  );
}

// ---------------------------------------------------------------------------
// ex_dividend
// ---------------------------------------------------------------------------

function exDividend(ctx: Context): Implication[] {
  const target = ctx.input.window.target_session_ymd;
  const words = sessionWords(ctx);
  const out: Implication[] = [];
  const seen = new Set<string>();
  for (const e of list(ctx.input.corporate_events)) {
    if (!e || e.kind !== "dividend" || e.date !== target) continue;
    const ticker = symbol(e.ticker ?? list(e.affects_held)[0]);
    const weight = ctx.weights.get(ticker);
    if (ticker === "" || weight === undefined || seen.has(ticker)) continue;
    seen.add(ticker);

    const headline =
      ctx.phase === "in_session"
        ? `${ticker} went ex-dividend today, so its price started lower by the dividend.`
        : `${ticker} opens ex-dividend ${words.day}, so its price starts lower by the dividend.`;
    // A borrowed position owes the payment rather than receiving it.
    const who = weight > 0 ? "holders of record receive it" : "a borrowed position pays it to the lender";
    out.push(
      implication(
        "ex_dividend",
        ticker,
        { headline, because: `That drop is the dividend leaving the share price, not a market move; ${who}.` },
        // Per 1% of the price paid out. A quarterly payment is rarely more
        // than that, so this ranks the line near the bottom, where a drop the
        // reader gets back in cash belongs.
        { book_pct: Math.abs(weight) },
        [ticker],
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// concentration
// ---------------------------------------------------------------------------

const FRACTIONS: ReadonlyArray<[number, string]> = [
  [1 / 4, "a quarter"],
  [1 / 3, "a third"],
  [2 / 5, "two fifths"],
  [1 / 2, "half"],
  [3 / 5, "three fifths"],
  [2 / 3, "two thirds"],
  [3 / 4, "three quarters"],
  [4 / 5, "four fifths"],
  [9 / 10, "nine tenths"],
];

function fractionWords(share: number): string {
  if (share >= 0.95) return "nearly all";
  let best = FRACTIONS[0]!;
  for (const f of FRACTIONS) if (Math.abs(f[0] - share) < Math.abs(best[0] - share)) best = f;
  return `about ${best[1]}`;
}

function concentration(ctx: Context): Implication | null {
  const weights = list(ctx.input.book.top_weights)
    .map((w) => ({ ticker: symbol(w?.ticker), share: finite(w?.weight) }))
    .filter((w): w is { ticker: string; share: number } => w.ticker !== "" && w.share !== null)
    .sort((a, b) => b.share - a.share || byText(a.ticker, b.ticker));
  const top = weights[0];
  if (!top || top.share < CONCENTRATION_SHARE) return null;
  // A share computed from one position's cost basis against a book of market
  // values is not a share of anything; the gap line names the name instead.
  if (ctx.unpriced.includes(top.ticker)) return null;

  const next = weights[1];
  const whole = top.share >= 0.995;
  return implication(
    "concentration",
    top.ticker,
    {
      headline: whole
        ? `${top.ticker} is the whole invested book, so its move alone sets the book's.`
        : `${top.ticker} is ${about(top.share * 100)}% of the invested book, so its move alone sets ${fractionWords(top.share)} of the book's.`,
      because: next
        ? `The next largest position, ${next.ticker}, is ${about(next.share * 100)}% of it.`
        : "It is the only position.",
    },
    // `top_weights` is a share of the gross invested book; the ranking unit is
    // equity, so the position's own equity weight sizes it.
    { book_pct: Math.abs(ctx.weights.get(top.ticker) ?? top.share) },
    [top.ticker],
  );
}

// ---------------------------------------------------------------------------
// data_gap
// ---------------------------------------------------------------------------

function futuresGap(ctx: Context): Implication | null {
  // Only before the open: that is when the open is what the reader is asking
  // about. Between sessions the futures have hours still to print.
  if (ctx.phase !== "pre_open" || ctx.index !== null) return null;
  const futures = list(ctx.input.overnight.markets).filter((r) => r && r.group === "us_futures");
  const es = futures.find((r) => r.symbol === INDEX_SYMBOL);

  let headline: string;
  let because: string;
  if (futures.every((r) => r.state === "unavailable")) {
    // A failed feed says nothing about whether futures printed; the sentence
    // does not claim they did not.
    headline = "US futures could not be read for this report, so the open cannot be sized from them.";
    because = "The futures feed did not answer when this report was built.";
  } else if (futures.every((r) => r.state === "stale" || r.state === "unavailable")) {
    headline = "US futures have not printed since the close, so the open cannot be sized from them.";
    because = "Their latest prints are from before the last US close.";
  } else {
    const label = plain(es?.label) || "S&P 500 futures";
    headline = `${label} carry no move since the close, so the open cannot be sized from them.`;
    because = "Other US futures have printed, but the contract the book is sized against has no usable move.";
  }
  return implication("data_gap", "futures", { headline, because }, { book_pct: null });
}

/**
 * Every weight here comes from the book, and the book carries a position no
 * quote could be found for at what it cost (`valuePosition`). That basis is as
 * old as the position, so past a tenth of the invested book the weights, the
 * shares and the scenarios under them are cost-based figures presented as
 * current ones. Nothing else in the report says so: `unpriced` is listed in the
 * book section, which a reader meets after these conclusions.
 */
function unpricedGap(ctx: Context): Implication | null {
  if (ctx.unpriced.length === 0) return null;
  const invested = finite(ctx.input.book?.invested_usd);
  if (invested === null || invested <= 0) return null;

  const carried = ctx.unpriced.reduce((sum, ticker) => sum + Math.abs(ctx.values.get(ticker) ?? 0), 0);
  const share = (carried / invested) * 100;
  if (share < MIN_UNPRICED_SHARE * 100) return null;

  const many = ctx.unpriced.length > 1;
  return implication(
    "data_gap",
    "unpriced",
    {
      headline: `No price was found for ${listOf(ctx.unpriced)}, so the weights under these conclusions rest on what ${many ? "they" : "it"} cost.`,
      because: `${aboutPct(share)} of the invested book is carried at its cost basis in this report, which is as old as the ${many ? "positions" : "position"}.`,
    },
    { book_pct: null },
    ctx.unpriced,
  );
}

function betaGap(ctx: Context): Implication | null {
  if (ctx.beta !== null) return null;
  const share = ctx.betaCoverage * 100;
  return implication(
    "data_gap",
    "beta",
    {
      headline: "Beta is missing for most of the book, so the market's effect on it cannot be sized.",
      because:
        about(share) === "0"
          ? "No held name carries a beta in this report."
          : `Beta is known for names making up ${about(share)}% of the invested book, under the half this needs.`,
    },
    { book_pct: null },
  );
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The scale a conclusion's `book_pct` is on (see the file header). */
const MOVE = 0;
const PER_ONE_PERCENT = 1;

function scaleOf(made: Implication): number {
  switch (made.kind) {
    case "open_indication":
    case "name_specific":
      return MOVE;
    case "earnings_exposure":
      // With the name's volatility the figure is the scenario's own size, a
      // move; without one the line falls back to the name's weight instead.
      return made.scenario === null ? PER_ONE_PERCENT : MOVE;
    default:
      return PER_ONE_PERCENT;
  }
}

/**
 * The report's conclusions, most consequential first, at most five.
 *
 * A data gap goes first, always: a reader who is not told that an input is
 * missing reads every conclusion under it as if it were not. The rest rank by
 * scale and then by the size of `book_pct`, with no size last. Scale before
 * size because an expected move and a move per 1% are different questions, and
 * ranking them as one number buries what the book does at the open behind a
 * standing sensitivity that reads the same every morning.
 */
export function deriveImplications(input: ImplicationInput, positions: ImplicationPosition[]): Implication[] {
  const ctx = context(input, positions);
  if (ctx === null) return [];

  const all: Implication[] = [];
  const push = (item: Implication | null): void => {
    if (item) all.push(item);
  };
  push(futuresGap(ctx));
  push(betaGap(ctx));
  push(unpricedGap(ctx));
  push(openIndication(ctx));
  all.push(...nameSpecific(ctx));
  push(eventSensitivity(ctx));
  all.push(...earningsExposure(ctx));
  push(indexFlow(ctx));
  all.push(...exDividend(ctx));
  push(concentration(ctx));

  return all
    .sort((a, b) => {
      if ((a.kind === "data_gap") !== (b.kind === "data_gap")) return a.kind === "data_gap" ? -1 : 1;
      const scale = scaleOf(a) - scaleOf(b);
      if (scale !== 0) return scale;
      if (a.book_pct === null || b.book_pct === null) {
        if (a.book_pct !== b.book_pct) return a.book_pct === null ? 1 : -1;
      } else {
        const size = Math.abs(b.book_pct) - Math.abs(a.book_pct);
        if (size !== 0) return size;
      }
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byText(a.id, b.id);
    })
    .slice(0, MAX_IMPLICATIONS);
}
