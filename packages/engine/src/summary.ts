/**
 * The end of a run: one exit code and a short summary of what happened, for
 * the terminal, the GitHub Actions job summary and its annotations.
 */

import type { RunResult } from "./pipeline.ts";
import type { PublishResult } from "./supabase.ts";

/**
 * Exit codes of the sightings CLI. Anything but OK fails the workflow.
 *   0 OK           the run finished (warnings, like one unreadable filing, do not change this)
 *   1 CRASH        bad arguments or an unexpected error
 *   2 NO_JUDGE     no ANTHROPIC_API_KEY and no --judgments: nothing judged, nothing written
 *   3 NO_SOURCES   not one watched company could be read (EDGAR down or blocking)
 *   4 JUDGE_FAILED every judge call failed (bad key, API down): nothing written
 *   5 PUBLISH_FAILED the Supabase write failed (rolled back)
 */
export const EXIT = { OK: 0, CRASH: 1, NO_JUDGE: 2, NO_SOURCES: 3, JUDGE_FAILED: 4, PUBLISH_FAILED: 5 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type Publish =
  | { state: "written"; result: PublishResult }
  | { state: "dry-run" }
  | { state: "skipped"; why: string }
  | { state: "failed"; error: string };

/** Companies that could not be checked at all (not one filing read). Pure. */
export function unreadableTickers(run: Pick<RunResult, "sourceProblems">): string[] {
  return [...new Set(run.sourceProblems.filter((p) => p.scope === "ticker").map((p) => p.ticker))];
}

/**
 * The exit code for a run that got as far as judging. Pure.
 * `judged` is how many events were sent to the judge.
 */
export function runExitCode(run: Pick<RunResult, "tickers" | "sourceProblems" | "judgeFailures">, judged: number, publish: Publish): ExitCode {
  if (run.tickers.length > 0 && unreadableTickers(run).length >= run.tickers.length) return EXIT.NO_SOURCES;
  if (judged > 0 && run.judgeFailures.length >= judged) return EXIT.JUDGE_FAILED;
  if (publish.state === "failed") return EXIT.PUBLISH_FAILED;
  return EXIT.OK;
}

/** One line on why a run failed, for the log and the workflow annotation. Pure. */
export function exitReason(code: ExitCode): string {
  switch (code) {
    case EXIT.OK:
      return "ok";
    case EXIT.CRASH:
      return "the run crashed";
    case EXIT.NO_JUDGE:
      return "no judge (ANTHROPIC_API_KEY missing): nothing judged, nothing published";
    case EXIT.NO_SOURCES:
      return "not one watched company could be read from EDGAR: nothing published";
    case EXIT.JUDGE_FAILED:
      return "every judge call failed (check ANTHROPIC_API_KEY and the Claude API): nothing published";
    case EXIT.PUBLISH_FAILED:
      return "the Supabase write failed and was rolled back";
  }
}

export type SummaryInput = {
  run: RunResult;
  judged: number;
  judgeName: string;
  publish: Publish;
  exitCode: ExitCode;
};

/** The run summary as plain lines. Pure. */
export function summaryLines(s: SummaryInput): string[] {
  const { run } = s;
  const meta = run.feed.meta;
  const bad = unreadableTickers(run);
  const filingProblems = run.sourceProblems.filter((p) => p.scope === "filing").length;
  const lines = [
    `window: ${meta?.since ?? "?"} to ${meta?.until ?? "?"} (sector ${meta?.sector ?? "?"})`,
    `companies: ${run.tickers.length} watched, ${run.tickers.length - bad.length} read${bad.length ? `, unreadable: ${bad.join(", ")}` : ""}`,
    `events found: ${run.events.length}${filingProblems ? ` (${filingProblems} filings unreadable)` : ""}`,
    `judged: ${s.judged} events by ${s.judgeName}${run.judgeFailures.length ? `, ${run.judgeFailures.length} failed` : ""}${run.rejected.length ? `, ${run.rejected.length} answers dropped by validation` : ""}`,
    `judge votes: ${run.votes.calls} calls of ${run.votes.maxCalls} allowed, ${run.votes.splits.filter((x) => x.escalated).length} candidates needed a second round`,
    `cards in the feed: ${run.feed.cards.length}`,
    `history: ${run.history.measured} of ${run.history.hits} hits measured${run.history.problems.length ? ` (${run.history.problems.join("; ")})` : ""}`,
    `ranking: ${run.ranking.capped.length} hits capped by their record, ${run.ranking.dropped.length} dropped${run.ranking.droppedCards.length ? `, ${run.ranking.droppedCards.length} cards left with no hit` : ""}`,
  ];
  if (run.yahooProblems.length) lines.push(`yahoo: ${run.yahooProblems.length} problems, EPS surprise figures may be missing (${run.yahooProblems[0]})`);
  const p = s.publish;
  if (p.state === "written") lines.push(`supabase: ${p.result.upserted} cards written, ${p.result.markedStale} marked stale, ${p.result.fresh} fresh cards in the sector`);
  else if (p.state === "dry-run") lines.push("supabase: dry run, nothing written");
  else if (p.state === "skipped") lines.push(`supabase: not written (${p.why})`);
  else lines.push(`supabase: write failed, rolled back (${p.error})`);
  lines.push(`exit code: ${s.exitCode}${s.exitCode === EXIT.OK ? "" : ` (${exitReason(s.exitCode)})`}`);
  return lines;
}

/** Warnings worth an annotation in GitHub Actions. Pure. */
export function warningLines(run: RunResult): string[] {
  return [
    ...run.sourceProblems.map((p) => `${p.ticker}: ${p.message}`),
    ...run.judgeFailures.map((f) => `judge failed on ${f.eventId}: ${f.message}`),
    ...run.yahooProblems.map((y) => `yahoo ${y}`),
    ...run.history.problems.map((h) => `history ${h}`),
  ];
}
