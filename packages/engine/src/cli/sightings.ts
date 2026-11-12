/**
 * pnpm --filter @falcon/engine run sightings -- --sector semis --days 7 --max 3
 *
 * Options:
 *   --sector semis        sector to watch (src/universe.ts)
 *   --days 7              window: events EDGAR accepted in the last N days
 *   --until ISO           end of the window (default: now), for a rerun of a past day
 *   --max 3               cards to keep
 *   --keep-days 7         Supabase: cards whose event is older than this are marked stale
 *   --judgments FILE      judge from a file of answers instead of the Claude API
 *   --judge-name NAME     label for a file judge (default "file")
 *   --dry-run             read and judge, print the feed and the summary, write nothing
 *                         (no Supabase, no files unless --out is given). Without
 *                         ANTHROPIC_API_KEY and --judgments it judges from the newest
 *                         saved file in data/judgments/.
 *   --no-supabase         do not write to Supabase even when DATABASE_URL is set
 *   --out FILE            where to write the feed (default out/sightings.json)
 *
 * Without ANTHROPIC_API_KEY (environment or apps/web/.env.local) and without
 * --judgments, a real run stops after writing the judge requests
 * (out/judge-requests.json), writes no cards and exits 2. Exit codes:
 * src/summary.ts (EXIT).
 *
 * Writes to Supabase are idempotent: a card's id is `<sector>-<event id>`
 * and the event id is the EDGAR accession, so the same event always lands
 * on the same row.
 */

import fs from "node:fs";
import path from "node:path";
import type { SightingsFeed } from "@falcon/ripple";
import { env, WEB_ENV_PATH } from "../env.ts";
import { ENGINE_ROOT } from "../http.ts";
import { claudeJudge, fileJudge, type Judge } from "../judge.ts";
import { runSightings } from "../pipeline.ts";
import { EXIT, exitReason, runExitCode, summaryLines, warningLines, type Publish } from "../summary.ts";
import { publishCards } from "../supabase.ts";

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

function positive(args: Args, k: string, d: string): number {
  const n = Number(str(args, k, d));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} must be a positive number`);
  return n;
}

/** Connection strings never reach the log. */
function redact(msg: string): string {
  return msg.replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
}

const JUDGMENTS_DIR = path.join(ENGINE_ROOT, "data", "judgments");

/** The newest saved judgments file (names are YYYY-MM-DD.json), or null. */
function newestJudgments(): string | null {
  try {
    const files = fs.readdirSync(JUDGMENTS_DIR).filter((f) => f.endsWith(".json")).sort();
    return files.length ? path.join(JUDGMENTS_DIR, files[files.length - 1]!) : null;
  } catch {
    return null;
  }
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

const inActions = process.env.GITHUB_ACTIONS === "true";

/** GitHub Actions annotation text: one line, no workflow-command characters. */
function annotation(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function writeJobSummary(lines: string[], feed: SightingsFeed | null): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const md = ["## Sightings run", "", ...lines.map((l) => `- ${l}`), ""];
  if (feed?.cards.length) {
    md.push("| Event | Ticker | Hits |", "| --- | --- | --- |");
    for (const c of feed.cards) md.push(`| ${c.event.headline.replace(/\|/g, "/")} | ${c.event.ticker} | ${c.hits.map((h) => h.ticker).join(", ")} |`);
    md.push("");
  }
  try {
    fs.appendFileSync(file, `${md.join("\n")}\n`);
  } catch {
    // The job summary is a convenience.
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const sector = str(args, "sector", "semis");
  const days = positive(args, "days", "7");
  const maxCards = positive(args, "max", "3");
  const keepDays = positive(args, "keep-days", "7");
  const untilMs = args.until ? Date.parse(str(args, "until", "")) : Date.now();
  if (!Number.isFinite(untilMs)) throw new Error("--until must be an ISO time");
  const sinceMs = untilMs - days * 86_400_000;
  // A dry run writes files only when --out asks for it.
  const writeFiles = !dryRun || typeof args.out === "string";
  const outFile = path.resolve(str(args, "out", path.join(ENGINE_ROOT, "out", "sightings.json")));
  const outDir = path.dirname(outFile);
  if (writeFiles) fs.mkdirSync(outDir, { recursive: true });

  let judge: Judge | null = null;
  if (typeof args.judgments === "string") judge = fileJudge(path.resolve(args.judgments), str(args, "judge-name", "file"));
  else {
    const key = env("ANTHROPIC_API_KEY");
    if (key) judge = claudeJudge(key);
    else if (dryRun) {
      const saved = newestJudgments();
      if (saved) {
        judge = fileJudge(saved, `saved judgments ${path.basename(saved)}`);
        console.log(`dry run without ANTHROPIC_API_KEY: judging from ${path.relative(ENGINE_ROOT, saved)}`);
      }
    }
  }
  if (dryRun) console.log("dry run: nothing is written to Supabase");

  const run = await runSightings({ sector, sinceMs, untilMs, maxCards, judge, log: (l) => console.log(l) });
  const requestsFile = path.join(outDir, "judge-requests.json");
  if (writeFiles) fs.writeFileSync(requestsFile, `${JSON.stringify(run.requests, null, 1)}\n`);

  if (!judge) {
    console.log(`\nNo judge: ANTHROPIC_API_KEY is not set in the environment or in ${WEB_ENV_PATH}.`);
    console.log("Add it there (ANTHROPIC_API_KEY=...) and run again, or pass --judgments FILE. No cards were written.");
    if (writeFiles) console.log(`Judge requests for ${run.requests.length} events written to ${requestsFile}.`);
    if (inActions) console.log("::error::ANTHROPIC_API_KEY is not set: no cards judged, nothing published.");
    return EXIT.NO_JUDGE;
  }

  for (const r of run.rejected) console.log(`  dropped ${r.ticker} on ${r.eventId}: ${r.problems.join("; ")}`);
  const judged = run.requests.length;
  // Decide before writing: a run that could read nothing or judge nothing leaves Supabase alone.
  const before = runExitCode(run, judged, { state: "dry-run" });

  if (writeFiles) fs.writeFileSync(outFile, `${JSON.stringify(run.feed, null, 2)}\n`);
  console.log(`\nSightings feed: ${run.feed.cards.length} cards (judge: ${judge.name})${writeFiles ? ` -> ${outFile}` : ""}`);
  printFeed(run.feed);

  let publish: Publish;
  const databaseUrl = args["no-supabase"] ? null : env("DATABASE_URL");
  if (dryRun) publish = { state: "dry-run" };
  else if (before !== EXIT.OK) publish = { state: "skipped", why: "the run failed before any card could be trusted" };
  else if (args["no-supabase"]) publish = { state: "skipped", why: "--no-supabase" };
  else if (!databaseUrl) publish = { state: "skipped", why: "DATABASE_URL is not set" };
  else {
    try {
      publish = { state: "written", result: await publishCards(databaseUrl, sector, run.feed.cards, { keepDays }) };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const msg = redact(e.message ?? String(err));
      publish = { state: "failed", error: `${e.code ? `${e.code} ` : ""}${msg}` };
      if (e.code === "42P01" || e.code === "42703") console.log("  The table or a column is missing: run `pnpm --filter @falcon/engine run migrate` first.");
    }
  }

  const exitCode = runExitCode(run, judged, publish);
  const lines = summaryLines({ run, judged, judgeName: judge.name, publish, exitCode });
  console.log("\nRun summary");
  for (const l of lines) console.log(`  ${l}`);
  if (inActions) {
    for (const w of warningLines(run)) console.log(`::warning::${annotation(w)}`);
    if (exitCode !== EXIT.OK) console.log(`::error::${annotation(`Sightings run failed (exit ${exitCode}): ${exitReason(exitCode)}`)}`);
  }
  writeJobSummary(lines, run.feed);
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(redact(err instanceof Error ? err.message : String(err)));
    process.exitCode = EXIT.CRASH;
  },
);
