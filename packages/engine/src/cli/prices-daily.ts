/**
 * Daily stock prices for the whole universe (src/prices/daily.ts): Databento
 * EQUS.SUMMARY ohlcv-1d bars into Supabase public.prices_daily, for
 * /api/prices and the Desk tools.
 *
 *   pnpm --filter @falcon/engine run prices-daily                          # sessions of the last 10 days not stored yet
 *   pnpm --filter @falcon/engine run prices-daily -- --backfill            # every session since 2024-07-01 not stored yet
 *   pnpm --filter @falcon/engine run prices-daily -- --backfill --from 2025-01-02 --to 2025-06-30
 *   pnpm --filter @falcon/engine run prices-daily -- --price-only          # get_cost only, nothing bought or written
 *   pnpm --filter @falcon/engine run prices-daily -- --tickers NVDA,AMD
 *
 * Needs DATABENTO_API_KEY and DATABASE_URL (environment or apps/web/.env.local).
 * Exit code 0 whenever the job ran, even when a cap or Databento billing
 * stopped it (the summary says so; in Actions a warning annotation too);
 * 1 only when it could not start (no key, no database).
 */

import { env } from "../env.ts";
import { loadGraph } from "../graph.ts";
import { universeTickers } from "../options/daily.ts";
import { pgOptionsStore } from "../options/store.ts";
import { runPrices } from "../prices/daily.ts";
import { pgPricesStore } from "../prices/store.ts";

const inActions = process.env.GITHUB_ACTIONS === "true";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const mode = args.backfill === true || args.backfill === "true" ? "backfill" : "daily";
  const from = typeof args.from === "string" && DATE.test(args.from) ? args.from : undefined;
  const to = typeof args.to === "string" && DATE.test(args.to) ? args.to : undefined;
  const title = mode === "daily" ? "Daily prices" : "Prices backfill";

  let tickers = typeof args.tickers === "string" ? args.tickers.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : universeTickers(loadGraph());
  if (typeof args.max === "string") tickers = tickers.slice(0, Math.max(0, Math.floor(Number(args.max)) || 0));

  if (!env("DATABENTO_API_KEY")) {
    console.log(`prices-${mode}: DATABENTO_API_KEY is not set; nothing to do`);
    if (inActions) console.log(`::warning title=${title}::DATABENTO_API_KEY is not set; no prices today.`);
    return 1;
  }
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl && !priceOnly) {
    console.log(`prices-${mode}: DATABASE_URL is not set; the store and the spend ledger live in Supabase`);
    return 1;
  }
  const store = databaseUrl ? pgPricesStore(databaseUrl) : null;
  const ledger = databaseUrl ? pgOptionsStore(databaseUrl) : null;
  try {
    const s = await runPrices({ store, ledger, tickers, mode, from, to, priceOnly, log: (l) => console.log(l) });
    console.log(s.line);
    if (inActions) {
      const msg = s.line.replace(/\r?\n/g, " ");
      if (s.accountError) console.log(`::warning title=Databento refused (billing?)::${s.accountError}. ${msg}`);
      else if (s.stopped) console.log(`::warning title=${title} stopped early::${msg}`);
      else console.log(`::notice title=${title}::${msg}`);
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (summaryFile) {
        const fs = await import("node:fs");
        fs.appendFileSync(summaryFile, `### ${title}\n\n${msg}\n`);
      }
    }
    return 0;
  } finally {
    await store?.close();
    await ledger?.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
    console.error(`prices failed: ${msg}`);
    if (inActions) console.log(`::warning title=Prices failed::${msg.slice(0, 300)}`);
    process.exit(1);
  },
);
