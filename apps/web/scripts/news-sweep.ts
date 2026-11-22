/**
 * Fills public.news_items from this machine: walks the US universe at the
 * Finnhub rate until Ctrl+C, resuming from the shared cursor.
 *
 *   pnpm --filter web news:sweep              # 50 calls a minute
 *   NEWS_SWEEP_RATE=30 pnpm --filter web news:sweep
 *
 * Needs Node 22.18 or newer (runs this TypeScript file directly) and
 * FINNHUB_API_KEY plus DATABASE_URL in apps/web/.env.local.
 *
 * The production sweeper (netlify/functions/news-sweep.mts) uses the same key
 * and cursor. While this runs it holds the lease, so the Netlify runs skip
 * themselves and the two never call Finnhub at once; it waits for a Netlify
 * run in progress to finish before it starts. Ctrl+C frees the lease and
 * Netlify takes over at the next minute.
 */
import os from "node:os";
import { createNewsPool, releaseLease, sweepBatch } from "../lib/news/store.ts";

const key = process.env.FINNHUB_API_KEY?.trim();
const url = process.env.DATABASE_URL;
if (!key || !url) {
  console.error("Set FINNHUB_API_KEY and DATABASE_URL in apps/web/.env.local");
  process.exit(1);
}

const rate = Math.max(1, Math.min(55, Number(process.env.NEWS_SWEEP_RATE) || 50));
const owner = `local:${os.hostname()}:${process.pid}`;
const pool = createNewsPool(url, 2);
const stop = new AbortController();
const stamp = () => new Date().toLocaleTimeString();
const log = (line: string) => console.log(`${stamp()}  ${line}`);

const onStop = () => {
  if (stop.signal.aborted) process.exit(130);
  log("Stopping after the current call (Ctrl+C again to quit now)");
  stop.abort();
};
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);

log(`Sweeping at ${rate} calls a minute as ${owner}`);
const totals = { calls: 0, symbols: 0, articles: 0, rateLimited: 0, errors: 0 };
let waiting = "";
try {
  while (!stop.signal.aborted) {
    const r = await sweepBatch(pool, key, {
      owner,
      leaseMs: 120_000,
      maxCalls: rate,
      budgetMs: Number.POSITIVE_INFINITY,
      intervalMs: Math.ceil(60_000 / rate),
      waitOnLimit: true,
      signal: stop.signal,
      log,
    });
    if (r.heldBy) {
      const note = `Waiting for ${r.heldBy.owner} to finish`;
      if (waiting !== note) log(note);
      waiting = note;
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    waiting = "";
    totals.calls += r.calls;
    totals.symbols += r.symbols;
    totals.articles += r.articles;
    totals.rateLimited += r.rateLimited;
    totals.errors += r.errors;
    log(
      `${r.symbols} symbols up to ${r.lastSymbol ?? "-"} of ${r.universe}, ${r.articles} articles saved` +
        (r.rateLimited ? `, ${r.rateLimited} rate limited` : "") +
        (r.errors ? `, ${r.errors} errors` : "") +
        (r.pruned ? `, ${r.pruned} old rows pruned` : "") +
        `  (total ${totals.symbols} symbols, ${totals.articles} articles, ${totals.rateLimited} rate limited)`,
    );
    if (r.stoppedBy === "auth" || r.stoppedBy === "lease") break;
  }
} finally {
  await releaseLease(pool, owner).catch(() => undefined);
  await pool.end().catch(() => undefined);
  log(`Stopped. ${totals.calls} calls, ${totals.symbols} symbols, ${totals.articles} articles saved`);
}
