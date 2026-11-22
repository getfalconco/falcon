import { releaseFilingLease, sweepFilings } from "../../lib/news/filings.ts";
import { createNewsPool } from "../../lib/news/store.ts";

/**
 * Netlify scheduled function: every minute, polls SEC EDGAR's latest-filings
 * feed for 8-K, 6-K, Schedule 13D, registration, prospectus, merger and
 * tender-offer filings, reads one missing EDGAR daily index (backfill and gap
 * healing over the last 90 days) and enriches pending filings into
 * public.news_filings (lib/news/filings.ts).
 *
 * EDGAR requests start FILINGS_SWEEP_GAP_MS apart (default 250 ms,
 * 4 a second; SEC's ceiling is 10), with Falcon's declared User-Agent, within
 * about 22 seconds. It skips the run while a local `pnpm --filter web
 * filings:sweep` holds the lease. Set FILINGS_SWEEP_DISABLED=1 in Netlify to
 * pause it.
 *
 * Scheduled functions run only on the published production deploy.
 */

export default async function handler(): Promise<Response> {
  const url = process.env.DATABASE_URL;
  if (process.env.FILINGS_SWEEP_DISABLED === "1") return Response.json({ skipped: "disabled" });
  if (!url) return Response.json({ skipped: "missing DATABASE_URL" });

  const gapMs = Math.max(150, Number(process.env.FILINGS_SWEEP_GAP_MS) || 250);
  const owner = `netlify:${Math.random().toString(36).slice(2, 8)}`;
  const pool = createNewsPool(url, 3);
  try {
    const result = await sweepFilings(pool, {
      owner,
      leaseMs: 45_000,
      budgetMs: 22_000,
      gapMs,
      live: true,
      indexDays: 1,
      workers: 3,
      log: (line) => console.log(`[filings-sweep] ${line}`),
    });
    if (!result.heldBy) await releaseFilingLease(pool, owner);
    console.log(`[filings-sweep] ${JSON.stringify(result)}`);
    return Response.json(result);
  } catch (err) {
    await releaseFilingLease(pool, owner).catch(() => undefined);
    console.error(`[filings-sweep] failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "sweep failed" }, { status: 500 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export const config = {
  schedule: "* * * * *",
};
