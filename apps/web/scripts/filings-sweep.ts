/**
 * Fills public.news_filings from this machine: reads every EDGAR daily form
 * index of the last 90 days it has not read yet, enriches every pending
 * filing (newest first), then polls the latest-filings feeds once a minute
 * until Ctrl+C.
 *
 *   pnpm --filter web filings:sweep            # backfill, then follow live
 *   pnpm --filter web filings:sweep --once     # backfill and exit
 *   FILINGS_SWEEP_GAP_MS=300 pnpm --filter web filings:sweep
 *
 * Needs Node 22.18 or newer and DATABASE_URL in apps/web/.env.local. EDGAR
 * requests start at least FILINGS_SWEEP_GAP_MS apart, four filings at a time (default
 * 150 ms, under 7 a second; SEC's ceiling is 10), with Falcon's declared
 * User-Agent (SEC_EDGAR_USER_AGENT).
 *
 * The production sweeper (netlify/functions/filings-sweep.mts) uses the same
 * lease: while this runs, Netlify runs skip themselves. Ctrl+C frees it.
 */
import os from "node:os";
import { releaseFilingLease, sweepFilings } from "../lib/news/filings.ts";
import { createNewsPool } from "../lib/news/store.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL in apps/web/.env.local");
  process.exit(1);
}

const once = process.argv.includes("--once");
const gapMs = Math.max(120, Number(process.env.FILINGS_SWEEP_GAP_MS) || 150);
const owner = `local:${os.hostname()}:${process.pid}`;
const pool = createNewsPool(url, 5);
const stop = new AbortController();
const stamp = () => new Date().toLocaleTimeString();
const log = (line: string) => console.log(`${stamp()}  ${line}`);

const onStop = () => {
  if (stop.signal.aborted) process.exit(130);
  log("Stopping after the current request (Ctrl+C again to quit now)");
  stop.abort();
};
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    stop.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

log(`Sweeping EDGAR filings, ${gapMs} ms between requests, as ${owner}`);
try {
  while (!stop.signal.aborted) {
    const started = Date.now();
    const r = await sweepFilings(pool, {
      owner,
      leaseMs: 120_000,
      budgetMs: Number.POSITIVE_INFINITY,
      gapMs,
      live: true,
      allFeeds: true,
      indexDays: 1000,
      workers: 4,
      signal: stop.signal,
      log,
    });
    if (r.heldBy) {
      log(`Waiting for ${r.heldBy.owner} to finish`);
      await pause(5000);
      continue;
    }
    log(
      `${r.calls} requests: ${r.inserted} new filings, ${r.enriched} enriched, ${r.dropped} dropped, ${r.failed} failed, ${r.pending} pending` +
        (r.indexDays.length ? `, read indexes ${r.indexDays.at(-1)} to ${r.indexDays[0]}` : "") +
        (r.pruned ? `, ${r.pruned} old rows pruned` : "") +
        ` (${r.stoppedBy})`,
    );
    if (r.stoppedBy === "lease") break;
    if (once && r.pending === 0) break;
    await pause(Math.max(5_000, (r.stoppedBy === "limit" ? 120_000 : 60_000) - (Date.now() - started)));
  }
} finally {
  await releaseFilingLease(pool, owner).catch(() => undefined);
  await pool.end().catch(() => undefined);
  log("Stopped");
}
