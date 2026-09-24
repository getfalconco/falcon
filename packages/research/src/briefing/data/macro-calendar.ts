/**
 * The curated macro calendar: scheduled US releases, FOMC decisions and
 * provider-announced index reviews, compiled by hand from the official pages
 * listed in `sources`.
 *
 * WHY a shipped file and not a live fetch: these schedules live on agency web
 * pages with no stable API, several of them refuse automated reads, and the
 * briefing must print today's calendar even when every provider is down. A
 * date that is wrong is worse than a date that is missing, so nothing here is
 * derived, remembered or guessed: every row was read off the page named in its
 * `source` on the `retrieved_at` date. A series whose official schedule could
 * not be read is absent, not approximated. On 2026-09-21 that was: the ISM PMI
 * release calendar (ismworld.org redirects automated reads to a login page) and
 * DOL weekly claims (DOL publishes a "every Thursday 08:30" rule plus holiday
 * exceptions, not a dated schedule, and a rule expanded into dates is a
 * synthesized date).
 *
 * WHY the app prints `coverage.until`: agencies reschedule. The late-2025
 * government shutdown moved nearly every BLS release, and the 2026 dates below
 * already carry that shift. A file like this goes stale silently, so the report
 * says how far the calendar reaches, and `per_source_until` records how far
 * each publisher had published when the file was compiled (the end of its
 * schedule, not the last row that happens to be here). `coverage.until` is the
 * minimum over the sources that carry importance-3 rows: past that date an
 * empty day could be a missing CPI, and the app must not imply otherwise.
 * Rows stop at `coverage.until` for every source for the same reason: a lone
 * 2027 FOMC row would make a 2027 day look covered when its CPI and jobs
 * report are unknown. The Fed page already lists 2027 and MSCI lists reviews
 * into 2028; they come in when BLS and BEA publish their 2027 schedules.
 *
 * WHY a run-time overlay exists (`mergeCalendarOverlay`): a rescheduled release
 * has to be corrected the same day, without waiting for a desktop build.
 *
 * TO REFRESH: re-fetch every URL in `sources`, re-read each series row by row
 * (do not patch single rows from memory), extend or correct `events` and
 * `index_events`, bump `compiled_at`, each `retrieved_at` and each
 * `per_source_until`, recompute `coverage.until`, then run
 * `macro-calendar.test.ts`: `validateMacroCalendar` checks ordering, weekdays,
 * source ids, hosts, the coverage minimum and the copy rules.
 *
 * Reading notes for the next refresh:
 *  - FOMC: the row is the second (statement) day of the two-day meeting. The
 *    meeting calendar page gives dates only; the 14:00 statement time and each
 *    14:30 press conference were read off the Board's monthly events calendar
 *    (`fed_events`), which is also why a press conference row exists only for
 *    meetings that calendar lists one for.
 *  - BLS: the per-release pages (cpi.htm, empsit.htm, ppi.htm, jolts.htm under
 *    the `bls` URL) and the 2026 year page were both read and agree.
 *  - BEA: /news/schedule shows upcoming rows only; /news/schedule/full confirmed
 *    nothing GDP or PCE related fell between 09-01 and the first row here.
 *  - University of Michigan: the schedule PDFs give dates and no clock time, so
 *    `time_et` is null rather than the customary 10:00.
 *  - MSCI publishes an "effective date"; the index row is the last session
 *    before it, because changes are implemented as of that session's close
 *    (August 2026: effective 09-01, implemented as of the close of 08-31).
 *  - FTSE Russell moved to two reconstitutions a year from 2026 (June and
 *    December); the December 2026 schedule was announced on 2026-09-01.
 *  - NYSE: the holiday and early-close table for 2026 to 2028 matches
 *    `tracker/calendar.ts` on every date, so `session_overrides` is empty. It is
 *    for ad-hoc closes the algorithm cannot know, not for restating the rule.
 */

import type { MacroCalendarFile } from "../types.js";

export const MACRO_CALENDAR: MacroCalendarFile = {
  schema_version: 1,
  compiled_at: "2026-09-21",
  coverage: { from: "2026-09-01", until: "2026-12-31" },
  per_source_until: {
    fed: "2028-01-26",
    fed_events: "2026-12-31",
    bls: "2026-12-31",
    bea: "2026-12-31",
    census: "2026-12-31",
    umich: "2027-12-31",
    msci: "2028-09-01",
    ftse_russell: "2026-12-11",
    nyse: "2028-12-31",
  },
  sources: [
    {
      id: "fed",
      name: "Federal Reserve FOMC meeting calendar",
      url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
      retrieved_at: "2026-09-21",
    },
    {
      id: "fed_events",
      name: "Federal Reserve Board events calendar",
      url: "https://www.federalreserve.gov/newsevents/calendar.htm",
      retrieved_at: "2026-09-21",
    },
    {
      id: "bls",
      name: "Bureau of Labor Statistics release schedule",
      url: "https://www.bls.gov/schedule/news_release/",
      retrieved_at: "2026-09-21",
    },
    {
      id: "bea",
      name: "Bureau of Economic Analysis release schedule",
      url: "https://www.bea.gov/news/schedule",
      retrieved_at: "2026-09-21",
    },
    {
      id: "census",
      name: "U.S. Census Bureau economic indicator calendar",
      url: "https://www.census.gov/economic-indicators/calendar-listview.html",
      retrieved_at: "2026-09-21",
    },
    {
      id: "umich",
      name: "University of Michigan Surveys of Consumers release dates",
      url: "https://data.sca.isr.umich.edu/fetchdoc.php?docid=75443",
      retrieved_at: "2026-09-21",
    },
    {
      id: "msci",
      name: "MSCI index review dates",
      url: "https://www.msci.com/eqb/pressreleases/archive/ir_dates.pdf",
      retrieved_at: "2026-09-21",
    },
    {
      id: "ftse_russell",
      name: "FTSE Russell reconstitution schedule",
      url: "https://www.lseg.com/en/ftse-russell/russell-reconstitution",
      retrieved_at: "2026-09-21",
    },
    {
      id: "nyse",
      name: "NYSE holidays and trading hours",
      url: "https://www.nyse.com/markets/hours-calendars",
      retrieved_at: "2026-09-21",
    },
  ],
  events: [
    // September 2026
    { date: "2026-09-01", time_et: "10:00", kind: "data", code: "JOLTS", title: "Job Openings and Labor Turnover", period: "July 2026", importance: 2, source: "bls" },
    { date: "2026-09-04", time_et: "08:30", kind: "data", code: "NFP", title: "Employment Situation (jobs report)", period: "August 2026", importance: 3, source: "bls" },
    { date: "2026-09-10", time_et: "08:30", kind: "data", code: "PPI", title: "Producer Price Index", period: "August 2026", importance: 2, source: "bls" },
    { date: "2026-09-11", time_et: "08:30", kind: "data", code: "CPI", title: "Consumer Price Index", period: "August 2026", importance: 3, source: "bls" },
    { date: "2026-09-11", time_et: null, kind: "data", code: "UMICH_PRELIM", title: "University of Michigan consumer sentiment (preliminary)", period: "September 2026", importance: 2, source: "umich" },
    { date: "2026-09-16", time_et: "08:30", kind: "data", code: "RETAIL", title: "Advance Monthly Retail Sales", period: "August 2026", importance: 2, source: "census" },
    { date: "2026-09-16", time_et: "14:00", kind: "fomc", code: "FOMC", title: "FOMC rate decision and projections", importance: 3, source: "fed" },
    { date: "2026-09-16", time_et: "14:30", kind: "fomc", code: "FOMC_PRESSER", title: "Fed Chair press conference", importance: 2, source: "fed_events" },
    { date: "2026-09-17", time_et: "08:30", kind: "data", code: "HOUSING_STARTS", title: "New Residential Construction (housing starts)", period: "August 2026", importance: 1, source: "census" },
    { date: "2026-09-24", time_et: "10:00", kind: "data", code: "NEW_HOME_SALES", title: "New Home Sales", period: "August 2026", importance: 1, source: "census" },
    { date: "2026-09-25", time_et: "08:30", kind: "data", code: "DURABLES", title: "Advance Report on Durable Goods", period: "August 2026", importance: 2, source: "census" },
    { date: "2026-09-25", time_et: null, kind: "data", code: "UMICH_FINAL", title: "University of Michigan consumer sentiment (final)", period: "September 2026", importance: 1, source: "umich" },
    { date: "2026-09-29", time_et: "10:00", kind: "data", code: "JOLTS", title: "Job Openings and Labor Turnover", period: "August 2026", importance: 2, source: "bls" },
    { date: "2026-09-30", time_et: "08:30", kind: "data", code: "GDP", title: "GDP (third estimate)", period: "2nd Quarter 2026", importance: 2, source: "bea" },
    { date: "2026-09-30", time_et: "08:30", kind: "data", code: "PCE", title: "Personal Income and Outlays (PCE inflation)", period: "August 2026", importance: 3, source: "bea" },

    // October 2026
    { date: "2026-10-02", time_et: "08:30", kind: "data", code: "NFP", title: "Employment Situation (jobs report)", period: "September 2026", importance: 3, source: "bls" },
    { date: "2026-10-09", time_et: null, kind: "data", code: "UMICH_PRELIM", title: "University of Michigan consumer sentiment (preliminary)", period: "October 2026", importance: 2, source: "umich" },
    { date: "2026-10-14", time_et: "08:30", kind: "data", code: "CPI", title: "Consumer Price Index", period: "September 2026", importance: 3, source: "bls" },
    { date: "2026-10-15", time_et: "08:30", kind: "data", code: "PPI", title: "Producer Price Index", period: "September 2026", importance: 2, source: "bls" },
    { date: "2026-10-15", time_et: "08:30", kind: "data", code: "RETAIL", title: "Advance Monthly Retail Sales", period: "September 2026", importance: 2, source: "census" },
    { date: "2026-10-20", time_et: "08:30", kind: "data", code: "HOUSING_STARTS", title: "New Residential Construction (housing starts)", period: "September 2026", importance: 1, source: "census" },
    { date: "2026-10-23", time_et: null, kind: "data", code: "UMICH_FINAL", title: "University of Michigan consumer sentiment (final)", period: "October 2026", importance: 1, source: "umich" },
    { date: "2026-10-27", time_et: "08:30", kind: "data", code: "DURABLES", title: "Advance Report on Durable Goods", period: "September 2026", importance: 2, source: "census" },
    { date: "2026-10-27", time_et: "10:00", kind: "data", code: "NEW_HOME_SALES", title: "New Home Sales", period: "September 2026", importance: 1, source: "census" },
    { date: "2026-10-28", time_et: "14:00", kind: "fomc", code: "FOMC", title: "FOMC rate decision", importance: 3, source: "fed" },
    { date: "2026-10-28", time_et: "14:30", kind: "fomc", code: "FOMC_PRESSER", title: "Fed Chair press conference", importance: 2, source: "fed_events" },
    { date: "2026-10-29", time_et: "08:30", kind: "data", code: "GDP", title: "GDP (advance estimate)", period: "3rd Quarter 2026", importance: 3, source: "bea" },
    { date: "2026-10-29", time_et: "08:30", kind: "data", code: "PCE", title: "Personal Income and Outlays (PCE inflation)", period: "September 2026", importance: 3, source: "bea" },

    // November 2026
    { date: "2026-11-03", time_et: "10:00", kind: "data", code: "JOLTS", title: "Job Openings and Labor Turnover", period: "September 2026", importance: 2, source: "bls" },
    { date: "2026-11-06", time_et: "08:30", kind: "data", code: "NFP", title: "Employment Situation (jobs report)", period: "October 2026", importance: 3, source: "bls" },
    { date: "2026-11-06", time_et: null, kind: "data", code: "UMICH_PRELIM", title: "University of Michigan consumer sentiment (preliminary)", period: "November 2026", importance: 2, source: "umich" },
    { date: "2026-11-10", time_et: "08:30", kind: "data", code: "CPI", title: "Consumer Price Index", period: "October 2026", importance: 3, source: "bls" },
    { date: "2026-11-13", time_et: "08:30", kind: "data", code: "PPI", title: "Producer Price Index", period: "October 2026", importance: 2, source: "bls" },
    { date: "2026-11-17", time_et: "08:30", kind: "data", code: "RETAIL", title: "Advance Monthly Retail Sales", period: "October 2026", importance: 2, source: "census" },
    { date: "2026-11-18", time_et: "08:30", kind: "data", code: "HOUSING_STARTS", title: "New Residential Construction (housing starts)", period: "October 2026", importance: 1, source: "census" },
    { date: "2026-11-20", time_et: null, kind: "data", code: "UMICH_FINAL", title: "University of Michigan consumer sentiment (final)", period: "November 2026", importance: 1, source: "umich" },
    { date: "2026-11-25", time_et: "08:30", kind: "data", code: "DURABLES", title: "Advance Report on Durable Goods", period: "October 2026", importance: 2, source: "census" },
    { date: "2026-11-25", time_et: "08:30", kind: "data", code: "GDP", title: "GDP (second estimate)", period: "3rd Quarter 2026", importance: 2, source: "bea" },
    { date: "2026-11-25", time_et: "08:30", kind: "data", code: "PCE", title: "Personal Income and Outlays (PCE inflation)", period: "October 2026", importance: 3, source: "bea" },
    { date: "2026-11-25", time_et: "10:00", kind: "data", code: "NEW_HOME_SALES", title: "New Home Sales", period: "October 2026", importance: 1, source: "census" },

    // December 2026
    { date: "2026-12-01", time_et: "10:00", kind: "data", code: "JOLTS", title: "Job Openings and Labor Turnover", period: "October 2026", importance: 2, source: "bls" },
    { date: "2026-12-04", time_et: "08:30", kind: "data", code: "NFP", title: "Employment Situation (jobs report)", period: "November 2026", importance: 3, source: "bls" },
    { date: "2026-12-04", time_et: null, kind: "data", code: "UMICH_PRELIM", title: "University of Michigan consumer sentiment (preliminary)", period: "December 2026", importance: 2, source: "umich" },
    { date: "2026-12-09", time_et: "14:00", kind: "fomc", code: "FOMC", title: "FOMC rate decision and projections", importance: 3, source: "fed" },
    { date: "2026-12-09", time_et: "14:30", kind: "fomc", code: "FOMC_PRESSER", title: "Fed Chair press conference", importance: 2, source: "fed_events" },
    { date: "2026-12-10", time_et: "08:30", kind: "data", code: "CPI", title: "Consumer Price Index", period: "November 2026", importance: 3, source: "bls" },
    { date: "2026-12-15", time_et: "08:30", kind: "data", code: "PPI", title: "Producer Price Index", period: "November 2026", importance: 2, source: "bls" },
    { date: "2026-12-16", time_et: "08:30", kind: "data", code: "RETAIL", title: "Advance Monthly Retail Sales", period: "November 2026", importance: 2, source: "census" },
    { date: "2026-12-17", time_et: "08:30", kind: "data", code: "HOUSING_STARTS", title: "New Residential Construction (housing starts)", period: "November 2026", importance: 1, source: "census" },
    { date: "2026-12-18", time_et: null, kind: "data", code: "UMICH_FINAL", title: "University of Michigan consumer sentiment (final)", period: "December 2026", importance: 1, source: "umich" },
    { date: "2026-12-23", time_et: "08:30", kind: "data", code: "DURABLES", title: "Advance Report on Durable Goods", period: "November 2026", importance: 2, source: "census" },
    { date: "2026-12-23", time_et: "08:30", kind: "data", code: "GDP", title: "GDP (third estimate)", period: "3rd Quarter 2026", importance: 2, source: "bea" },
    { date: "2026-12-23", time_et: "08:30", kind: "data", code: "PCE", title: "Personal Income and Outlays (PCE inflation)", period: "November 2026", importance: 3, source: "bea" },
    { date: "2026-12-23", time_et: "10:00", kind: "data", code: "NEW_HOME_SALES", title: "New Home Sales", period: "November 2026", importance: 1, source: "census" },
  ],
  // Titles are noun phrases, like the rule-derived ones ("S&P quarterly index
  // rebalance"): the narrative template lists them as "the calendar has X and
  // Y", and the event detail already says the change lands after the close.
  index_events: [
    // November 2026 index review: announced 11-11, effective date 12-01.
    { date: "2026-11-30", family: "msci", title: "MSCI quarterly index review", source: "msci" },
    // December 2026 reconstitution: rank day 10-30, reconstituted indexes open 12-14.
    { date: "2026-12-11", family: "russell", title: "Russell index reconstitution", source: "ftse_russell" },
  ],
  session_overrides: [],
};
