import type { LanguageCode } from "../../lib/i18n/languages";
import { fillTemplateTicker, say } from "./agent-format";

/**
 * The create flow's starting points, made from what the reader holds and
 * follows rather than a fixed list: the results of the held name that reports
 * soonest, the filings of a holding, and insider purchases at a holding
 * (open-market only, 10b5-1 plan trades left out).
 *
 * Only what the engine can watch today is offered. A reader with no holdings
 * and no watchlist gets the same three about the tracked names that report
 * soonest, marked as examples ("e.g. NVDA"), and failing those about NVDA,
 * AAPL and MSFT.
 *
 * Pure, so the choice of names is tested without React.
 */

export type StarterId = "earnings" | "filings" | "insider";

/** One upcoming report, as the earnings calendar gives it. */
export type ReportingRow = { ticker: string; date: string; held?: boolean; watchlist?: boolean };

export type StarterInputs = {
  /** Open positions, as symbols. */
  held: readonly string[];
  /** Followed names, as symbols. */
  watchlist: readonly string[];
  /** Upcoming reports for the reader's own names (any order). */
  reporting: readonly ReportingRow[];
  /** Upcoming reports across the tracked names, for a reader with no names of their own. */
  tracked: readonly ReportingRow[];
};

export type StarterTemplate = {
  id: StarterId;
  ticker: string;
  /** Not one of the reader's own names: the chip says "e.g." */
  example: boolean;
  /** The report date, for the earnings starter, when the calendar has one. */
  date?: string;
};

/** The names a reader with nothing of their own and no calendar gets. */
export const EXAMPLE_TICKERS: Readonly<Record<StarterId, string>> = { earnings: "NVDA", filings: "AAPL", insider: "MSFT" };

const upper = (list: readonly string[]) => [...new Set(list.map((t) => t.trim().toUpperCase()).filter(Boolean))];
const byDate = (rows: readonly ReportingRow[]) => [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

/** Picks the first name not already used by an earlier starter, else the first. */
function pick(candidates: readonly string[], used: ReadonlySet<string>): string | undefined {
  return candidates.find((t) => !used.has(t)) ?? candidates[0];
}

export function buildStarterTemplates(input: StarterInputs): StarterTemplate[] {
  const held = upper(input.held);
  const watchlist = upper(input.watchlist);
  const own = upper([...held, ...watchlist]);
  const reporting = byDate(input.reporting.map((r) => ({ ...r, ticker: r.ticker.toUpperCase() })));
  const tracked = byDate(input.tracked.map((r) => ({ ...r, ticker: r.ticker.toUpperCase() })));
  const used = new Set<string>();
  const out: StarterTemplate[] = [];

  // Results: the held name that reports soonest, then a followed one, then any own name.
  const heldReport = reporting.find((r) => held.includes(r.ticker));
  const watchReport = reporting.find((r) => watchlist.includes(r.ticker));
  const report = heldReport ?? watchReport;
  if (report) out.push({ id: "earnings", ticker: report.ticker, example: false, date: report.date });
  else if (own[0]) out.push({ id: "earnings", ticker: own[0], example: false });
  else if (tracked[0]) out.push({ id: "earnings", ticker: tracked[0].ticker, example: true, date: tracked[0].date });
  else out.push({ id: "earnings", ticker: EXAMPLE_TICKERS.earnings, example: true });
  used.add(out[0]!.ticker);

  // Filings and insider purchases: holdings first, then followed names, then examples.
  const fallback = tracked.map((r) => r.ticker);
  for (const id of ["filings", "insider"] as const) {
    const ownPick = pick(held, used) ?? pick(watchlist, used);
    if (ownPick) out.push({ id, ticker: ownPick, example: false });
    else out.push({ id, ticker: pick(fallback.filter((t) => !used.has(t)), used) ?? EXAMPLE_TICKERS[id], example: true });
    used.add(out[out.length - 1]!.ticker);
  }
  return out;
}

/** The chip's label: "Earnings of NVDA", or "Earnings watch, e.g. NVDA" for an example. */
export function starterTitle(t: StarterTemplate, lang: LanguageCode): string {
  return say(lang, t.example ? `agents.starter.${t.id}.example` : `agents.starter.${t.id}.title`, { ticker: t.ticker });
}

/** What the starter does, for the chip's tooltip. */
export function starterDescription(t: StarterTemplate, lang: LanguageCode): string {
  return say(lang, `agents.starter.${t.id}.description`);
}

/** The brief the starter puts in, with its ticker located so typing replaces it. */
export function starterBrief(t: StarterTemplate, lang: LanguageCode): { text: string; select: readonly [number, number] | null } {
  return fillTemplateTicker(say(lang, `agents.starter.${t.id}.brief`), t.ticker);
}
