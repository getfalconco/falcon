/**
 * The Dashboard's one sentence under the greeting: what in the viewer's
 * portfolio needs attention today. Deterministic text from app data only (no AI,
 * no estimates):
 *
 *   - "N things need your decision": the Today summary's portfolio list
 *     (buildTodaySummary in feed.ts): cards in the served Sightings feed that
 *     touch a portfolio ticker (the event company or a hit) and clear the
 *     publishing bar (not Watch tier / low confidence). The same cards as
 *     "Hitting your portfolio, backed by evidence".
 *   - "NVDA reports tonight, options price ±10%": only for a portfolio ticker
 *     with a stored pre-earnings straddle (/api/options?earnings=1, the daily
 *     options job's metrics.earnings_straddle) whose release date is today
 *     or tomorrow in New York. The move is that straddle's implied move.
 *
 * Pure: the instant is a parameter.
 */

import { plusMinusPct } from "@falcon/ripple";
import type { OptionsEarningsRelease } from "../options-api";
import type { FeedStatus } from "./sightings";
import { CLOSE_MIN, EARLY_CLOSE_MIN, OPEN_MIN, nyDate } from "./market-status";
import { addDays, isNyseEarlyClose } from "../../../../packages/engine/src/study/abnormal.ts";
import { nyOffsetMs } from "../../../../packages/engine/src/edgar-time.ts";

export type EarningsSoon = {
  ticker: string;
  /** "reports tonight", "reports tomorrow before the open", "reported before today's open". */
  when: string;
  /** True once the release is certainly out (a before-open release after the open, a during one after the close). */
  past: boolean;
  /** Straddle implied move, percent. */
  movePct: number;
  date: string;
  time: OptionsEarningsRelease["time"];
};

const TIME_ORDER: Record<OptionsEarningsRelease["time"], number> = { before_open: 0, during: 1, after_close: 2, unknown: 3 };

function nyMinutes(ms: number): number {
  const local = ms + nyOffsetMs(ms);
  return Math.floor((local % 86_400_000) / 60_000);
}

function phrase(r: OptionsEarningsRelease, today: string, minutes: number): { when: string; past: boolean } | null {
  const close = isNyseEarlyClose(today) ? EARLY_CLOSE_MIN : CLOSE_MIN;
  if (r.date === today) {
    switch (r.time) {
      case "before_open":
        return minutes < OPEN_MIN ? { when: "reports this morning before the open", past: false } : { when: "reported before today's open", past: true };
      case "during":
        return minutes < close ? { when: "reports during today's session", past: false } : { when: "reported during today's session", past: true };
      case "after_close":
        return minutes < close ? { when: "reports tonight", past: false } : { when: "reports after today's close", past: false };
      default:
        return { when: "reports today", past: false };
    }
  }
  if (r.date === addDays(today, 1)) {
    switch (r.time) {
      case "before_open":
        return { when: "reports tomorrow before the open", past: false };
      case "during":
        return { when: "reports tomorrow during the session", past: false };
      case "after_close":
        return { when: "reports tomorrow after the close", past: false };
      default:
        return { when: "reports tomorrow", past: false };
    }
  }
  return null;
}

/**
 * Portfolio tickers with a stored straddle for a release today or tomorrow (New
 * York), soonest first (earlier day, then time of day, then the larger move).
 * Releases whose snapshot session is after the release date are dropped. Pure.
 */
export function earningsSoon(releases: readonly OptionsEarningsRelease[], portfolio: ReadonlySet<string>, nowMs: number): EarningsSoon[] {
  const today = nyDate(nowMs);
  const minutes = nyMinutes(nowMs);
  const out: EarningsSoon[] = [];
  const seen = new Set<string>();
  for (const r of releases) {
    const ticker = r.ticker.toUpperCase();
    if (!portfolio.has(ticker) || seen.has(ticker)) continue;
    if (!(r.movePct > 0) || r.session > r.date) continue;
    const p = phrase(r, today, minutes);
    if (!p) continue;
    seen.add(ticker);
    out.push({ ticker, when: p.when, past: p.past, movePct: r.movePct, date: r.date, time: r.time });
  }
  return out.sort(
    (a, b) => Number(a.past) - Number(b.past) || a.date.localeCompare(b.date) || TIME_ORDER[a.time] - TIME_ORDER[b.time] || b.movePct - a.movePct || a.ticker.localeCompare(b.ticker),
  );
}

/** "NVDA reports tonight, options price ±10.2%." plus how many more portfolio names report by tomorrow. */
export function earningsClause(soon: readonly EarningsSoon[]): string {
  const first = soon[0];
  if (!first) return "";
  const lead = `${first.ticker} ${first.when}, options ${first.past ? "priced" : "price"} ${plusMinusPct(first.movePct)}.`;
  const more = soon.length - 1;
  if (!more) return lead;
  return `${lead} ${more} more in your portfolio ${more === 1 ? "has" : "have"} earnings today or tomorrow.`;
}

export type AttentionInput = {
  feedStatus: FeedStatus;
  /** Tickers in the portfolio. */
  portfolioCount: number;
  /** Today summary portfolio cards (see the header). */
  decisions: number;
  /** Portfolio releases today or tomorrow; null while the options read is out. */
  earnings: readonly EarningsSoon[] | null;
  /** The development preview: no account, the sample portfolio. */
  preview?: boolean;
  /** The feed shown is the development sample, not the API. */
  sample?: boolean;
};

export const ATTENTION_QUIET = "Nothing in your portfolio needs attention today.";
export const ATTENTION_FEED_ERROR = "Today's Sightings did not load; Falcon tries again in a few minutes.";
export const ATTENTION_FEED_MISSING = "Today's Sightings are not in yet.";

/** What the line shows: hold its space while loading, nothing for an empty portfolio, else the text. */
export type AttentionLine = { kind: "loading" } | { kind: "none" } | { kind: "text"; text: string };

/** The sentence for the Dashboard, from app data only. Pure. */
export function attentionSentence(i: AttentionInput): AttentionLine {
  if (i.feedStatus === "loading" || i.earnings === null) return { kind: "loading" };
  // An empty portfolio: no sentence at all (the greeting and the market chip stay).
  if (i.portfolioCount <= 0) return { kind: "none" };
  const prefix = i.sample ? (i.preview ? "Preview, sample data: " : "Sample data: ") : i.preview ? "Preview: " : "";
  const clause = earningsClause(i.earnings);
  let base: string;
  if (i.feedStatus === "error") base = ATTENTION_FEED_ERROR;
  else if (i.feedStatus === "unavailable") base = ATTENTION_FEED_MISSING;
  else if (i.decisions > 0) base = `${i.decisions} ${i.decisions === 1 ? "thing needs" : "things need"} your decision.`;
  else base = clause ? "" : ATTENTION_QUIET;
  return { kind: "text", text: `${prefix}${[base, clause].filter(Boolean).join(" ")}` };
}
