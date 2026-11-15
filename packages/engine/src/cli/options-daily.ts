/**
 * Daily options over the whole universe (src/options/daily.ts): one OPRA
 * snapshot per liquid graph ticker for the latest completed session, stored
 * in Supabase public.options_daily for /api/options and the Sightings run.
 *
 *   pnpm --filter @falcon/engine run options-daily                 # the daily job
 *   pnpm --filter @falcon/engine run options-daily -- --price-only # get_cost only, nothing bought or written
 *   pnpm --filter @falcon/engine run options-daily -- --tickers NVDA,AMD --max 20
 *
 * Needs DATABENTO_API_KEY and DATABASE_URL (environment or apps/web/.env.local).
 * Exit code 0 whenever the job ran, even when a cap or Databento billing
 * stopped it (the summary says so; in Actions a warning annotation too);
 * 1 only when it could not start (no key, no database).
 */

import { env } from "../env.ts";
import { loadGraph } from "../graph.ts";
import { backtestMarketData } from "../market.ts";
import { runDaily, universeTickers } from "../options/daily.ts";
import { pgOptionsStore } from "../options/store.ts";

const inActions = process.env.GITHUB_ACTIONS === "true";

/** --flag value / --flag (sightings.ts runs on import, so its parser is not reused). */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const priceOnly = args["price-only"] === true;
  const log = (l: string) => console.log(l);

  let tickers = typeof args.tickers === "string" ? args.tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : universeTickers(loadGraph());
  if (typeof args.max === "string") tickers = tickers.slice(0, Math.max(0, Math.floor(Number(args.max)) || 0));

  if (!env("DATABENTO_API_KEY")) {
    console.log("options-daily: DATABENTO_API_KEY is not set; nothing to do");
    if (inActions) console.log("::warning title=Options daily::DATABENTO_API_KEY is not set; no options data today.");
    return 1;
  }
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl && !priceOnly) {
    console.log("options-daily: DATABASE_URL is not set; the store and the spend ledger live in Supabase");
    return 1;
  }
  const store = databaseUrl ? pgOptionsStore(databaseUrl) : null;
  const md = await backtestMarketData();
  if (!("market" in md)) log(`options-daily: no market data (${md.error}); no liquidity gate and no beta`);

  try {
    const s = await runDaily({
      market: "market" in md ? md.market : null,
      store,
      ledger: store,
      tickers,
      log,
      priceOnly,
      noLiquidity: args["no-liquidity"] === true,
      batchSize: typeof args.batch === "string" ? Number(args.batch) : undefined,
    });
    console.log(s.line);
    if (s.skipped.length) {
      const poor = s.skipped.filter((x) => x.why.startsWith("poor chain")).length;
      console.log(`options-daily: ${s.skipped.length} skipped (${poor} poor chains); first: ${s.skipped.slice(0, 12).map((x) => `${x.ticker} (${x.why.slice(0, 60)})`).join(", ")}`);
    }
    console.log(`options-daily: ${s.batches} batches, ${s.pruned} old rows pruned`);
    if (inActions) {
      const msg = s.line.replace(/\r?\n/g, " ");
      if (s.accountError) console.log(`::warning title=Databento refused (billing?)::${s.accountError}. Options data stops until the Databento account has a payment method or credit. ${msg}`);
      else if (s.stopped) console.log(`::warning title=Options daily stopped early::${msg}`);
      else console.log(`::notice title=Options daily::${msg}`);
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (summaryFile) {
        const fs = await import("node:fs");
        fs.appendFileSync(summaryFile, `### Options daily\n\n${msg}\n`);
      }
    }
    return 0;
  } finally {
    await store?.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
    console.error(`options-daily failed: ${msg}`);
    if (inActions) console.log(`::warning title=Options daily failed::${msg.slice(0, 300)}`);
    process.exit(1);
  },
);
