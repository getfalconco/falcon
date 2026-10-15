/**
 * EDGAR acceptance stamps read as instants.
 *
 * The submissions index (data.sec.gov/submissions/CIK##########.json) writes
 * `acceptanceDateTime` as ISO with a "Z". Which clock is behind it depends on
 * when SEC last rebuilt that company's file, not on the company, the filing
 * agent, the form or the filing's age:
 *
 *   - entries added since the file's last nightly rebuild (the current EDGAR
 *     filing day) are the true UTC instant;
 *   - SEC rebuilds a file the night after it changes (a filing, and now and
 *     then a change to the company's record). Since a change on SEC's side
 *     around 2026-10-03, that rebuild writes every entry shifted: the true
 *     instant plus New York's offset (New York's wall clock plus 8 hours in
 *     daylight time, plus 10 in winter);
 *   - a file not rebuilt since then still carries its older entries as the
 *     true instant.
 *
 * So one file uses one clock for all of its older entries. Checked on
 * 2026-10-15 for 44 companies against each filing's "Accepted" line on its
 * -index.htm page (New York wall time, 249 stamps, all read right), and for
 * some 550 random files by their own entries: every file with an entry
 * dated from 2026-10-05 up to the day before the read was shifted; every
 * file whose newest older entry was dated 2026-10-02 or earlier was true,
 * but for 4 rebuilt without a new filing.
 * Copies of the index kept on 2026-08-23..25 carry the true instant for the
 * same entries that are shifted now. Examples (stamp, then Accepted):
 *
 *   NVDA 8-K   0001045810-26-000078  2026-09-03T16:03:56Z  08:03:56 EDT  (shifted, +4h)
 *   NVDA 8-K   0001045810-23-000039  2023-03-09T02:12:15Z  2023-03-08 16:12:15 EST  (shifted, +5h)
 *   AAPL 10-Q  0000320193-26-000020  2026-07-31T14:01:02Z  06:01:02 EDT  (shifted; its 0001140361 and 0002100119 entries alike)
 *   NFLX 8-K   0001065280-26-000214  2026-07-30T20:05:50Z  16:05:50 EDT  (true; newest older entry 10-02)
 *   TXN  8-K   0001193125-23-070157  2023-03-14T20:14:52Z  16:14:52 EDT  (true; newest older entry 09-21)
 *   DRCT 8-K   0001880613-26-000115  2026-10-03T00:03:25Z  10-02 16:03:25 EDT  (shifted: rebuilt with no new filing)
 *   JPM  424B2 0001918704-26-031596  2026-10-15T19:14:31Z  15:14:31 EDT  (current day, true, in a shifted file)
 *
 * A company flips from true to shifted the night after its next filing, so
 * the clock is read from each read of the file (`edgarIndexConvention`),
 * never kept per company. The file says it by its entries: for most forms
 * EDGAR dates a filing accepted after 17:30 New York the next business day,
 * so of the two readings of a stamp often only one agrees with its filing
 * date (a 16:21 release read as true lands at 20:21, which would have been
 * dated the next day; a 06:30 one read as shifted lands at 02:30, when EDGAR
 * is closed). When too few entries say, an entry dated since the change
 * (and before the current day) means the file was rebuilt since.
 *
 * Before the change (2026-08) the current day's entries were New York's wall
 * clock and the rebuilt ones true; nothing reads an index that old anymore.
 *
 * The midnight window: from 00:00 to about 00:25 New York the files of the
 * previous day are not rebuilt yet, so that day's entries still carry the
 * true instant; after the rebuild they are shifted. An entry dated New York's
 * previous day and read before 00:45 is therefore ambiguous (in a file whose
 * older entries are still true, it is true either way). It is settled by the
 * readings that are possible (not after the fetch) and inside EDGAR's hours;
 * when both still are, by the fetch's side of the expected rebuild. A
 * day-level cache of an index read in this window should expire soon
 * (`inEdgarRebuildWindow`).
 *
 * Records stored without the fetch time (SEC's stamp as written, before
 * `acceptedAtUtc`) were nearly all read before the change or on their own
 * filing day, so they are taken as true unless only the other reading falls
 * inside EDGAR's hours. Readers re-read them on their next poll.
 *
 * Pure: no fs, no network, no clock (the fetch time is a parameter).
 */

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const HOUR_MS = 3_600_000;
/** EDGAR's filing hours, New York minutes past midnight (06:00 to 22:00, a few minutes' grace). */
const EDGAR_OPEN_MIN = 6 * 60;
const EDGAR_CLOSE_MIN = 22 * 60 + 5;
/** SEC's nightly rebuild of the submissions index, New York minutes past midnight (as observed). */
const EDGAR_REBUILD_MIN = 25;
/** Until this New York minute an index read may or may not be rebuilt yet. */
const EDGAR_REBUILD_WINDOW_MIN = 45;
/** Clock skew allowed before a reading counts as after the fetch. */
const FUTURE_GRACE_MS = 5 * 60_000;
/** The first New York day whose nightly rebuild may write a file shifted (files rebuilt after 2026-10-02 were). */
const SHIFTED_REBUILDS_FROM = "2026-10-03";

function nyParts(ms: number): { ymd: string; minutes: number; seconds: number; wallMs: number } {
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const y = Number(p.year);
  const mo = Number(p.month);
  const d = Number(p.day);
  const h = Number(p.hour);
  const mi = Number(p.minute);
  const s = Number(p.second);
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    minutes: h * 60 + mi,
    seconds: s,
    wallMs: Date.UTC(y, mo - 1, d, h, mi, s),
  };
}

/** New York's offset from UTC at an instant, in ms (-4h in daylight time, -5h in winter). */
export function nyOffsetMs(ms: number): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return nyParts(whole).wallMs - whole;
}

function addYmdDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function inEdgarHours(ms: number): boolean {
  const m = nyParts(ms).minutes;
  return m >= EDGAR_OPEN_MIN && m <= EDGAR_CLOSE_MIN;
}

/** The true instant of a shifted stamp: the stamp less New York's offset at that instant. */
function unshift(stampMs: number): number {
  // Daylight time first (stamp - 4h), then winter (stamp - 5h): the one whose own offset agrees.
  for (const hours of [4, 5]) {
    const t = stampMs - hours * HOUR_MS;
    if (nyOffsetMs(t) === -hours * HOUR_MS) return t;
  }
  return stampMs + nyOffsetMs(stampMs - 4 * HOUR_MS);
}

export type EdgarStampContext = {
  /** The entry's `filingDate` ("YYYY-MM-DD"). */
  filingDate?: string | null;
  /** When the submissions index was read (epoch ms). */
  fetchedAtMs?: number | null;
  /** How the whole index file carries its older entries, from `edgarIndexConvention` on the same read. */
  convention?: EdgarIndexConvention | null;
};

/**
 * How one read of a submissions file carries its older (not current day) entries:
 *   "shifted"  New York's offset added a second time (rebuilt since 2026-10-03)
 *   "utc"      the true UTC instant (not rebuilt since)
 */
export type EdgarIndexConvention = "utc" | "shifted";

/** Section 16 forms and Form 144 keep the acceptance day as their filing date until 22:00, so they seldom say which clock. */
const SAME_DAY_FORMS = /^(3|4|5|144)(\/A)?$/;
/** EDGAR dates a filing accepted after 17:30 New York (or on a weekend) the next business day. */
const FILING_CUTOFF_MIN = 17 * 60 + 30;
/** One side must be at least this many entries, and the other at most this share of it. */
const CONVENTION_MIN = 3;
const CONVENTION_NOISE = 0.1;

/** Whether an acceptance at `ms` could carry `filingDate` under EDGAR's filing-date rule. */
function fitsFilingDate(ms: number, filingDate: string): boolean {
  if (!inEdgarHours(ms)) return false;
  const at = nyParts(ms);
  const dow = new Date(`${at.ymd}T12:00:00Z`).getUTCDay();
  const weekday = dow !== 0 && dow !== 6;
  if (weekday && at.minutes <= FILING_CUTOFF_MIN) return filingDate === at.ymd;
  // The next business day: a weekend or a holiday may sit between.
  return filingDate > at.ymd && filingDate <= addYmdDays(at.ymd, 4);
}

/** New York midnight to the second: the date-only stamps EDGAR kept until 2002. */
function atNyMidnight(ms: number): boolean {
  const at = nyParts(ms);
  return at.minutes === 0 && at.seconds === 0;
}

/**
 * The clock one read of a submissions file uses for its older entries. First
 * by the entries themselves: each one whose form follows the 17:30 filing-date
 * rule and whose two readings disagree with each other on it votes for the
 * one that agrees; the side with the votes wins when the other is noise.
 * Failing that, the file was rebuilt since SEC's change (shifted) when it
 * holds an older entry dated since then, and not (true) otherwise. Entries of
 * the current filing day (true in every file) and of the midnight window are
 * left out when the fetch time is known. Null for a file with no entries.
 */
export function edgarIndexConvention(
  recent: {
    form?: ReadonlyArray<string | null | undefined>;
    filingDate?: ReadonlyArray<string | null | undefined>;
    acceptanceDateTime?: ReadonlyArray<string | null | undefined>;
  } | null | undefined,
  fetchedAtMs?: number | null,
): EdgarIndexConvention | null {
  const stamps = recent?.acceptanceDateTime ?? [];
  const dates = recent?.filingDate ?? [];
  const forms = recent?.form ?? [];
  const fetched = finiteMs(fetchedAtMs);
  let utc = 0;
  let shifted = 0;
  let older = 0;
  let rebuiltSince = false;
  for (let i = 0; i < stamps.length; i++) {
    const filingDate = dates[i];
    const stamp = stamps[i];
    if (!stamp || !filingDate || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) continue;
    if (fetched !== null && edgarStampState(filingDate, fetched) !== "old") continue;
    const ms = Date.parse(stamp);
    if (!Number.isFinite(ms)) continue;
    older++;
    if (filingDate >= SHIFTED_REBUILDS_FROM) rebuiltSince = true;
    const form = forms[i];
    if (typeof form === "string" && SAME_DAY_FORMS.test(form.trim().toUpperCase())) continue;
    const old = unshift(ms);
    if (atNyMidnight(ms) || atNyMidnight(old)) continue;
    const asUtc = fitsFilingDate(ms, filingDate);
    const asShifted = fitsFilingDate(old, filingDate);
    if (asUtc && !asShifted) utc++;
    else if (asShifted && !asUtc) shifted++;
  }
  if (shifted >= CONVENTION_MIN && utc <= shifted * CONVENTION_NOISE) return "shifted";
  if (utc >= CONVENTION_MIN && shifted <= utc * CONVENTION_NOISE) return "utc";
  if (older === 0) return null;
  return rebuiltSince ? "shifted" : "utc";
}

function finiteMs(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

/**
 * Whether an index read at `fetchedAtMs` may not be rebuilt yet: New York's
 * 00:00 to 00:45. A day-level cache of such a read should expire soon.
 */
export function inEdgarRebuildWindow(fetchedAtMs: number): boolean {
  return Number.isFinite(fetchedAtMs) && nyParts(fetchedAtMs).minutes < EDGAR_REBUILD_WINDOW_MIN;
}

/**
 * How the index read at `fetchedAtMs` carries an entry of `filingDate`:
 *   "current"    the true UTC instant (the current filing day, or a later
 *                one: a filing accepted after 17:30 is dated the next
 *                business day);
 *   "old"        as the file carries its older entries (`edgarIndexConvention`);
 *   "ambiguous"  New York's previous day read in the midnight window, before
 *                or after the rebuild.
 * Null when either is unknown.
 */
export function edgarStampState(
  filingDate: string | null | undefined,
  fetchedAtMs: number | null | undefined,
): "current" | "old" | "ambiguous" | null {
  if (!filingDate || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) return null;
  const fetched = finiteMs(fetchedAtMs);
  if (fetched === null) return null;
  const at = nyParts(fetched);
  if (filingDate >= at.ymd) return "current";
  if (at.minutes < EDGAR_REBUILD_WINDOW_MIN && filingDate === addYmdDays(at.ymd, -1)) return "ambiguous";
  return "old";
}

/**
 * Whether the index read at `fetchedAtMs` certainly carries an entry of
 * `filingDate` as the current day's true UTC instant (false for an old or an
 * ambiguous entry). Null when either is unknown.
 */
export function edgarStampIsCurrent(filingDate: string | null | undefined, fetchedAtMs: number | null | undefined): boolean | null {
  const state = edgarStampState(filingDate, fetchedAtMs);
  return state === null ? null : state === "current";
}

/**
 * The instant an EDGAR `acceptanceDateTime` stands for (epoch ms), or null
 * when it does not parse. With the fetch time and the file's convention (both
 * from the same read) the answer follows the file; with the fetch time alone
 * an older entry is taken as shifted (most files are now); with neither, as
 * the true instant (a stored record, see the note above).
 */
export function edgarAcceptanceMs(stamp: string | null | undefined, ctx: EdgarStampContext = {}): number | null {
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) return null;
  const old = unshift(ms);
  const fetched = finiteMs(ctx.fetchedAtMs);
  const convention = ctx.convention ?? null;
  // A filing accepted after the index was read is not in it.
  const possible = (t: number) => fetched === null || t <= fetched + FUTURE_GRACE_MS;
  let state = edgarStampState(ctx.filingDate, fetched);
  // A file whose older entries are still true has not been rebuilt last night either.
  if (state === "ambiguous" && convention === "utc") state = "current";
  if (state === "ambiguous") {
    const both = [ms, old].filter(possible);
    if (both.length < 2) return both[0] ?? old;
    const open = both.filter(inEdgarHours);
    if (open.length === 1) return open[0]!;
    // Still both: the side of the rebuild the fetch fell on.
    return nyParts(fetched!).minutes < EDGAR_REBUILD_MIN ? ms : old;
  }
  if (state === "current") return possible(ms) || !possible(old) ? ms : old;
  if (state === "old" && convention) return convention === "utc" ? ms : old;
  // Without the file's word: the default, unless only the other reading is inside EDGAR's hours.
  const pick = state === "old" ? old : ms;
  const other = pick === ms ? old : ms;
  if (!possible(pick) && possible(other)) return other;
  if (!inEdgarHours(pick) && inEdgarHours(other)) return other;
  return pick;
}

/** `edgarAcceptanceMs` as an ISO string, for records that store the instant. */
export function edgarAcceptanceIso(stamp: string | null | undefined, ctx: EdgarStampContext = {}): string | null {
  const ms = edgarAcceptanceMs(stamp, ctx);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * A filing record's acceptance instant. `acceptedAtUtc: true` marks an
 * `acceptedAt` already read with `edgarAcceptanceIso` at fetch time (the true
 * instant); without it `acceptedAt` is SEC's stamp as written (a record kept
 * from before the fix), read without the fetch time: as the true instant
 * unless only the shifted reading is inside EDGAR's hours.
 */
export function filingAcceptedMs(record: {
  acceptedAt?: string | null;
  acceptedAtUtc?: boolean;
  filedAt?: string | null;
}): number | null {
  if (!record.acceptedAt) return null;
  if (record.acceptedAtUtc === true) {
    const ms = Date.parse(record.acceptedAt);
    return Number.isFinite(ms) ? ms : null;
  }
  return edgarAcceptanceMs(record.acceptedAt, { filingDate: record.filedAt ?? null });
}
