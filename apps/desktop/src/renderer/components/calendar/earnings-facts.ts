/**
 * Calendar tab: the figures an earnings date's card sets under its details,
 * each one line taken whole from the module that owns it:
 *
 *   options      the move the options price for the report against the
 *                stock's own report-day record (shared/implied-move.ts)
 *   estimates    how the EPS estimate for the quarter being reported moved
 *                over the last 30 days (shared/estimate-revisions.ts)
 *   guidance     how reported figures have landed against the company's
 *                own guidance (shared/guidance-view.ts), only when this run
 *                has the track already: a first read calls the model, and
 *                the calendar never starts one
 *   read-through how a held name has moved on this company's past report
 *                days (shared/readthrough-view.ts)
 *
 * Only a company's earnings date from the market feeds gets the lines; a
 * macro row, a dividend or the reader's own event gets none. A line whose
 * source has nothing is left out, and with no line at all the card shows
 * nothing extra.
 *
 * Pure: the wording comes in through `say`, the answers as parameters.
 */

import { normalizeTicker } from "../../../shared/calendar-events";
import type { EarningsTime } from "../../../shared/earnings-types";
import { nyYmdOf } from "../../../shared/earnings-time";
import { addDaysYmd } from "../../../shared/earnings-view";
import { estimateHint, estimateLine, reportPeriod, type EstimateRevisions } from "../../../shared/estimate-revisions";
import type { GuidanceTrack } from "../../../shared/guidance-types";
import { patternText, shownPatterns } from "../../../shared/guidance-view";
import { IMPLIED_WITHIN_DAYS, impliedHint, impliedLine, type ImpliedMove, type ImpliedRequestItem } from "../../../shared/implied-move";
import type { ReadthroughRow } from "../../../shared/readthrough-types";
import { relationText, sourceHint, statsLine } from "../../../shared/readthrough-view";
import type { CalEvent } from "./calendar-model";

export type Say = (key: string, params?: Record<string, string | number>) => string;

/** Guidance pattern lines a card shows at most (the Earnings drawer shows the full set). */
export const CARD_GUIDANCE_LINES = 2;
/** Held names whose read-through line a card shows at most. */
export const CARD_READTHROUGH_LINES = 2;

export type EarningsTarget = {
  ticker: string;
  /** The report's New York date. */
  date: string;
  time: EarningsTime;
  /** The report is today or later: the options and estimates lines apply. */
  upcoming: boolean;
  /** The options ask, inside the implied move window only. */
  impliedAsk: ImpliedRequestItem | null;
};

/** "08:30" New York time as a report hour: before the open, after the close, or during the session. */
function timeOfEt(timeEt: string | null): EarningsTime {
  const m = timeEt ? /^(\d{2}):(\d{2})$/.exec(timeEt) : null;
  if (!m) return "unknown";
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes < 9 * 60 + 30) return "bmo";
  if (minutes >= 16 * 60) return "amc";
  return "dmh";
}

/** The company and date an event's card reads figures for; null for anything but one company's earnings date. */
export function earningsTarget(event: CalEvent, today: string): EarningsTarget | null {
  if (event.origin !== "market" || event.type !== "earnings" || event.corporateKind !== "earnings") return null;
  if (event.tickers.length !== 1) return null;
  const ticker = normalizeTicker(event.tickers[0]);
  if (!ticker) return null;
  const date = event.allDay ? event.startDate : event.startMs !== null ? nyYmdOf(event.startMs) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = event.allDay ? "unknown" : timeOfEt(event.timeEt);
  const upcoming = date >= today;
  const impliedAsk = upcoming && date <= addDaysYmd(today, IMPLIED_WITHIN_DAYS) ? { ticker, date, time } : null;
  return { ticker, date, time, upcoming, impliedAsk };
}

export type FactLine = { id: string; text: string; hint?: string };

export type FactSources = {
  /** Absent or null: not read yet, or no usable quotes. */
  implied?: ImpliedMove | null;
  estimates?: EstimateRevisions | null;
  /** The track this run already has; null when it has none. */
  guidance?: GuidanceTrack | null;
  /** The read-through radar's rows for the reader's names. */
  readthrough?: readonly ReadthroughRow[] | null;
};

/** The card's lines, in a fixed order: options, estimates, guidance record, read-through. */
export function earningsFacts(target: EarningsTarget, sources: FactSources, say: Say, lang: string): FactLine[] {
  const out: FactLine[] = [];
  const implied = sources.implied;
  if (target.impliedAsk && implied && implied.ticker.toUpperCase() === target.ticker) {
    out.push({ id: "implied", text: impliedLine(implied, say, lang), hint: impliedHint(implied, say, lang) });
  }
  if (target.upcoming) {
    const period = reportPeriod(sources.estimates ?? null, target.date);
    const text = period ? estimateLine(period, say, lang) : null;
    if (period && text) out.push({ id: "estimates", text, hint: estimateHint(period, say, lang) });
  }
  const track = sources.guidance;
  if (track && track.rows.length > 0) {
    for (const p of shownPatterns(track.patterns).slice(0, CARD_GUIDANCE_LINES)) {
      out.push({ id: `guidance:${p.metric}|${p.basis}`, text: patternText(p, lang, say) });
    }
  }
  const seen = new Set<string>();
  for (const row of sources.readthrough ?? []) {
    if (seen.size >= CARD_READTHROUGH_LINES) break;
    if (!row.held || !row.stats || row.counterparty.toUpperCase() !== target.ticker || row.kind === "later" || seen.has(row.holding)) continue;
    seen.add(row.holding);
    out.push({ id: `readthrough:${row.id}`, text: statsLine(row, say, lang), hint: `${relationText(row, say)}\n${sourceHint(row, say, lang)}` });
  }
  return out;
}
