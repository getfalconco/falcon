/**
 * Forward studies: pre-registered hypotheses tested only on events that had
 * not happened when they were written. The Sightings run tags every
 * qualifying event in the forecast ledger (public.ripple_forecasts,
 * covariates.study), featured or not and also when no card could be built;
 * scripts/forward-study.ts reads the ledger and measures the running
 * estimate. No schema change: the tag and the event facts ride in the
 * covariates JSON.
 *
 * events-v2-nt10k (data/preregistration/events-v2-nt10k.json): NT 10-K
 * notices only, from 2026-11-15, beta x SPY over 20 sessions from the first
 * open after acceptance, expected negative, the events-v1 / F7 pass bar.
 * While it is open, NT 10-K cards are capped at Watch whatever the evidence
 * registry says.
 *
 * Pure: no fs, no network, no clock (callers pass `nowMs`).
 */

import type { DetectorEvent } from "../detectors/types.ts";
import type { ForecastRow } from "../ledger.ts";
import { nyOffsetMs } from "../edgar-time.ts";
import { entryIndex, eventStudy, measureEvent, nyseSessions, reactionDayIndex, sessionCloseMs, type PriceSeries, type StudySummary } from "./abnormal.ts";
import { dedupeByIssuer, passesBar, PASS_BAR, type BarRead } from "./filing-events.ts";
import { median } from "./stats.ts";

export type ForwardStudy = {
  id: string;
  preregistration: string;
  eventType: string;
  /** Form types that count, exact (after trimming). */
  forms: readonly string[];
  /** First New York acceptance date that counts (inclusive). */
  startDate: string;
  windowDays: number;
  expectedSign: 1 | -1;
  minN: number;
  /** Review at this date when n has not reached minN first. */
  reviewBy: string;
  /** Last acceptance date in the sample when the review is at reviewBy. */
  lastEventDateAtReviewBy: string;
  /** "open" caps the study's cards at Watch; "passed" / "failed" after the review. */
  status: "open" | "passed" | "failed";
};

/** data/preregistration/events-v2-nt10k.json, mirrored (a test keeps the two equal). */
export const NT10K_STUDY: ForwardStudy = {
  id: "events-v2-nt10k",
  preregistration: "data/preregistration/events-v2-nt10k.json",
  eventType: "distress_nt",
  forms: ["NT 10-K"],
  startDate: "2026-11-15",
  windowDays: 20,
  expectedSign: -1,
  minN: 100,
  reviewBy: "2027-12-31",
  lastEventDateAtReviewBy: "2027-11-30",
  status: "open",
};

export const FORWARD_STUDIES: readonly ForwardStudy[] = [NT10K_STUDY];

/** New York calendar date of an instant, YYYY-MM-DD; null when unreadable. Pure. */
export function nyDateOf(iso: string | null | undefined): string | null {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + nyOffsetMs(ms)).toISOString().slice(0, 10);
}

/**
 * The forward study a detector event counts toward, or null: same event
 * type, a listed form exactly, a ticker, and accepted (New York date) on or
 * after the study's start. Pure.
 */
export function forwardStudyOf(
  de: Pick<DetectorEvent, "eventType" | "form" | "acceptedAt" | "ticker">,
  studies: readonly ForwardStudy[] = FORWARD_STUDIES,
): ForwardStudy | null {
  if (!de.ticker) return null;
  const date = nyDateOf(de.acceptedAt);
  if (!date) return null;
  return studies.find((s) => s.eventType === de.eventType && s.forms.includes((de.form ?? "").trim()) && date >= s.startDate) ?? null;
}

/** The watch-only reason an open study puts on its events' cards; null once it is decided. Pure. */
export function studyWatchReason(s: ForwardStudy | null): string | null {
  return s && s.status === "open" ? `under forward test ${s.id}: no measured effect yet` : null;
}

/** What the ledger keeps about a study event (in covariates), so the runner needs nothing else. Pure. */
export function studyCovariates(de: DetectorEvent, s: ForwardStudy): Record<string, unknown> {
  const sig = de.facts?.significantChangeExpected;
  return {
    study: s.id,
    studyForm: de.form,
    studyCik: de.cik,
    studyAccession: de.accession,
    studyAcceptedAt: de.acceptedAt,
    studyWindowDays: s.windowDays,
    studyExpectedSign: s.expectedSign,
    studySignificantChange: typeof sig === "boolean" ? sig : null,
  };
}

export type StudyTagContext = {
  /** The card id an event's card has (or would have). */
  cardIdOf: (de: DetectorEvent) => string;
  modelVersion: (de: DetectorEvent) => string;
  /** Why an event has no card this run, when the pipeline knows. */
  noCardWhy?: ReadonlyMap<string, string>;
  studies?: readonly ForwardStudy[];
};

export type StudyTagResult = {
  ledger: ForecastRow[];
  /** Per study: the events tagged this run (ids), and how many had no card row. */
  tagged: Record<string, { events: string[]; withoutCard: number }>;
  /** Per study: events of its type and form accepted before its start (seen, not tagged: they do not count). */
  beforeStart: Record<string, number>;
};

/**
 * Tags the ledger for the forward studies: every row of a study event gets
 * the study covariates, and a study event with no row (no card was built for
 * it) gets one of its own (Watch, unpublished, no card hash, the study's
 * window and sign). Returns a new ledger; rows of other events are unchanged.
 * Pure.
 */
export function tagStudyRows(ledger: readonly ForecastRow[], detectorEvents: readonly DetectorEvent[], ctx: StudyTagContext): StudyTagResult {
  const studies = ctx.studies ?? FORWARD_STUDIES;
  const byEvent = new Map<string, { de: DetectorEvent; s: ForwardStudy }>();
  const beforeStart: Record<string, number> = {};
  const early = new Set<string>();
  for (const s of studies) beforeStart[s.id] = 0;
  for (const de of detectorEvents) {
    if (byEvent.has(de.id) || early.has(de.id)) continue;
    const s = forwardStudyOf(de, studies);
    if (s) byEvent.set(de.id, { de, s });
    else {
      const date = nyDateOf(de.acceptedAt);
      const sameKind = studies.find((x) => x.eventType === de.eventType && x.forms.includes((de.form ?? "").trim()) && !!de.ticker && !!date && date < x.startDate);
      if (sameKind) {
        early.add(de.id);
        beforeStart[sameKind.id]!++;
      }
    }
  }
  const tagged: StudyTagResult["tagged"] = {};
  for (const s of studies) tagged[s.id] = { events: [], withoutCard: 0 };
  const seen = new Set<string>();
  const out: ForecastRow[] = ledger.map((r) => {
    const x = byEvent.get(r.event_id);
    if (!x) return r;
    seen.add(r.event_id);
    return { ...r, covariates: { ...r.covariates, ...studyCovariates(x.de, x.s) } };
  });
  for (const [id, { de, s }] of byEvent) {
    tagged[s.id]!.events.push(id);
    if (seen.has(id)) continue;
    tagged[s.id]!.withoutCard++;
    out.push({
      event_id: de.id,
      card_id: ctx.cardIdOf(de),
      ticker: de.ticker!,
      tier: "watch",
      family: de.family,
      sign_pred: s.expectedSign,
      window_days: s.windowDays,
      covariates: { channel: "own_firm", relation: "self", eventType: de.eventType, eventSign: de.sign, noCard: ctx.noCardWhy?.get(de.id) ?? "no card built this run", ...studyCovariates(de, s) },
      model_version: ctx.modelVersion(de),
      card_sha256: null,
      published: false,
    });
  }
  return { ledger: out, tagged, beforeStart };
}

// ---------------------------------------------------------------------------
// Reading the ledger

/** A ledger row as the runner reads it. */
export type StudyLedgerRow = { event_id: string; ticker: string; created_at: string; published: boolean; covariates: Record<string, unknown> };

export type StudyEvent = {
  eventId: string;
  ticker: string;
  cik: string;
  accession: string;
  acceptedAt: string;
  /** New York acceptance date. */
  date: string;
  /** Whether any run featured its card. */
  published: boolean;
  significantChange: boolean | null;
  firstLoggedAt: string;
};

/**
 * The study's events from ledger rows: one per event id (the first logged
 * row, published if any row was), accepted on or after the start, then one
 * per issuer per 30 calendar days (events-v1 rule). Pure.
 */
export function studyEventsFromLedger(rows: readonly StudyLedgerRow[], s: ForwardStudy): { events: StudyEvent[]; duplicates: number; unreadable: number } {
  const by = new Map<string, StudyEvent>();
  let unreadable = 0;
  const sorted = [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const r of sorted) {
    const c = r.covariates ?? {};
    if (c.study !== s.id) continue;
    const prev = by.get(r.event_id);
    if (prev) {
      prev.published ||= r.published;
      continue;
    }
    const acceptedAt = typeof c.studyAcceptedAt === "string" ? c.studyAcceptedAt : null;
    const cik = typeof c.studyCik === "string" ? c.studyCik : null;
    const date = nyDateOf(acceptedAt);
    if (!acceptedAt || !cik || !date) {
      unreadable++;
      continue;
    }
    if (date < s.startDate) continue;
    by.set(r.event_id, {
      eventId: r.event_id,
      ticker: r.ticker,
      cik,
      accession: typeof c.studyAccession === "string" ? c.studyAccession : "",
      acceptedAt,
      date,
      published: r.published,
      significantChange: typeof c.studySignificantChange === "boolean" ? c.studySignificantChange : null,
      firstLoggedAt: String(r.created_at),
    });
  }
  const { kept, dropped } = dedupeByIssuer([...by.values()].map((e) => ({ ...e, issuer: e.cik })), 30);
  // Same date: acceptance order.
  const events = kept.map(({ issuer: _issuer, ...e }) => e).sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.eventId.localeCompare(b.eventId));
  return { events, duplicates: dropped, unreadable };
}

/**
 * Whether an event's window has closed by `nowMs`: the close of session
 * entry + windowDays - 1 is at or before now. Pure.
 */
export function windowClosed(acceptedAt: string, windowDays: number, nowMs: number): boolean {
  const ms = Date.parse(acceptedAt);
  const from = nyDateOf(acceptedAt);
  const to = nyDateOf(new Date(nowMs).toISOString());
  if (!Number.isFinite(ms) || !from || !to) return false;
  const sessions = nyseSessions(from, to);
  const entry = entryIndex(sessions, ms);
  if (entry === null) return false;
  const exit = entry + windowDays - 1;
  return exit < sessions.length && sessionCloseMs(sessions[exit]!) <= nowMs;
}

export type RunningCount = { events: number; duplicates: number; windowClosed: number };

/** The running n of a study from ledger rows (events logged, after de-duplication; how many have their window behind them). Pure. */
export function runningCount(rows: readonly StudyLedgerRow[], s: ForwardStudy, nowMs: number): RunningCount {
  const { events, duplicates } = studyEventsFromLedger(rows, s);
  return { events: events.length, duplicates, windowClosed: events.filter((e) => windowClosed(e.acceptedAt, s.windowDays, nowMs)).length };
}

/** One run-summary line for a study. Pure. */
export function studySummaryLine(s: ForwardStudy, thisRun: { events: number; withoutCard: number }, ledger: RunningCount | { error: string } | null): string {
  const head = `forward study ${s.id} (${s.forms.join(", ")} from ${s.startDate}, ${s.status}): ${thisRun.events} events tagged this run${thisRun.withoutCard ? ` (${thisRun.withoutCard} without a card)` : ""}`;
  const tail = `bar n >= ${s.minN} measured, review at n ${s.minN} or ${s.reviewBy}`;
  if (ledger === null) return `${head}; running n not read (no database); ${tail}`;
  if ("error" in ledger) return `${head}; running n unreadable (${ledger.error}); ${tail}`;
  return `${head}; running n ${ledger.events} in the ledger${ledger.duplicates ? ` (${ledger.duplicates} repeats within 30 days left out)` : ""}, ${ledger.windowClosed} past the ${s.windowDays}-session window; ${tail}`;
}

// ---------------------------------------------------------------------------
// Measuring (the events-v1 gate and primary column)

/** Daily bars from Yahoo's chart API (as printed: open, split-adjusted close, adjusted close, volume) and its split events. */
export type ChartBars = {
  dates: string[];
  open: number[];
  close: number[];
  adjClose: number[];
  volume: number[];
  splits: Array<{ date: string; ratio: number }>;
};

/** Yahoo chart JSON to bars (exchange dates, positive open and close only). Null when there is no result. Pure. */
export function parseChart(json: unknown): ChartBars | null {
  type Chart = {
    chart?: {
      result?: Array<{
        meta?: { gmtoffset?: number };
        timestamp?: number[];
        events?: { splits?: Record<string, { date: number; numerator: number; denominator: number }> };
        indicators?: { quote?: Array<{ open?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }>; adjclose?: Array<{ adjclose?: (number | null)[] }> };
      }>;
    };
  };
  const res = (json as Chart)?.chart?.result?.[0];
  if (!res) return null;
  const ts = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0];
  const adj = res.indicators?.adjclose?.[0]?.adjclose;
  const off = res.meta?.gmtoffset ?? -5 * 3600;
  const good = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  const out: ChartBars = { dates: [], open: [], close: [], adjClose: [], volume: [], splits: [] };
  for (let i = 0; i < ts.length; i++) {
    const o = q?.open?.[i];
    const c = q?.close?.[i];
    if (!good(o) || !good(c)) continue;
    const d = new Date((ts[i]! + off) * 1000).toISOString().slice(0, 10);
    if (out.dates[out.dates.length - 1] === d) continue;
    const a = adj?.[i];
    out.dates.push(d);
    out.open.push(o);
    out.close.push(c);
    out.adjClose.push(good(a) ? a : c);
    out.volume.push(q?.volume?.[i] ?? 0);
  }
  for (const sp of Object.values(res.events?.splits ?? {})) {
    if (sp.numerator > 0 && sp.denominator > 0) out.splits.push({ date: new Date((sp.date + off) * 1000).toISOString().slice(0, 10), ratio: sp.numerator / sp.denominator });
  }
  return out;
}

export type Aligned = PriceSeries & { raw: number[]; dv: number[] };

/** Bars on a session calendar: adjusted open and close (total return), the unadjusted close for the $5 gate, dollar volume. Missing days NaN. Pure. */
export function alignBars(b: ChartBars, sessions: readonly string[]): Aligned {
  const idx = new Map(sessions.map((d, i) => [d, i]));
  const n = sessions.length;
  const open = new Array<number>(n).fill(NaN);
  const close = new Array<number>(n).fill(NaN);
  const raw = new Array<number>(n).fill(NaN);
  const dv = new Array<number>(n).fill(NaN);
  const splits = [...b.splits].sort((x, y) => x.date.localeCompare(y.date));
  for (let k = 0; k < b.dates.length; k++) {
    const i = idx.get(b.dates[k]!);
    if (i === undefined) continue;
    const f = b.adjClose[k]! / b.close[k]!;
    open[i] = b.open[k]! * f;
    close[i] = b.adjClose[k]!;
    let ratio = 1;
    for (const s of splits) if (s.date > b.dates[k]!) ratio *= s.ratio;
    raw[i] = b.close[k]! * ratio;
    dv[i] = b.close[k]! * b.volume[k]!;
  }
  return { open, close, raw, dv };
}

export const STUDY_GATE = { minPrice: 5, minMedianDollarVolume: 5_000_000 } as const;

export type StudyMeasure =
  | { ok: true; betaSpyPct: number; betaSpy5Pct: number | null; carPct: number; rawMinusSpyPct: number; prePct: number | null; entryDate: string; beta: number; price: number; dollarVolume: number }
  | { ok: false; reason: "window_open" | "not_covered" | "below_price" | "below_volume" | "no_estimation" | "no_entry_price" | "missing_price" };

function lastValid(a: ArrayLike<number>, i: number): number {
  for (let k = i; k >= Math.max(0, i - 5); k--) if (a[k]! > 0) return a[k]!;
  return NaN;
}

function median20(a: ArrayLike<number>, end: number): number {
  const xs: number[] = [];
  for (let i = Math.max(0, end - 19); i <= end; i++) if (a[i]! > 0) xs.push(a[i]!);
  return xs.length >= 10 ? median(xs) : NaN;
}

/**
 * One study event, measured as events-v1 measured it: the price and volume
 * gate at the last close before day 0, the SPY market model, and the
 * primary column (sum of r - beta r_SPY over `windowDays` sessions from the
 * entry open, percent). Pure.
 */
export function measureStudyEvent(sessions: readonly string[], stock: Aligned, spy: PriceSeries, acceptedAt: string, windowDays: number): StudyMeasure {
  const publicMs = Date.parse(acceptedAt);
  const day0 = reactionDayIndex(sessions, publicMs);
  if (day0 === null) return { ok: false, reason: "window_open" };
  if (day0 < 1 || !(lastValid(stock.close, day0 - 1) > 0)) return { ok: false, reason: "not_covered" };
  const price = lastValid(stock.raw, day0 - 1);
  const dv = median20(stock.dv, day0 - 1);
  if (!(price > STUDY_GATE.minPrice)) return { ok: false, reason: "below_price" };
  if (!(dv >= STUDY_GATE.minMedianDollarVolume)) return { ok: false, reason: "below_volume" };
  const windows = windowDays === 5 ? [5] : [5, windowDays];
  const m = measureEvent({ sessions, stock, market: spy, publicMs, windows });
  if (!m.ok) return { ok: false, reason: m.reason === "no_session" ? "window_open" : m.reason };
  const d = m.drift[windowDays];
  if (!d) return { ok: false, reason: m.driftMissing[windowDays] === "missing_price" ? "missing_price" : "window_open" };
  const d5 = m.drift[5];
  return {
    ok: true,
    betaSpyPct: (d.car + m.model.alpha * windowDays) * 100,
    betaSpy5Pct: d5 ? (d5.car + m.model.alpha * 5) * 100 : null,
    carPct: d.car * 100,
    rawMinusSpyPct: d.rawMinusMarket * 100,
    prePct: m.pre ? m.pre.ar * 100 : null,
    entryDate: m.entryDate,
    beta: m.model.beta,
    price,
    dollarVolume: dv,
  };
}

/**
 * The events the test is decided on, given which are measured: the first
 * `minN` measured in acceptance order once there are that many; else every
 * event (at reviewBy, only those accepted by lastEventDateAtReviewBy). Pure.
 */
export function reviewSample<T extends { date: string; measured: boolean }>(events: readonly T[], s: ForwardStudy, todayNy: string): { sample: T[]; reviewDue: boolean; reason: string } {
  const measured = events.filter((e) => e.measured);
  if (measured.length >= s.minN) return { sample: measured.slice(0, s.minN), reviewDue: true, reason: `n reached ${s.minN}` };
  if (todayNy >= s.reviewBy) return { sample: measured.filter((e) => e.date <= s.lastEventDateAtReviewBy), reviewDue: true, reason: `review date ${s.reviewBy} reached` };
  return { sample: measured, reviewDue: false, reason: `running: ${measured.length} of ${s.minN} measured, review at n ${s.minN} or ${s.reviewBy}` };
}

/** The running estimate and the pre-registered bar on it (PASS_BAR, the events-v1 / F7 bar; a study states the same minN). Pure. */
export function runningEstimate(obs: ReadonlyArray<{ value: number; date: string; firm: string }>, s: ForwardStudy): { summary: StudySummary | null; bar: BarRead } {
  const summary = eventStudy(obs);
  return { summary, bar: passesBar(summary, s.expectedSign, PASS_BAR) };
}
