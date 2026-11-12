/**
 * pnpm --filter @falcon/engine run sightings -- --sector semis --days 7 --max 3
 *
 * Options:
 *   --sector semis        sector to watch (src/universe.ts)
 *   --days 7              window: events EDGAR accepted in the last N days
 *   --until ISO           end of the window (default: now), for a rerun of a past day
 *   --max 3               cards to keep
 *   --judgments FILE      judge from a file of answers instead of the Claude API
 *   --judge-name NAME     label for a file judge (default "file")
 *   --no-supabase         do not write to Supabase even when DATABASE_URL is set
 *   --out FILE            where to write the feed (default out/sightings.json)
 *
 * Without ANTHROPIC_API_KEY (environment or apps/web/.env.local) and without
 * --judgments, the run stops after writing the judge requests
 * (out/judge-requests.json) and says what is missing.
 */

import fs from "node:fs";
import path from "node:path";
import type { SightingsFeed } from "@falcon/ripple";
import { env, WEB_ENV_PATH } from "../env.ts";
import { ENGINE_ROOT } from "../http.ts";
import { claudeJudge, fileJudge, type Judge } from "../judge.ts";
import { runSightings } from "../pipeline.ts";
import { upsertCards } from "../supabase.ts";

type Args = Record<string, string | boolean>;

export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function str(args: Args, k: string, d: string): string {
  return typeof args[k] === "string" ? (args[k] as string) : d;
}

function printFeed(feed: SightingsFeed): void {
  for (const [i, card] of feed.cards.entries()) {
    const e = card.event;
    console.log(`\n${i + 1}. ${e.headline}  [${e.ticker}, ${e.kind}, ${e.occurredAt.slice(0, 16).replace("T", " ")} UTC]`);
    console.log(`   ${e.summary}`);
    for (const f of e.facts ?? []) console.log(`   Source line: ${f}`);
    console.log(`   Source: ${e.source.url}`);
    for (const h of card.hits) {
      const via = h.degree === 2 ? ` via ${h.via}` : "";
      console.log(`   - ${h.ticker} ${h.companyName}: ${h.direction}, ${h.confidence} confidence, ${h.window} (${h.relation}, degree ${h.degree}${via})`);
      console.log(`     ${h.mechanism}`);
      for (const ev of h.evidence) {
        const q = ev.quote.length > 220 ? `${ev.quote.slice(0, 217)}...` : ev.quote;
        console.log(`     "${q}" (${ev.form} ${ev.filedAt})`);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sector = str(args, "sector", "semis");
  const days = Number(str(args, "days", "7"));
  const maxCards = Number(str(args, "max", "3"));
  const untilMs = args.until ? Date.parse(str(args, "until", "")) : Date.now();
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  if (!Number.isFinite(untilMs)) throw new Error("--until must be an ISO time");
  const sinceMs = untilMs - days * 86_400_000;
  const outFile = path.resolve(str(args, "out", path.join(ENGINE_ROOT, "out", "sightings.json")));
  const outDir = path.dirname(outFile);
  fs.mkdirSync(outDir, { recursive: true });

  let judge: Judge | null = null;
  if (typeof args.judgments === "string") judge = fileJudge(path.resolve(args.judgments), str(args, "judge-name", "file"));
  else {
    const key = env("ANTHROPIC_API_KEY");
    if (key) judge = claudeJudge(key);
  }

  const result = await runSightings({ sector, sinceMs, untilMs, maxCards, judge, log: (l) => console.log(l) });
  const requestsFile = path.join(outDir, "judge-requests.json");
  fs.writeFileSync(requestsFile, `${JSON.stringify(result.requests, null, 1)}\n`);

  if (!judge) {
    console.log(`\nNo judge: ANTHROPIC_API_KEY is not set in the environment or in ${WEB_ENV_PATH}.`);
    console.log(`Add it there (ANTHROPIC_API_KEY=...) and run again, or pass --judgments FILE.`);
    console.log(`Judge requests for ${result.requests.length} events written to ${requestsFile}.`);
    process.exitCode = 2;
    return;
  }

  for (const r of result.rejected) console.log(`  dropped ${r.ticker} on ${r.eventId}: ${r.problems.join("; ")}`);
  fs.writeFileSync(outFile, `${JSON.stringify(result.feed, null, 2)}\n`);
  console.log(`\nSightings feed: ${result.feed.cards.length} cards (judge: ${judge.name}) -> ${outFile}`);
  printFeed(result.feed);

  const databaseUrl = args["no-supabase"] ? null : env("DATABASE_URL");
  if (databaseUrl && result.feed.cards.length) {
    try {
      const n = await upsertCards(databaseUrl, result.feed.cards);
      console.log(`\nSupabase: upserted ${n} cards into public.sightings_cards`);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const msg = (e.message ?? String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
      console.log(`\nSupabase: not written${e.code ? ` (${e.code})` : ""}: ${msg}`);
      if (e.code === "42P01") console.log("  The table is missing: run `pnpm --filter @falcon/engine run migrate` first.");
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
