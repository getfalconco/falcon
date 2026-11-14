/**
 * The 3-month T-bill rate (FRED DTB3, secondary market, discount basis, percent
 * a year): idle cash earns DTB3 / 252 a session, and Sharpe uses it as the
 * risk-free rate (design 4.4). Public domain data from the St. Louis Fed.
 *
 * Fetched once as CSV and cached for 24 hours. When FRED cannot be reached the
 * run uses 0% and says so (`fallback: true`).
 */

import { JsonCache } from "./cache";
import { PoliteFetcher } from "./http";

export const DTB3_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3";
const TTL_MS = 24 * 3_600_000;

import type { RatePoint } from "../rates";
export { dailyCashRates, type RatePoint } from "../rates";

export interface RateSource {
  readonly name: string;
  /** DTB3 observations (percent a year), oldest first. */
  dtb3(signal?: AbortSignal): Promise<RatePoint[]>;
}

/** Parses FRED's CSV (observation_date,DTB3; "." marks a missing day). Pure. */
export function parseFredCsv(text: string): RatePoint[] {
  const out: RatePoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2}),\s*([-0-9.]+)\s*$/.exec(line.trim());
    if (!m) continue;
    const v = Number(m[2]);
    if (Number.isFinite(v)) out.push({ date: m[1]!, rate: v });
  }
  return out;
}

const fredFetcher = new PoliteFetcher({ concurrency: 1, minGapMs: 0, timeoutMs: 8_000, retries: 1 });

export class FredRateSource implements RateSource {
  readonly name = "FRED DTB3 (3-month T-bill)";
  private inflight: Promise<RatePoint[]> | null = null;

  constructor(
    private cache: JsonCache,
    private http: PoliteFetcher = fredFetcher,
  ) {}

  async dtb3(signal?: AbortSignal): Promise<RatePoint[]> {
    const hit = await this.cache.get<RatePoint[]>("fred-dtb3-v1", TTL_MS);
    if (hit?.length) return hit;
    this.inflight ??= (async () => {
      try {
        const res = await this.http.fetch(DTB3_URL, { headers: { Accept: "text/csv" } }, signal);
        if (!res.ok) throw new Error(`FRED DTB3: HTTP ${res.status}`);
        const points = parseFredCsv(await res.text());
        if (points.length < 100) throw new Error("FRED DTB3: unexpected answer");
        await this.cache.set("fred-dtb3-v1", points);
        return points;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

