import { yahooChart, type ChartResult } from "./desk/tools/yahoo";
import { TtlCache } from "./desk/tools/util";

/**
 * The Dashboard's "Last 7 Days" sparklines (server only): hourly closes over
 * the last 7 calendar days from Yahoo's v8 chart (lib/desk/tools/yahoo.ts,
 * the backtester's polite client: 6 at a time), held 10 minutes per symbol on
 * this server instance. Symbols come from our own client, so a member's
 * tickers never go from the browser to Yahoo. Never invents a point: a
 * symbol Yahoo does not answer has no line (an empty slot on the card).
 */

export const SPARK_FRESH_MS = 10 * 60_000;
export const SPARK_DAYS = 7;
/** Points kept per line: plenty for an 80px sparkline. */
export const SPARK_POINTS = 60;
export const MAX_SPARK_SYMBOLS = 60;
const TIMEOUT_MS = 6_000;

const cache = new TtlCache<number[]>(SPARK_FRESH_MS, 2_000);

/** Pure: a chart's closes from the last `days` calendar days before `nowMs`, gaps dropped, thinned evenly to at most `points` (the last close kept). */
export function sparkFromChart(chart: ChartResult | null, nowMs: number, { days = SPARK_DAYS, points = SPARK_POINTS }: { days?: number; points?: number } = {}): number[] {
  const times = chart?.timestamp ?? [];
  const closes = chart?.indicators?.quote?.[0]?.close ?? [];
  const from = nowMs - days * 86_400_000;
  const series: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const c = closes[i];
    const t = times[i]! * 1000;
    if (t < from || t > nowMs + 60_000) continue;
    if (typeof c === "number" && Number.isFinite(c) && c > 0) series.push(c);
  }
  if (series.length <= points) return series;
  const out: number[] = [];
  const step = (series.length - 1) / (points - 1);
  for (let i = 0; i < points; i++) out.push(series[Math.round(i * step)]!);
  return out;
}

/** Pure: the symbols a request may ask for (quote symbols as lib/portfolio-holdings.ts quoteSymbol writes them), deduplicated and capped. */
export function sparkSymbols(raw: string | null): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9^][A-Z0-9.^=-]{0,31}$/.test(s)),
    ),
  ).slice(0, MAX_SPARK_SYMBOLS);
}

/** Lines for the given quote symbols; a symbol without one is left out. Never throws. */
export async function sparksFor(symbols: readonly string[]): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  await Promise.all(
    symbols.map(async (s) => {
      const hit = cache.get(s);
      if (hit !== undefined) {
        if (hit.length > 1) out[s] = hit;
        return;
      }
      try {
        const chart = await yahooChart(s, "7d", "1h", AbortSignal.timeout(TIMEOUT_MS));
        const line = sparkFromChart(chart, Date.now());
        // A symbol Yahoo does not know is held too (as an empty line), so it is not asked for again every poll.
        cache.set(s, line);
        if (line.length > 1) out[s] = line;
      } catch (error) {
        console.error("[portfolio spark] Yahoo chart failed", error instanceof Error ? error.name : "unknown");
      }
    }),
  );
  return out;
}
