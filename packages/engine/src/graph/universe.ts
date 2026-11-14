/**
 * The graph's filer universe: US-listed operating companies that pass the
 * engine's liquidity gate (src/quality.ts isLiquid: price above $5, 20-day
 * median dollar volume of $5M or more), ranked by dollar volume, top N.
 *
 * Sources, all free and already used by the engine:
 *   - SEC company_tickers_exchange.json: who is listed on Nasdaq / NYSE /
 *     Cboe, one primary ticker per CIK (src/feed/companies.ts);
 *   - SEC XBRL frames, dei:EntityPublicFloat: the public float each 10-K
 *     reports on its cover, as of the end of the filer's second quarter; a
 *     cheap size pre-filter that needs one request per quarter for every
 *     filer (point in time: a frame only holds floats filed by then);
 *   - daily closes through the backtester's data layer (src/market.ts):
 *     price and dollar volume, the same reading the Sightings run uses.
 * Foreign private issuers (20-F, 40-F) report no float; they enter on dollar
 * volume alone, once their latest annual report is confirmed. Pure here; the
 * reads are in scripts/graph-universe.ts.
 */

import { isLiquid, type Liquidity } from "../quality.ts";

export type FrameRow = { accn: string; cik: number; entityName: string; end: string; val: number };

export type Float = { cik: string; name: string; floatUsd: number; asOf: string; accession: string };

/** Each CIK's latest public float across several frames (latest `end` wins). Pure. */
export function latestFloats(frames: FrameRow[][]): Map<string, Float> {
  const out = new Map<string, Float>();
  for (const rows of frames) {
    for (const r of rows) {
      const cik = String(r.cik).padStart(10, "0");
      const known = out.get(cik);
      if (known && known.asOf >= r.end) continue;
      out.set(cik, { cik, name: r.entityName, floatUsd: r.val, asOf: r.end, accession: r.accn });
    }
  }
  return out;
}

/** Frame names covering the floats of annual reports filed in the 18 months before `today` (YYYY-MM-DD). Pure. */
export function floatFrames(today: string): string[] {
  const y = Number(today.slice(0, 4));
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  const out: string[] = [];
  let yy = y;
  let qq = q;
  for (let i = 0; i < 7; i++) {
    out.push(`CY${yy}Q${qq}I`);
    qq--;
    if (qq === 0) {
      qq = 4;
      yy--;
    }
  }
  return out.reverse();
}

export type Candidate = {
  ticker: string;
  cik: string;
  name: string;
  exchange: string | null;
  floatUsd: number | null;
  liquidity: Liquidity | null;
  /** Latest annual report form when checked (10-K, 20-F, 40-F), null when none, undefined when not checked. */
  annualForm?: string | null;
};

export type Member = { ticker: string; cik: string; name: string; floatUsd: number | null; medianDollarVolume20d: number; price: number; annualForm: string | null };

/**
 * Candidates that pass the gate with a known dollar volume (and, when
 * checked, file an annual report), ranked by 20-day median dollar volume,
 * the first `n`. Pure.
 */
export function rankUniverse(candidates: Candidate[], n: number): Member[] {
  return candidates
    .filter((c) => c.liquidity && c.liquidity.medianDollarVolume20d !== null && isLiquid(c.liquidity) && c.annualForm !== null)
    .map((c) => ({
      ticker: c.ticker,
      cik: c.cik,
      name: c.name,
      floatUsd: c.floatUsd,
      medianDollarVolume20d: c.liquidity!.medianDollarVolume20d!,
      price: c.liquidity!.price!,
      annualForm: c.annualForm ?? null,
    }))
    .sort((a, b) => b.medianDollarVolume20d - a.medianDollarVolume20d || a.ticker.localeCompare(b.ticker))
    .slice(0, n);
}
