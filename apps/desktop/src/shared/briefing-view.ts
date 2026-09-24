/**
 * Handover briefing: the view model.
 *
 * Every string the briefing panel and its dashboard card print is built here,
 * and so is every Intl call. The components stay dumb: they lay out what these
 * functions return and hold no formatting options, no date arithmetic and no
 * copy of their own. That is what lets one test file check the wording rules
 * (no advice verbs, no long dashes) against everything a reader can see, and
 * what keeps a masked book masked: there is a single place where a dollar
 * figure turns into text.
 *
 * Pure. Nothing here reads a clock; whatever depends on the time takes `now`.
 * Lives in `shared/` and is compiled for the main process too, so no DOM types.
 *
 * Numbers follow `renderer/lib/stock-format.ts`: two decimals, a real minus
 * sign (U+2212) rather than a hyphen, and no sign on a value that rounds to
 * zero.
 */

import type {
  BriefingHandover,
  BriefingPhase,
  BriefingPriorityBand,
  BriefingReport,
  BriefingSectionKey,
  CalendarItem,
  CalendarItemKind,
  CorporateEvent,
  CorporateEventKind,
  HeldCoverage,
  HeldMeasurementType,
  HeldMover,
  ImplicationKind,
  MarketGroup,
  MarketRow,
  MarketState,
  MarketUnit,
  Story,
  StoryReaction,
  StoryScope,
} from "./briefing-types";
import { RISK_BAND_LABEL } from "./risk-card";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export type Tone = "up" | "down" | "flat" | "none";

/** What a dollar figure becomes while the reader has amounts hidden. */
export const MASKED_USD = "$*****";

/** A figure that does not exist, as opposed to one that is zero. */
export const NOT_AVAILABLE = "n/a";

/** Every clock time in the panel is a New York time; the panel says so once. */
export const TIMES_NOTE = "All times are Eastern Time.";

/** U+2212, the typographic minus; it looks like a hyphen in most editors and is not one. */
const MINUS = "−";

/**
 * Month and weekday names are spelled out here instead of asked of Intl, for
 * two reasons. A session date is a calendar date, not an instant: handing
 * "2026-09-21" to a date formatter means picking a time of day and a zone for
 * it, and picking wrong prints the 20th to anyone west of UTC. And the text
 * then does not depend on which ICU build the runtime shipped with.
 */
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * A report can come out of the on-disk cache written by an older build, so a
 * list this build expects may simply not be there. Reading it as empty keeps
 * one missing section from blanking the whole panel.
 */
function list<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

type YmdParts = { y: number; m: number; d: number; dow: number; noonUtc: number };

/**
 * Reads a "YYYY-MM-DD" calendar date through UTC noon: far enough from both
 * ends of the day that no zone offset can push it onto a neighbouring date.
 * A date that does not exist (02-30) is rejected rather than rolled forward.
 */
function parseYmd(ymd: string): YmdParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return { y, m, d, dow: at.getUTCDay(), noonUtc: at.getTime() };
}

/** "Sep 24". An unreadable date is shown as it came, which beats showing nothing. */
function shortDate(ymd: string): string {
  const p = parseYmd(ymd);
  return p ? `${MONTH_ABBR[p.m - 1]} ${p.d}` : ymd;
}

/** "Mon Sep 28". */
function weekdayDate(ymd: string): string {
  const p = parseYmd(ymd);
  return p ? `${WEEKDAY_ABBR[p.dow]} ${MONTH_ABBR[p.m - 1]} ${p.d}` : ymd;
}

/** "Oct 31, 2026". */
function fullDate(ymd: string): string {
  const p = parseYmd(ymd);
  return p ? `${MONTH_ABBR[p.m - 1]} ${p.d}, ${p.y}` : ymd;
}

function daysBetween(fromYmd: string, toYmd: string): number | null {
  const a = parseYmd(fromYmd);
  const b = parseYmd(toYmd);
  return a && b ? Math.round((b.noonUtc - a.noonUtc) / 86_400_000) : null;
}

const NY_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** The New York calendar date and wall-clock time of an instant. */
function nyClock(at: Date | string): { ymd: string; hm: string } | null {
  const date = typeof at === "string" ? new Date(at) : at;
  if (!Number.isFinite(date.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const part of NY_CLOCK.formatToParts(date)) parts[part.type] = part.value;
  // Some engines print midnight as hour 24 even under h23.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hm: `${hour}:${parts.minute}` };
}

/**
 * The New York calendar date of an instant, "YYYY-MM-DD", or null when the
 * instant cannot be read. Exported because "which day is the reader on?" is
 * asked outside this file too: the pre-open window opens at 20:00 ET the
 * evening before, so the phase alone does not say whether the session in the
 * report has actually happened yet. A second Intl call in a component is the
 * thing this module exists to prevent.
 */
export function nyYmd(at: Date | string): string | null {
  return nyClock(at)?.ymd ?? null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "never",
});

const LEVEL = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Sign and tone are both taken from the ROUNDED value. Taken from the raw one,
 * a move of 0.004% prints as a green "+0.00%".
 */
function signedFixed(value: number, decimals: number): { text: string; tone: Tone } {
  const rounded = Number(value.toFixed(decimals));
  const sign = rounded > 0 ? "+" : rounded < 0 ? MINUS : "";
  const tone: Tone = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  return { text: `${sign}${Math.abs(rounded).toFixed(decimals)}`, tone };
}

function signedPercent(value: number): { text: string; tone: Tone } {
  const s = signedFixed(value, 2);
  return { text: `${s.text}%`, tone: s.tone };
}

/** A level rather than a change: a minus when negative, never a plus. */
function plainPercent(value: number, decimals: number): string {
  const rounded = Number(value.toFixed(decimals));
  return `${rounded < 0 ? MINUS : ""}${Math.abs(rounded).toFixed(decimals)}%`;
}

function usd(value: number, masked: boolean): string {
  if (masked) return MASKED_USD;
  return `${value < 0 ? MINUS : ""}${USD.format(Math.abs(value))}`;
}

function signedUsd(value: number, masked: boolean): string {
  if (masked) return MASKED_USD;
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  return `${sign}${USD.format(Math.abs(value))}`;
}

const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
  signDisplay: "never",
});

/**
 * A scenario's size: whole dollars and no sign. It runs either way, so the
 * figure is a size and not a gain or a loss, and it rests on a beta and a
 * volatility estimate; cents would claim a precision the arithmetic lacks.
 */
function scenarioSize(value: number, masked: boolean): string {
  if (masked) return MASKED_USD;
  return USD_WHOLE.format(Math.abs(value));
}

/** The sign class is plus, hyphen and U+2212: model prose uses either minus. */
const DOLLAR_AMOUNTS = [
  /[+\-−]?\s?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:thousand|million|billion|[kKmMbB])\b)?/g,
  /\bUSD\s?\d[\d,]*(?:\.\d+)?/g,
  /\d[\d,]*(?:\.\d+)?\s?(?:USD|dollars)\b/g,
];

/**
 * The backstop behind masking. The figures this file formats are masked at the
 * source, but the narrative and the risk sentence arrive as finished prose, and
 * a model that was given the overnight P&L is free to quote it. The leading
 * sign goes too: it belongs to the amount. Percentages are left alone, as they
 * are everywhere else in a masked view.
 */
export function maskDollarAmounts(text: string): string {
  let out = text;
  for (const pattern of DOLLAR_AMOUNTS) {
    out = out.replace(pattern, (hit) => (/^\s/.test(hit) ? ` ${MASKED_USD}` : MASKED_USD));
  }
  return out;
}

function symbolList(symbols: readonly string[]): string {
  const unique = [...new Set(symbols)];
  const shown = unique.slice(0, 4).join(", ");
  const rest = unique.length - 4;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

// ---------------------------------------------------------------------------
// Phase and masthead
// ---------------------------------------------------------------------------

/**
 * The report in a demo was assembled for a made-up morning. Judged against the
 * real clock it would read "closed" and every calendar line would be in the
 * past, so a demo is always viewed from the moment it was generated.
 */
export function viewNow(report: BriefingReport, realNow: Date): Date {
  return report.demo ? new Date(report.generated_at) : realNow;
}

/**
 * The phase as of `now`, not as of when the report was built. A panel opened at
 * 09:20 is still open at 09:31; without this it would go on saying "Pre-market"
 * until something refetched the report, and the refetch would cost a full
 * provider round for the sake of one chip.
 *
 * Before the target open the window's own bounds decide. If those cannot be
 * read, or the local clock sits before a window the engine already called
 * pre-open (a skewed clock), the report's word is kept.
 */
export function effectivePhase(report: BriefingReport, now: Date): BriefingPhase {
  const w = report.window;
  const t = now.getTime();
  const open = Date.parse(w.target_open_at);
  const close = Date.parse(w.target_close_at);
  if (!Number.isFinite(t) || !Number.isFinite(open) || !Number.isFinite(close)) return w.phase;
  if (t >= close) return "between_sessions";
  if (t >= open) return "in_session";
  const windowOpens = Date.parse(w.window_opens_at);
  if (Number.isFinite(windowOpens) && t >= windowOpens) return "pre_open";
  return w.phase === "pre_open" ? "pre_open" : "between_sessions";
}

/**
 * "2h 14m", "14m", "2d 13h". Minutes are floored, so the last minute would
 * read "0m" while there is still time on the clock; it reads "under 1m".
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "under 1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

export type PhaseChip = { tone: "pre" | "open" | "closed"; label: string; detail: string };

export function phaseChip(report: BriefingReport, now: Date): PhaseChip {
  const w = report.window;
  const phase = effectivePhase(report, now);
  const t = now.getTime();
  // With an unreadable bound the phase is the report's own word and there is
  // nothing to count down to; a made-up "under 1m" would be worse than no figure.
  if (phase === "pre_open") {
    const ms = Date.parse(w.target_open_at) - t;
    return { tone: "pre", label: "Pre-market", detail: Number.isFinite(ms) ? `opens in ${formatCountdown(ms)}` : "before the open" };
  }
  if (phase === "in_session") {
    const ms = Date.parse(w.target_close_at) - t;
    if (!Number.isFinite(ms)) return { tone: "open", label: "Market open", detail: "in session" };
    const left = formatCountdown(ms);
    return { tone: "open", label: "Market open", detail: w.early_close ? `closes early in ${left}` : `closes in ${left}` };
  }
  // Once the target session is over the report no longer knows which session
  // comes next (that takes the exchange calendar, which lives in the engine),
  // so it says what it does know instead of guessing at a weekday.
  const over = Number.isFinite(t) && t >= Date.parse(w.target_close_at);
  return {
    tone: "closed",
    label: "Closed",
    detail: over ? `${weekdayDate(w.target_session_ymd)} session ended` : `next session ${weekdayDate(w.target_session_ymd)}`,
  };
}

/** "MON SEP 21". */
export function mastheadDate(report: BriefingReport): string {
  return weekdayDate(report.window.target_session_ymd).toUpperCase();
}

/** "Handover for Monday, Sep 21". */
export function titleLine(report: BriefingReport): string {
  const ymd = report.window.target_session_ymd;
  const p = parseYmd(ymd);
  return p ? `Handover for ${WEEKDAY_NAME[p.dow]}, ${MONTH_ABBR[p.m - 1]} ${p.d}` : `Handover for ${ymd}`;
}

/**
 * "Since the close on Fri Sep 18". Every overnight figure is measured from that
 * close, and after a weekend or a holiday it is not yesterday's, so the panel
 * names the session instead of saying "overnight".
 */
export function sinceLine(report: BriefingReport): string {
  return `Since the close on ${weekdayDate(report.window.prev_session_ymd)}`;
}

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set(["vs.", "inc.", "corp.", "co.", "ltd.", "no.", "approx.", "est.", "a.m.", "p.m."]);

/**
 * Cuts after ". " only where a sentence can start, and never after an
 * abbreviation or a run of initials. Erring towards too few cuts is the safe
 * side: "U.S. Treasury yields rose." left whole reads fine, while cut at
 * "U.S." the card headline would be the two letters.
 */
function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out: string[] = [];
  // Quote characters inside these two patterns are written as escapes. A bare
  // one would read as an unbalanced string delimiter to anything that scans
  // this file's string literals, which is how the wording rules are checked.
  const boundary = /[.!?][\x22\x27)\]]?\s/g;
  let start = 0;
  for (let hit = boundary.exec(clean); hit; hit = boundary.exec(clean)) {
    const end = hit.index + hit[0].length;
    if (!/[A-Z0-9\x22\x27$+−(]/.test(clean.charAt(end))) continue;
    const sentence = clean.slice(start, end).trim();
    const lastWord = sentence.slice(sentence.lastIndexOf(" ") + 1);
    if (ABBREVIATIONS.has(lastWord.toLowerCase()) || /^(?:[A-Za-z]\.)+$/.test(lastWord)) continue;
    out.push(sentence);
    start = end;
  }
  const tail = clean.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export type NarrativeView = { sentences: string[]; source: "model" | "template"; pending: boolean };

export function narrativeView(report: BriefingReport, masked: boolean): NarrativeView {
  const n = report.narrative;
  const text = typeof n?.text === "string" ? n.text : "";
  const sentences = splitSentences(masked ? maskDollarAmounts(text) : text);
  return { sentences, source: n?.source === "model" ? "model" : "template", pending: n?.pending === true };
}

// ---------------------------------------------------------------------------
// Implications
// ---------------------------------------------------------------------------

export type ImplicationView = {
  id: string;
  kind: ImplicationKind;
  /** 1-based, as the panel numbers the list. */
  index: number;
  headline: string;
  /** The figures the conclusion rests on; empty when the engine sent none. */
  because: string;
  /** The either-way sensitivity, when one applies. */
  scenario: string | null;
  /** The scenario's size on this book ("$1,498"), or the mask. Null without a figure, or without a scenario to belong to. */
  scenarioUsd: string | null;
  tickers: string[];
};

function plainText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * The report's conclusions, numbered in the engine's order. The engine ranks
 * them by how much of the book each concerns; ranking them again here would
 * let the card and the panel disagree about which one leads.
 *
 * The contract keeps dollars out of every sentence, and the masked view still
 * runs the same backstop as the narrative over them: the text is finished
 * prose from another process, and the one dollar figure an implication may
 * carry travels in `scenarioUsd`, where the mask is applied at the source. A
 * per-share amount is masked along with an account one, since a pattern cannot
 * tell them apart; the other way round an account figure would show.
 *
 * An entry without a headline has nothing to number and is skipped, and the
 * numbering closes up behind it. A report from an older build has no list at
 * all and yields none.
 */
export function implicationsView(report: BriefingReport, masked: boolean): ImplicationView[] {
  const prose = (text: string) => (masked ? maskDollarAmounts(text) : text);
  const views: ImplicationView[] = [];
  const ids = new Set<string>();
  for (const raw of list(report.implications)) {
    if (!raw || typeof raw !== "object") continue;
    const headline = plainText(raw.headline);
    if (!headline) continue;
    const index = views.length + 1;
    // The panel keys its rows by id; a missing or repeated one would fold two
    // conclusions into one row on the next render.
    let id = typeof raw.id === "string" && raw.id !== "" ? raw.id : `implication-${index}`;
    if (ids.has(id)) id = `${id}-${index}`;
    ids.add(id);
    const scenario = plainText(raw.scenario) || null;
    views.push({
      id,
      kind: raw.kind,
      index,
      headline: prose(headline),
      because: prose(plainText(raw.because)),
      scenario: scenario === null ? null : prose(scenario),
      // A dollar figure with no sentence beside it would say nothing about what it sizes.
      scenarioUsd: scenario !== null && isNumber(raw.scenario_usd) ? scenarioSize(raw.scenario_usd, masked) : null,
      tickers: [...new Set(list(raw.tickers))].filter((t) => typeof t === "string" && t !== ""),
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Overnight markets
// ---------------------------------------------------------------------------

export type MarketRowView = {
  symbol: string;
  label: string;
  last: string;
  /** Empty when the move is withheld; `stateNote` then says why. */
  move: string;
  tone: Tone;
  state: MarketState;
  stateNote: string | null;
  /** Macro mixes closes with settlements, so the basis travels with the row as well as the group. */
  basis: MarketRow["basis"];
};

export type MarketGroupView = {
  key: MarketGroup;
  label: string;
  /** Set when the group's moves are measured from a settlement rather than a close. */
  basisNote: string | null;
  rows: MarketRowView[];
};

const GROUP_ORDER: MarketGroup[] = ["asia", "europe", "us_futures", "macro"];

const GROUP_LABEL: Record<MarketGroup, string> = {
  asia: "Asia",
  europe: "Europe",
  us_futures: "US futures",
  macro: "Macro",
};

function marketLevel(row: MarketRow): string {
  if (!isNumber(row.last)) return NOT_AVAILABLE;
  // The engine quotes a yield in percent (4.31 is 4.31%) and its move in basis points.
  if (row.unit === "bp") return `${row.last.toFixed(2)}%`;
  return LEVEL.format(row.last);
}

/** A move in its unit: "+0.42%", "+6.0 bp", or "+1.20" for the VIX's points. Shared by the market table and a story's chips. */
function moveText(move: number, unit: MarketUnit): { text: string; tone: Tone } {
  if (unit === "bp") {
    const s = signedFixed(move, 1);
    return { text: `${s.text} bp`, tone: s.tone };
  }
  if (unit === "pts") return signedFixed(move, 2);
  return signedPercent(move);
}

function marketMove(row: MarketRow): { text: string; tone: Tone } {
  if (!isNumber(row.move) || row.state === "stale" || row.state === "unavailable") return { text: "", tone: "none" };
  return moveText(row.move, row.unit);
}

/**
 * The date in a stale note is the UTC date of the last print. Every market in
 * the table closes well inside its own UTC day (Sydney at 06:00Z, Tokyo at
 * 06:00Z, Frankfurt at 15:30Z, Chicago futures at 21:00Z), so that is also the
 * local session date, and it needs no per-exchange zone table to get right.
 */
function marketStateNote(row: MarketRow): string | null {
  if (row.state === "unavailable") return "Unavailable";
  if (row.state !== "stale") return null;
  const at = row.as_of ? new Date(row.as_of) : null;
  if (!at || !Number.isFinite(at.getTime())) return "Closed, no fresh print";
  return `Closed, last session ${weekdayDate(at.toISOString().slice(0, 10))}`;
}

function marketRowView(row: MarketRow): MarketRowView {
  const move = marketMove(row);
  return {
    symbol: row.symbol,
    label: row.label,
    last: marketLevel(row),
    move: move.text,
    tone: move.tone,
    state: row.state,
    stateNote: marketStateNote(row),
    basis: row.basis,
  };
}

/** Groups in reading order (the night runs east to west); rows keep the engine's order; an empty group is dropped. */
export function marketGroups(report: BriefingReport): MarketGroupView[] {
  const rows = list(report.overnight?.markets);
  const groups: MarketGroupView[] = [];
  for (const key of GROUP_ORDER) {
    const mine = rows.filter((r) => r.group === key);
    if (mine.length === 0) continue;
    groups.push({
      key,
      label: GROUP_LABEL[key],
      basisNote: mine.every((r) => r.basis === "prior_settle") ? "Measured from the prior settle" : null,
      rows: mine.map(marketRowView),
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Held names
// ---------------------------------------------------------------------------

export type HeldItemView = {
  kind: "news" | "filing" | "measure";
  /** The source for news, the form family for a filing, the measurement's name. */
  label: string;
  text: string;
  time: string;
  band?: BriefingPriorityBand;
  url: string | null;
  /** Other held names the same article reached. */
  also: string[];
};

export type HeldRowView = {
  ticker: string;
  move: string;
  tone: Tone;
  /** The move in units of the name's own daily volatility, e.g. "+2.1σ". */
  z: string | null;
  basisNote: string | null;
  pnl: string;
  weight: string | null;
  coverageNote: string | null;
  flagNote: string | null;
  items: HeldItemView[];
  /** Items beyond the ones listed. */
  moreCount: number;
};

export type HeldRowsView = {
  rows: HeldRowView[];
  /** Held names with nothing to report that did not make the list. */
  quietCount: number;
  /** Held names WITH something to report that did not make the list. */
  hiddenCount: number;
};

export const HELD_ITEMS_PER_ROW = 3;

const BAND_RANK: Record<BriefingPriorityBand, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
/** A filing or a measurement sits level with mid-priority news when a row's items are ordered. */
const NON_NEWS_RANK = 2;
const NO_ATTENTION = 9;

const COVERAGE_NOTE: Record<HeldCoverage, string | null> = {
  tracked: null,
  price_only: "Prices and filings only",
  pending: "No tracker coverage yet",
};

const MEASUREMENT_LABEL: Record<HeldMeasurementType, string> = {
  unexplained_move: "Unexplained move",
  volume_anomaly: "Volume anomaly",
  drift_event: "Drift",
  gap_event: "Gap",
  news_burst: "News burst",
  insider_cluster: "Insider cluster",
};

/** Today's items show a bare time; older ones need the day, and past a week the date. */
function itemTime(iso: string, targetYmd: string): string {
  const clock = nyClock(iso);
  if (!clock) return "";
  if (clock.ymd === targetYmd) return clock.hm;
  const gap = daysBetween(clock.ymd, targetYmd);
  const p = parseYmd(clock.ymd);
  if (p && gap !== null && Math.abs(gap) < 7) return `${WEEKDAY_ABBR[p.dow]} ${clock.hm}`;
  return `${shortDate(clock.ymd)} ${clock.hm}`;
}

type RankedItem = { view: HeldItemView; rank: number; at: number };

function heldItems(report: BriefingReport, ticker: string): RankedItem[] {
  const targetYmd = report.window.target_session_ymd;
  const items: RankedItem[] = [];
  const stamp = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  for (const n of list(report.overnight?.held_news)) {
    if (n.ticker !== ticker) continue;
    items.push({
      rank: BAND_RANK[n.band] ?? BAND_RANK.P3,
      at: stamp(n.published_at),
      view: {
        kind: "news",
        label: n.source,
        text: n.headline,
        time: itemTime(n.published_at, targetYmd),
        band: n.band,
        url: n.url || null,
        also: [...list(n.also)],
      },
    });
  }
  for (const f of list(report.overnight?.filings)) {
    if (f.ticker !== ticker) continue;
    items.push({
      rank: NON_NEWS_RANK,
      at: stamp(f.filed_at),
      view: {
        kind: "filing",
        label: f.kind === "insider" ? "Insider" : "Filing",
        text: f.label,
        time: itemTime(f.filed_at, targetYmd),
        url: f.url || null,
        also: [],
      },
    });
  }
  for (const m of list(report.overnight?.measurements)) {
    if (m.ticker !== ticker) continue;
    items.push({
      rank: NON_NEWS_RANK,
      at: stamp(m.at),
      view: {
        kind: "measure",
        label: MEASUREMENT_LABEL[m.type] ?? "Measurement",
        text: m.detail,
        time: itemTime(m.at, targetYmd),
        url: null,
        also: [],
      },
    });
  }
  return items.sort((a, b) => a.rank - b.rank || b.at - a.at);
}

/**
 * How many of its own daily moves a name has made. Where the engine has no
 * volatility for the name, 2% stands in for it (an ordinary day for a single
 * stock). The stand-in only decides the ORDER of rows and which ones count as
 * quiet; it is never printed.
 */
function sigmaForOrdering(mover: HeldMover | undefined): number {
  if (!mover) return 0;
  if (isNumber(mover.move_z)) return Math.abs(mover.move_z);
  return isNumber(mover.move_pct) ? Math.abs(mover.move_pct) / 2 : 0;
}

function attentionRank(items: RankedItem[], sigma: number): number {
  const fromItems = items.length > 0 ? items[0].rank : NO_ATTENTION;
  const fromMove = sigma >= 3 ? 0 : sigma >= 2 ? 1 : sigma >= 1 ? 2 : NO_ATTENTION;
  return Math.min(fromItems, fromMove);
}

/**
 * One row per held name. Names with something to report come first (a flagged
 * print, then the highest-priority news or the largest move in its own terms);
 * quiet names fill whatever room is left under `limit`, largest move first, so
 * a calm night still shows the book rather than an empty section. What did not
 * fit is counted, split by whether it had anything to say, so the panel never
 * calls a name quiet that merely fell below the fold.
 */
export function heldRows(report: BriefingReport, options: { limit: number; masked: boolean }): HeldRowsView {
  const movers = new Map<string, HeldMover>();
  for (const m of list(report.overnight?.held_movers)) movers.set(m.ticker, m);
  const coverage = new Map<string, HeldCoverage>();
  for (const c of list(report.held_coverage)) coverage.set(c.ticker, c.coverage);
  const weights = new Map<string, number>();
  for (const w of list(report.book?.top_weights)) weights.set(w.ticker, w.weight);

  const tickers = new Set<string>([...coverage.keys(), ...movers.keys(), ...list(report.book?.unpriced)]);
  for (const n of list(report.overnight?.held_news)) tickers.add(n.ticker);
  for (const f of list(report.overnight?.filings)) tickers.add(f.ticker);
  for (const m of list(report.overnight?.measurements)) tickers.add(m.ticker);

  const built = [...tickers].map((ticker) => {
    const mover = movers.get(ticker);
    const items = heldItems(report, ticker);
    const sigma = sigmaForOrdering(mover);
    const flagged = mover?.flag === "corporate_action_check";
    const move = mover && isNumber(mover.move_pct) ? signedPercent(mover.move_pct) : { text: NOT_AVAILABLE, tone: "none" as Tone };
    const weight = weights.get(ticker);
    const row: HeldRowView = {
      ticker,
      move: move.text,
      tone: move.tone,
      z: mover && isNumber(mover.move_z) ? `${signedFixed(mover.move_z, 1).text}σ` : null,
      basisNote: mover ? (mover.basis === "today" ? "today" : "since last close") : null,
      pnl: mover && isNumber(mover.pnl_usd) ? signedUsd(mover.pnl_usd, options.masked) : NOT_AVAILABLE,
      weight: isNumber(weight) ? plainPercent(Math.abs(weight) * 100, 1) : null,
      coverageNote: COVERAGE_NOTE[coverage.get(ticker) ?? "tracked"] ?? null,
      flagNote: flagged ? "Check for a corporate action" : null,
      items: items.slice(0, HELD_ITEMS_PER_ROW).map((i) => i.view),
      moreCount: Math.max(0, items.length - HELD_ITEMS_PER_ROW),
    };
    return {
      row,
      notable: flagged || items.length > 0 || sigma >= 1,
      flagged,
      attention: attentionRank(items, sigma),
      size: mover && isNumber(mover.move_pct) ? Math.abs(mover.move_pct) : 0,
    };
  });

  built.sort(
    (a, b) =>
      Number(b.notable) - Number(a.notable) ||
      Number(b.flagged) - Number(a.flagged) ||
      a.attention - b.attention ||
      b.size - a.size ||
      a.row.ticker.localeCompare(b.row.ticker),
  );

  const limit = Math.max(0, Math.floor(options.limit));
  const dropped = built.slice(limit);
  return {
    rows: built.slice(0, limit).map((b) => b.row),
    quietCount: dropped.filter((b) => !b.notable).length,
    hiddenCount: dropped.filter((b) => b.notable).length,
  };
}

// ---------------------------------------------------------------------------
// Book and risk
// ---------------------------------------------------------------------------

export type BookTileView = {
  key: "equity" | "since_close" | "net_exposure" | "positions";
  label: string;
  value: string;
  sub: string | null;
  tone: Tone;
};

export type WeightSegmentView = {
  /** Null for the segment that stands for everything outside the top weights. */
  ticker: string | null;
  label: string;
  /** Share of the bar, 0..1; the segments sum to 1. */
  share: number;
  weight: string;
  side: "long" | "short" | "rest";
  sideNote: string | null;
};

export type RiskBlockView = {
  score: string;
  band: string | null;
  sentence: string | null;
  stats: Array<{ label: string; value: string }>;
};

export type BookView = {
  tiles: BookTileView[];
  weights: WeightSegmentView[];
  unpricedNote: string | null;
  risk: RiskBlockView | null;
  /** Says why the risk block is missing; null while it is shown. */
  riskNote: string | null;
};

export const RISK_UNAVAILABLE_NOTE = "Risk figures are not available for this book.";

function riskBlock(report: BriefingReport, masked: boolean): RiskBlockView | null {
  const r = report.risk;
  // The engine keeps a single risk account. A snapshot computed over another
  // set of tickers is a true number about the wrong book, and printing it
  // beside this book's equity would pass it off as this book's.
  if (!r || r.matches_book !== true || !isNumber(r.score)) return null;
  const stats: Array<{ label: string; value: string }> = [];
  if (isNumber(r.beta_port)) stats.push({ label: "Portfolio beta", value: r.beta_port.toFixed(2) });
  if (isNumber(r.beta_eff)) stats.push({ label: "Effective beta", value: r.beta_eff.toFixed(2) });
  if (isNumber(r.port_vol_daily_pct)) stats.push({ label: "Daily volatility", value: plainPercent(r.port_vol_daily_pct, 2) });
  const bandLabel = r.band ? ((RISK_BAND_LABEL as Record<string, string>)[r.band] ?? `${r.band.charAt(0).toUpperCase()}${r.band.slice(1)}`) : null;
  const sentence = r.driver_sentence ? (masked ? maskDollarAmounts(r.driver_sentence) : r.driver_sentence) : null;
  return { score: String(Math.max(0, Math.min(100, Math.round(r.score)))), band: bandLabel, sentence, stats };
}

/**
 * The weights bar. Weights follow the risk engine's convention, a fraction of
 * the invested book, so the top names and one "Rest of book" segment make up
 * the whole bar. The rest segment only appears when the book really holds more
 * names than the list carries; otherwise rounding alone would draw a sliver.
 */
function weightSegments(report: BriefingReport): WeightSegmentView[] {
  const book = report.book;
  const top = list(book?.top_weights).filter((w) => isNumber(w.weight) && w.weight !== 0);
  const listed = top.reduce((sum, w) => sum + Math.abs(w.weight), 0);
  if (listed <= 0) return [];
  const rest = (book?.position_count ?? 0) > top.length ? Math.max(0, 1 - listed) : 0;
  const whole = listed + rest;
  const segments: WeightSegmentView[] = top.map((w) => ({
    ticker: w.ticker,
    label: w.ticker,
    share: Math.abs(w.weight) / whole,
    weight: plainPercent(Math.abs(w.weight) * 100, 1),
    side: w.side,
    sideNote: w.side === "short" ? "borrowed" : null,
  }));
  if (rest > 0.0005) {
    segments.push({ ticker: null, label: "Rest of book", share: rest / whole, weight: plainPercent(rest * 100, 1), side: "rest", sideNote: null });
  }
  return segments;
}

/** Dollars are masked; percentages stay, because a percentage gives away no account size. */
export function bookView(report: BriefingReport, masked: boolean): BookView {
  const b = report.book;
  const pnlPct = isNumber(b?.overnight_pnl_pct) ? signedPercent(b.overnight_pnl_pct) : null;
  const pnlUsd = isNumber(b?.overnight_pnl_usd) ? b.overnight_pnl_usd : null;
  const unpriced = list(b?.unpriced);

  const tiles: BookTileView[] = [
    {
      key: "equity",
      label: "Equity",
      value: isNumber(b?.equity_usd) ? usd(b.equity_usd, masked) : NOT_AVAILABLE,
      sub: isNumber(b?.cash_usd) ? `Cash ${usd(b.cash_usd, masked)}` : null,
      tone: "none",
    },
    {
      key: "since_close",
      label: "Since last close",
      value: pnlUsd !== null ? signedUsd(pnlUsd, masked) : NOT_AVAILABLE,
      sub: pnlPct ? pnlPct.text : null,
      // The tone survives masking on purpose: the percentage beside it is
      // visible anyway, so the colour tells the reader nothing new.
      tone: pnlPct ? pnlPct.tone : pnlUsd !== null ? signedFixed(pnlUsd, 2).tone : "none",
    },
    {
      key: "net_exposure",
      label: "Net exposure",
      value: isNumber(b?.net_exposure_pct) ? plainPercent(b.net_exposure_pct, 1) : NOT_AVAILABLE,
      sub: isNumber(b?.gross_exposure_pct) ? `Gross ${plainPercent(b.gross_exposure_pct, 1)}` : null,
      tone: "none",
    },
    {
      key: "positions",
      label: "Positions",
      value: isNumber(b?.position_count) ? String(b.position_count) : NOT_AVAILABLE,
      sub: unpriced.length > 0 ? `${unpriced.length} without a price` : null,
      tone: "none",
    },
  ];

  const risk = riskBlock(report, masked);
  return {
    tiles,
    weights: weightSegments(report),
    unpricedNote: unpriced.length > 0 ? `No price found for ${symbolList(unpriced)}.` : null,
    risk,
    riskNote: risk ? null : RISK_UNAVAILABLE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Corporate events
// ---------------------------------------------------------------------------

export type CorporateRowView = {
  id: string;
  /** "Sep 24". */
  dateLabel: string;
  /** "today", a weekday name, "in 1 session", "in 3 sessions", or "passed". */
  whenLabel: string;
  kind: CorporateEventKind;
  kindLabel: string;
  ticker: string | null;
  title: string;
  detail: string;
  certaintyNote: string | null;
  /** Held symbols this touches, other than the event's own ticker. */
  concerns: string[];
};

export type CorporateView = { rows: CorporateRowView[]; coverageNotes: string[] };

const CORPORATE_KIND_LABEL: Record<CorporateEventKind, string> = {
  dividend: "Dividend",
  split: "Split",
  rebalance: "Index rebalance",
  earnings: "Earnings",
};

const CERTAINTY_NOTE: Record<CorporateEvent["certainty"], string | null> = {
  confirmed: null,
  estimated: "estimated date",
  rule: "scheduled, per index methodology",
};

/**
 * `sessions_until` counts from the TARGET session, and the target is not always
 * today: on a Sunday evening it is Monday. So "today" is only said when the
 * event's date is the New York date of `now`; an event on the target session
 * seen from the evening before is named by its weekday instead.
 */
function whenLabel(event: CorporateEvent, todayYmd: string | null): string {
  if (todayYmd !== null && event.date === todayYmd) return "today";
  if (todayYmd !== null && parseYmd(event.date) && event.date < todayYmd) return "passed";
  if (event.sessions_until <= 0) {
    const p = parseYmd(event.date);
    return p ? WEEKDAY_NAME[p.dow] : "next session";
  }
  return event.sessions_until === 1 ? "in 1 session" : `in ${event.sessions_until} sessions`;
}

export function corporateRows(report: BriefingReport, now: Date): CorporateView {
  const todayYmd = nyClock(now)?.ymd ?? null;
  const events = [...list(report.corporate_events)];
  // Array sort is stable, so events on one date keep the order the engine chose.
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const rows = events.map((e): CorporateRowView => ({
    id: e.id,
    dateLabel: shortDate(e.date),
    whenLabel: whenLabel(e, todayYmd),
    kind: e.kind,
    kindLabel: CORPORATE_KIND_LABEL[e.kind] ?? "Event",
    ticker: e.ticker,
    title: e.title,
    detail: e.detail,
    certaintyNote: CERTAINTY_NOTE[e.certainty] ?? null,
    concerns: [...new Set(list(e.affects_held))].filter((s) => s !== e.ticker),
  }));

  const c = report.corporate_coverage;
  const coverageNotes: string[] = [];
  if (c?.dividends) coverageNotes.push(c.dividends);
  if (c?.splits) coverageNotes.push(c.splits);
  const unknown = list(c?.unknown_symbols);
  if (unknown.length > 0) coverageNotes.push(`No corporate calendar data for ${symbolList(unknown)}.`);
  return { rows, coverageNotes };
}

// ---------------------------------------------------------------------------
// Today's calendar
// ---------------------------------------------------------------------------

export type CalendarItemView = {
  id: string;
  kind: CalendarItemKind;
  kindLabel: string;
  title: string;
  detail: string | null;
  importance: 1 | 2 | 3;
  tickers: string[];
  /** "08:30" New York time; null for an all-day item. */
  timeLabel: string | null;
  past: boolean;
};

export type TimedCalendarItemView = CalendarItemView & { timeLabel: string };

export type CalendarFootnote = { text: string; tone: "quiet" | "warn" };

export type CalendarView = {
  allDay: CalendarItemView[];
  timed: TimedCalendarItemView[];
  /** Where the "now" line goes among `timed`: the index of the first item still ahead. */
  nowIndex: number;
  /**
   * Whether `now` falls on the session this column lists. False from 20:00 ET
   * the evening before, when the window is already open for a day that has not
   * started: a wall-clock time on the marker would then print "21:30" above
   * "08:30" on a rail that is otherwise strictly in order.
   */
  nowOnTargetDay: boolean;
  footnote: CalendarFootnote;
};

const CALENDAR_KIND_LABEL: Record<CalendarItemKind, string> = {
  fomc: "FOMC",
  data: "Data",
  opex: "Options",
  earnings: "Earnings",
  session: "Session",
  rebalance: "Index",
};

/**
 * Whether a timed item is behind `now`. The engine sends the instant alongside
 * the ET label so nothing here converts zones; if the instant is missing, the
 * label is compared with New York's own wall clock instead.
 */
function isPast(item: CalendarItem, now: Date, targetYmd: string): boolean {
  const t = now.getTime();
  if (!Number.isFinite(t)) return false;
  const at = item.at ? Date.parse(item.at) : Number.NaN;
  if (Number.isFinite(at)) return at <= t;
  const clock = nyClock(now);
  if (!clock || !item.time_et) return false;
  if (clock.ymd !== targetYmd) return clock.ymd > targetYmd;
  return item.time_et <= clock.hm;
}

function calendarItemView(item: CalendarItem, past: boolean): CalendarItemView {
  return {
    id: item.id,
    kind: item.kind,
    kindLabel: CALENDAR_KIND_LABEL[item.kind] ?? "Event",
    title: item.title,
    detail: item.detail ?? null,
    importance: item.importance,
    tickers: [...list(item.tickers)],
    timeLabel: item.time_et ?? null,
    past,
  };
}

function calendarFootnote(report: BriefingReport): CalendarFootnote {
  const c = report.calendar_coverage;
  if (!c || !c.until) return { text: "Calendar coverage is unknown.", tone: "warn" };
  if (!c.covers_target) return { text: `Calendar data ends ${fullDate(c.until)}. This session is not covered.`, tone: "warn" };
  return { text: `Calendar covers until ${fullDate(c.until)}.`, tone: "quiet" };
}

export function calendarView(report: BriefingReport, now: Date): CalendarView {
  const targetYmd = report.window.target_session_ymd;
  const items = list(report.calendar_today);

  // "HH:MM" sorts correctly as text, and every item is on the one New York day.
  const timedItems = items
    .filter((i) => typeof i.time_et === "string" && i.time_et !== "")
    .map((i, index) => ({ i, index }))
    .sort((a, b) => (a.i.time_et as string).localeCompare(b.i.time_et as string) || b.i.importance - a.i.importance || a.index - b.index);

  const timed = timedItems.map(({ i }) => calendarItemView(i, isPast(i, now, targetYmd)) as TimedCalendarItemView);
  const firstAhead = timed.findIndex((t) => !t.past);

  // An all-day item is behind us once the session it belongs to has closed.
  const closeAt = Date.parse(report.window.target_close_at);
  const dayOver = Number.isFinite(closeAt) && Number.isFinite(now.getTime()) && now.getTime() >= closeAt;
  const allDay = items
    .filter((i) => !i.time_et)
    .map((i, index) => ({ i, index }))
    .sort((a, b) => b.i.importance - a.i.importance || a.index - b.index)
    .map(({ i }) => calendarItemView(i, dayOver));

  return {
    allDay,
    timed,
    nowIndex: firstAhead === -1 ? timed.length : firstAhead,
    nowOnTargetDay: nyYmd(now) === targetYmd,
    footnote: calendarFootnote(report),
  };
}

// ---------------------------------------------------------------------------
// Degraded sections
// ---------------------------------------------------------------------------

const DEGRADED_NOTE: Record<BriefingSectionKey, string> = {
  markets: "Overnight prints are unavailable right now.",
  held_quotes: "Fresh prices for held names are unavailable right now.",
  chain_news: "News and filings on held names are unavailable right now.",
  market_news: "Market-wide headlines are unavailable right now, so the stories rest on the figures alone.",
  quant: "Volatility context is unavailable, so moves are shown without it.",
  risk: "Risk figures are unavailable right now.",
  corporate_actions: "Corporate events are unavailable right now.",
  macro_calendar: "The macro calendar is unavailable right now.",
  narrative: "The written summary is using the standard template.",
};

/** When only some symbols failed, the note names them and the rest of the section stands. */
const DEGRADED_NOTE_FOR_SYMBOLS: Partial<Record<BriefingSectionKey, string>> = {
  held_quotes: "No fresh price for",
  chain_news: "News and filings are unavailable for",
  quant: "Volatility context is unavailable for",
  corporate_actions: "Corporate events are unavailable for",
};

/**
 * One quiet line per section that failed. The engine's own `detail` is never
 * shown: it is written for a log, and keeping it out is also what guarantees
 * no provider text reaches the reader.
 */
export function degradedNotes(report: BriefingReport): Partial<Record<BriefingSectionKey, string>> {
  const symbolsBySection = new Map<BriefingSectionKey, string[] | null>();
  for (const d of list(report.degraded)) {
    if (!(d.section in DEGRADED_NOTE)) continue;
    const symbols = list(d.symbols);
    const known = symbolsBySection.get(d.section);
    // One entry without symbols means the whole section failed; that outranks
    // any per-symbol entry for the same section.
    if (symbols.length === 0 || known === null) symbolsBySection.set(d.section, null);
    else symbolsBySection.set(d.section, [...(known ?? []), ...symbols]);
  }
  const notes: Partial<Record<BriefingSectionKey, string>> = {};
  for (const [section, symbols] of symbolsBySection) {
    const lead = DEGRADED_NOTE_FOR_SYMBOLS[section];
    notes[section] = symbols && lead ? `${lead} ${symbolList(symbols)}.` : DEGRADED_NOTE[section];
  }
  return notes;
}

// ---------------------------------------------------------------------------
// What happened: the stories the panel leads with
// ---------------------------------------------------------------------------

export type StoryReactionView = { label: string; move: string; tone: Tone };

export type StoryView = {
  id: string;
  scope: StoryScope;
  /** 1-based, in the engine's order. */
  index: number;
  /**
   * The rail label: "06:42" on the session's own day, "Sat 06:42" within the
   * week, the name of the gap ("Overnight", "Weekend", "Holiday", or "Session"
   * once the US is trading) for a story that is the session itself, and null
   * for an instant that cannot be read.
   */
  at: string | null;
  what: string;
  reaction: string;
  meaning: string | null;
  reactions: StoryReactionView[];
  tickers: string[];
  /** The ids the story rests on; the panel uses them to keep a conclusion from being said twice. */
  evidence: string[];
  source: "model" | "template";
};

const STORY_SCOPES: ReadonlySet<string> = new Set<StoryScope>(["market", "name", "release"]);

const HANDOVER_LABEL: Record<BriefingHandover, string> = { overnight: "Overnight", weekend: "Weekend", holiday: "Holiday" };

function storyAtLabel(story: Story, report: BriefingReport): string | null {
  if (story.at === null || story.at === undefined) {
    if (report.window?.phase === "in_session") return "Session";
    const handover = report.window?.handover;
    return (handover && HANDOVER_LABEL[handover]) || "Overnight";
  }
  const label = itemTime(story.at, report.window?.target_session_ymd ?? "");
  return label === "" ? null : label;
}

/** A missing print is said, not skipped: a chip that reads n/a tells the reader the figure was looked for. */
function storyReactionView(reaction: StoryReaction): StoryReactionView {
  const label = plainText(reaction.label);
  if (!isNumber(reaction.move)) return { label, move: NOT_AVAILABLE, tone: "none" };
  const move = moveText(reaction.move, reaction.unit);
  return { label, move: move.text, tone: move.tone };
}

/**
 * The stories in the engine's order: it ranks them by how much each matters
 * to the book, and ranking them again here would let the card and the panel
 * disagree about which one leads.
 *
 * The contract keeps dollars out of every sentence, and the masked view still
 * runs the same backstop as the narrative over them: the text is finished
 * prose from another process. A story with no `what` has nothing to lead with
 * and is skipped, and the numbering closes up behind it. A report from an
 * older build has no list at all and yields none.
 */
export function storiesView(report: BriefingReport, masked: boolean): StoryView[] {
  const prose = (text: string) => (masked ? maskDollarAmounts(text) : text);
  const views: StoryView[] = [];
  const ids = new Set<string>();
  for (const raw of list(report.stories)) {
    if (!raw || typeof raw !== "object") continue;
    const what = plainText(raw.what);
    if (!what) continue;
    const index = views.length + 1;
    // The panel keys its blocks by id; a missing or repeated one would fold
    // two stories into one block on the next render.
    let id = typeof raw.id === "string" && raw.id !== "" ? raw.id : `story-${index}`;
    if (ids.has(id)) id = `${id}-${index}`;
    ids.add(id);
    const meaning = plainText(raw.meaning) || null;
    views.push({
      id,
      scope: STORY_SCOPES.has(raw.scope) ? raw.scope : "market",
      index,
      at: storyAtLabel(raw, report),
      what: prose(what),
      reaction: prose(plainText(raw.reaction)),
      meaning: meaning === null ? null : prose(meaning),
      reactions: list(raw.reactions)
        .filter((r) => r && typeof r === "object")
        .map(storyReactionView)
        .filter((r) => r.label !== ""),
      tickers: [...new Set(list(raw.tickers))].filter((t) => typeof t === "string" && t !== ""),
      evidence: [...new Set(list(raw.evidence))].filter((e) => typeof e === "string" && e !== ""),
      source: raw.source === "model" ? "model" : "template",
    });
  }
  return views;
}

/**
 * The ids a story's "for your book" line already accounts for, so the
 * conclusions list under the stories leaves those out. Only a story with a
 * meaning lends its evidence: a story that concludes nothing has said nothing
 * the list would repeat.
 */
export function spokenImplicationIds(stories: readonly StoryView[]): Set<string> {
  const ids = new Set<string>();
  for (const story of stories) {
    if (story.meaning === null) continue;
    for (const id of story.evidence) ids.add(id);
  }
  return ids;
}

/**
 * The panel's title, by phase: "Handover for Monday, Sep 21" before the open,
 * "Session so far, Monday, Sep 21" in it, "After the close, Monday, Sep 21"
 * once it is over. With `now` the phase is the one as of now (the panel's
 * clock); without it, the report's own word and its own instant, which is
 * what a report built on a simulated clock is judged by.
 *
 * "After the close" names the session that closed. Between the close and the
 * window opening at 20:00 ET the report already hands over to the NEXT
 * session, so the day that closed is the previous one.
 */
export function phaseTitle(report: BriefingReport, now?: Date): string {
  const w = report.window;
  const phase = now ? effectivePhase(report, now) : w.phase;
  const ref = now ? now.getTime() : Date.parse(report.generated_at);
  const close = Date.parse(w.target_close_at);
  const closed = Number.isFinite(ref) && Number.isFinite(close) && ref >= close;
  const day = (ymd: string) => {
    const p = parseYmd(ymd);
    return p ? `${WEEKDAY_NAME[p.dow]}, ${MONTH_ABBR[p.m - 1]} ${p.d}` : ymd;
  };
  if (phase === "in_session") return `Session so far, ${day(w.target_session_ymd)}`;
  if (phase === "between_sessions") return `After the close, ${day(closed ? w.target_session_ymd : w.prev_session_ymd)}`;
  return `Handover for ${day(w.target_session_ymd)}`;
}

// ---------------------------------------------------------------------------
// Dashboard card
// ---------------------------------------------------------------------------

export type CardStoryRow = {
  id: string;
  scope: StoryScope;
  what: string;
  /** The first figure the story carries a print for; null when it carries none. */
  primaryMove: string | null;
  tone: Tone;
};

export type CardSummary = {
  phase: PhaseChip;
  /** The lead story's what. With no stories: the lead conclusion, then the narrative's first sentence, then the title. */
  headline: string;
  /** The lead story's reaction sentence, or under the fallback the lead conclusion's evidence line. Null when there is neither. */
  sub: string | null;
  /** The lead story's meaning for the book; null when nothing follows for it, or when no story leads. */
  meaning: string | null;
  /** The lead story's figures, at most three. */
  reactions: StoryReactionView[];
  /** The two stories after the lead. */
  more: CardStoryRow[];
  /** The next calendar item still ahead: "08:30 Retail sales", or the title alone for an all-day item. Null when nothing is left. */
  nextItem: string | null;
};

const CARD_REACTIONS = 3;
const CARD_MORE = 2;

function primaryMove(reactions: readonly StoryReactionView[]): StoryReactionView | null {
  return reactions.find((r) => r.move !== NOT_AVAILABLE) ?? null;
}

/**
 * The card leads with the panel's first story, so the one sentence a reader
 * meets on the dashboard is what happened and not a figure. With no stories
 * (a quiet night, an older report) it leads with the first conclusion and its
 * evidence line, past that with the narrative's opening sentence, and past
 * that with the title.
 */
export function cardSummary(report: BriefingReport, now: Date, masked: boolean): CardSummary {
  const calendar = calendarView(report, now);
  const next = [...calendar.timed.filter((t) => !t.past), ...calendar.allDay.filter((a) => !a.past)][0];
  const stories = storiesView(report, masked);
  const lead = stories[0];
  const conclusion = lead ? undefined : implicationsView(report, masked)[0];
  return {
    phase: phaseChip(report, now),
    headline: lead?.what ?? conclusion?.headline ?? narrativeView(report, masked).sentences[0] ?? titleLine(report),
    sub: lead ? lead.reaction || null : conclusion && conclusion.because !== "" ? conclusion.because : null,
    meaning: lead?.meaning ?? null,
    reactions: lead ? lead.reactions.slice(0, CARD_REACTIONS) : [],
    more: stories.slice(1, 1 + CARD_MORE).map((story) => {
      const move = primaryMove(story.reactions);
      return { id: story.id, scope: story.scope, what: story.what, primaryMove: move?.move ?? null, tone: move?.tone ?? "none" };
    }),
    nextItem: next ? (next.timeLabel ? `${next.timeLabel} ${next.title}` : next.title) : null,
  };
}
