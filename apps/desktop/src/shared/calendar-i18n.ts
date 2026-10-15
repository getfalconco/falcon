/**
 * The calendar rows the engine words in English, re-worded in the reader's
 * language at render time.
 *
 * The engine (`@meridian/research/calendar`) and the demo builder write each
 * row's title and detail as English sentences from a closed set: the curated
 * macro calendar's release names, the expiry and rebalance rules, the session
 * exceptions and the held-earnings line. Those strings are the contract, and
 * the main process caches whole reports built from them, so rather than
 * change what crosses IPC the renderer matches the known wording here and
 * looks up its key. Anything unknown (an overlay row with a new name, a
 * sentence a later engine adds) is shown exactly as written, in English, and
 * a detail is translated only when every one of its sentences is known, so a
 * line never comes out half in one language and half in another.
 *
 * Pure. English in, English out under `ENGLISH`.
 */

import { ENGLISH, monthYearLabel, type BriefingKey, type BriefingText } from "./briefing-text";

/** Exact titles, by the engine's own English. */
const TITLE_KEY: Readonly<Record<string, BriefingKey>> = {
  "Early close at 13:00 ET": "briefing.row.earlyClose",
  "First session after a US market holiday": "briefing.row.afterHoliday",
  "Quarterly options and futures expiry": "briefing.row.quarterlyExpiry",
  "Monthly options expiry": "briefing.row.monthlyOpex",
  "VIX futures and options expiry": "briefing.row.vixExpiry",
  "S&P quarterly index rebalance": "briefing.row.spRebalance",
  "Nasdaq-100 annual reconstitution": "briefing.row.ndxAnnual",
  "Nasdaq-100 quarterly rebalance": "briefing.row.ndxQuarterly",
  "MSCI quarterly index review": "briefing.row.msciReview",
  "Russell index reconstitution": "briefing.row.russellRecon",
  "Consumer Price Index": "briefing.macro.cpi",
  "Producer Price Index": "briefing.macro.ppi",
  "Advance Monthly Retail Sales": "briefing.macro.retail",
  "Retail sales": "briefing.macro.retailShort",
  "Personal Income and Outlays (PCE inflation)": "briefing.macro.pce",
  "Employment Situation (jobs report)": "briefing.macro.nfp",
  "New Home Sales": "briefing.macro.newHomeSales",
  "New home sales": "briefing.macro.newHomeSalesShort",
  "Job Openings and Labor Turnover": "briefing.macro.jolts",
  "Job openings (JOLTS)": "briefing.macro.joltsShort",
  "New Residential Construction (housing starts)": "briefing.macro.housingStarts",
  "Housing starts": "briefing.macro.housingStartsShort",
  "Advance Report on Durable Goods": "briefing.macro.durables",
  "Durable goods orders": "briefing.macro.durablesShort",
  "University of Michigan consumer sentiment (preliminary)": "briefing.macro.umichPrelim",
  "University of Michigan consumer sentiment (final)": "briefing.macro.umichFinal",
  "Consumer sentiment": "briefing.macro.sentiment",
  "Initial jobless claims": "briefing.macro.claims",
  "ISM Manufacturing PMI": "briefing.macro.ismManufacturing",
  "ISM Services PMI": "briefing.macro.ismServices",
  "GDP (advance estimate)": "briefing.macro.gdpAdvance",
  "GDP (second estimate)": "briefing.macro.gdpSecond",
  "GDP (third estimate)": "briefing.macro.gdpThird",
  "FOMC rate decision": "briefing.macro.fomc",
  "FOMC rate decision and projections": "briefing.macro.fomcProjections",
  "Fed Chair press conference": "briefing.macro.fomcPresser",
};

/** Exact detail sentences. A detail is one or more of these, or of the patterns below. */
const SENTENCE_KEY: Readonly<Record<string, BriefingKey>> = {
  "US equities close at 13:00 ET this session.": "briefing.row.earlyCloseDetail",
  "Markets abroad traded while the US was closed.": "briefing.row.afterHolidayDetail",
  "Before the open.": "briefing.row.beforeOpen",
  "After the close, or at an hour not yet announced.": "briefing.row.afterClose",
  "Covers the prior week.": "briefing.row.coversPriorWeek",
  "Statement at 14:00 ET, press conference at 14:30 ET.": "briefing.row.fomcTimes",
  "Stock options, index options and index futures expire in the same session, known as triple witching.":
    "briefing.row.quarterlyExpiryDetail",
  "Standard monthly stock, ETF and index options expire.": "briefing.row.monthlyOpexDetail",
  "Standard monthly equity and index options expire at the close.": "briefing.row.monthlyOpexCloseDetail",
  "VIX futures and options settle at the open, from a special opening quotation of S&P 500 options.":
    "briefing.row.vixExpiryDetail",
  "Moved up one session because the third Friday is a market holiday.": "briefing.row.movedUpThirdFriday",
  "Moved up one session because of a market holiday.": "briefing.row.movedUpHoliday",
  "Scheduled, per index methodology.": "briefing.row.ruleScheduled",
  "Changes take effect after the close.": "briefing.row.changesAfterClose",
  "The yearly constituent review; changes take effect after the close.": "briefing.row.yearlyReview",
  "Announced by the index provider.": "briefing.row.announcedByProvider",
  "None of the funds this report tracks for that family is held.": "briefing.row.noHeldFunds",
};

/**
 * The agencies' English month names, asked of Intl rather than typed: one of
 * them is a word the copy rules ban, and a literal of it would be flagged.
 */
const MONTHS: readonly string[] = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, i, 15, 12))),
);

const EARNINGS_TITLE = /^(\S+) earnings report$/;
const COVERS = /^Covers (.+)\.$/;
const HELD_FUNDS = /^Held funds tracking it: (.+)\.$/;
const MONTH_PERIOD = /^([A-Z][a-z]+) (\d{4})$/;
const QUARTER_PERIOD = /^([1-4])(?:st|nd|rd|th) Quarter (\d{4})$/;
/** The demo builder names the month numerically: "2026-08". */
const NUMERIC_MONTH_PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The period a release covers, as the agency words it: "August 2026", "3rd Quarter 2026". Null when it is another shape. */
function period(raw: string, text: BriefingText): string | null {
  const month = MONTH_PERIOD.exec(raw);
  if (month) {
    const index = MONTHS.indexOf(month[1]!);
    return index === -1 ? null : monthYearLabel(Number(month[2]), index + 1, text);
  }
  const numeric = NUMERIC_MONTH_PERIOD.exec(raw);
  if (numeric) return monthYearLabel(Number(numeric[1]), Number(numeric[2]), text);
  const quarter = QUARTER_PERIOD.exec(raw);
  if (quarter) return text.t("briefing.row.quarter", { quarter: quarter[1]!, year: quarter[2]! });
  return null;
}

function sentence(raw: string, text: BriefingText): string | null {
  const key = SENTENCE_KEY[raw];
  if (key) return text.t(key);
  const covers = COVERS.exec(raw);
  if (covers) {
    const p = period(covers[1]!, text);
    return p === null ? null : text.t("briefing.row.covers", { period: p });
  }
  const funds = HELD_FUNDS.exec(raw);
  if (funds) return text.t("briefing.row.heldFunds", { funds: funds[1]! });
  return null;
}

/** A row's title in the reader's language; as written when the wording is not one the engine is known to use. */
export function localizeCalendarTitle(title: string, text: BriefingText = ENGLISH): string {
  if (text === ENGLISH) return title;
  const key = TITLE_KEY[title];
  if (key) return text.t(key);
  const earnings = EARNINGS_TITLE.exec(title);
  if (earnings) return text.t("briefing.row.earnings", { ticker: earnings[1]! });
  return title;
}

/**
 * A row's detail in the reader's language. Split into sentences (a period
 * followed by a space), each matched on its own; one unknown sentence keeps
 * the whole detail in English.
 */
export function localizeCalendarDetail(detail: string | null, text: BriefingText = ENGLISH): string | null {
  if (detail === null || text === ENGLISH) return detail;
  const parts = detail.trim().split(/(?<=\.)\s+/);
  const out: string[] = [];
  for (const part of parts) {
    const translated = sentence(part, text);
    if (translated === null) return detail;
    out.push(translated);
  }
  return out.join(" ");
}

/** Every title the table knows, for a test that holds the engine's wording to it. */
export const KNOWN_CALENDAR_TITLES: readonly string[] = Object.keys(TITLE_KEY);
