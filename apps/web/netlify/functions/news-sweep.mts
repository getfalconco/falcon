import { createNewsPool, releaseLease, sweepBatch } from "../../lib/news/store.ts";

/**
 * Netlify scheduled function: every minute, fetches company news for the next
 * slice of the US universe (lib/news/store.ts) into public.news_items.
 *
 * Each run makes at most NEWS_SWEEP_PER_RUN Finnhub calls (default 40) within
 * about 22 seconds, so the sweeper stays near 40 calls a minute and under the
 * free plan's 60. It skips the run while a local `pnpm --filter web news:sweep`
 * holds the lease, so the two never call Finnhub at the same time. Set
 * NEWS_SWEEP_DISABLED=1 in Netlify to pause it.
 *
 * Scheduled functions run only on the published production deploy.
 */

export default async function handler(): Promise<Response> {
  const key = process.env.FINNHUB_API_KEY?.trim();
  const url = process.env.DATABASE_URL;
  if (process.env.NEWS_SWEEP_DISABLED === "1") return Response.json({ skipped: "disabled" });
  if (!key || !url) return Response.json({ skipped: "missing FINNHUB_API_KEY or DATABASE_URL" });

  const perRun = Math.max(1, Math.min(50, Number(process.env.NEWS_SWEEP_PER_RUN) || 40));
  const budgetMs = 22_000;
  const owner = `netlify:${Math.random().toString(36).slice(2, 8)}`;
  const pool = createNewsPool(url, 1);
  try {
    const result = await sweepBatch(pool, key, {
      owner,
      leaseMs: 45_000,
      maxCalls: perRun,
      budgetMs,
      intervalMs: Math.floor(budgetMs / perRun),
      waitOnLimit: false,
      log: (line) => console.log(`[news-sweep] ${line}`),
    });
    if (!result.heldBy) await releaseLease(pool, owner);
    console.log(`[news-sweep] ${JSON.stringify(result)}`);
    return Response.json(result);
  } catch (err) {
    await releaseLease(pool, owner).catch(() => undefined);
    console.error(`[news-sweep] failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: "sweep failed" }, { status: 500 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export const config = {
  schedule: "* * * * *",
};
