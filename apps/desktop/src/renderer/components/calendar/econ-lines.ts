import { KNOWN_COUNTRIES, formatEconomicFigure, type EconomicFigures } from "../../../shared/economic-calendar";

/**
 * What a release's or a speech's row says beside its title, in the reader's
 * language and number format: "Forecast 0.3%" next to the title, "Previous
 * 0.2%" under it (and "Actual 0.4%" once it is out), or "Completed" for a
 * speech whose time has passed. A row with neither says nothing more.
 *
 * Pure: the words come in as a function, so the Calendar tab, the dashboard
 * card and a node test all build the same lines.
 */

export type Say = (key: "calendar.econ.forecast" | "calendar.econ.previous" | "calendar.econ.actual" | "calendar.econ.completed", params?: Record<string, string>) => string;

export type EconLines = {
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  /** A speech whose start is behind the clock. */
  completed: string | null;
};

export const NO_LINES: EconLines = { forecast: null, previous: null, actual: null, completed: null };

export function econLines(
  row: { figures?: EconomicFigures | null; speech?: boolean; startMs: number | null },
  nowMs: number,
  say: Say,
  locale: string,
): EconLines {
  if (row.speech) {
    return { ...NO_LINES, completed: row.startMs !== null && Number.isFinite(nowMs) && row.startMs <= nowMs ? say("calendar.econ.completed") : null };
  }
  const f = row.figures;
  if (!f) return NO_LINES;
  const word = (key: "calendar.econ.forecast" | "calendar.econ.previous" | "calendar.econ.actual", v: number | null) =>
    v === null ? null : say(key, { value: formatEconomicFigure(v, f.unit, f.scale, locale) });
  return {
    forecast: word("calendar.econ.forecast", f.forecast),
    previous: word("calendar.econ.previous", f.previous),
    actual: word("calendar.econ.actual", f.actual),
    completed: null,
  };
}

/** The words beside the title: "Completed", the forecast, or the actual when no forecast was published. */
export function besideTitle(lines: EconLines): string | null {
  return lines.completed ?? lines.forecast ?? (lines.forecast === null && lines.actual !== null && lines.previous === null ? lines.actual : null);
}

/** The muted line under the title: the actual (once out) and the previous figure. */
export function underTitle(lines: EconLines): string | null {
  const shownBeside = besideTitle(lines);
  const parts = [lines.actual !== shownBeside ? lines.actual : null, lines.previous].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" · ") : null;
}

const regionNames = new Map<string, Intl.DisplayNames | null>();

/** "Türkiye", "Germany", "Euro area": a code's name in the reader's language. */
export function countryName(code: string, locale: string, euroArea: string): string {
  if (code === "EU") return euroArea;
  let names = regionNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      names = null;
    }
    regionNames.set(locale, names);
  }
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The mark for a calendar row: the company for a company's date, the country for the rest, nothing for the reader's own. */
export function markOf(event: { origin: string; tickers: readonly string[]; country?: string | null; type?: string }): { ticker: string | null; country: string | null } {
  if (event.origin !== "market") return { ticker: null, country: null };
  if (event.tickers.length > 0 && (event.type === "earnings" || event.type === "corporate" || !event.country)) return { ticker: event.tickers[0]!, country: null };
  return { ticker: null, country: event.country && KNOWN_COUNTRIES.has(event.country) ? event.country : null };
}
