/**
 * The Desk audit, server side: the `audit_run` tool Claude calls after a
 * strategy test runs, and what the route does for it. Server-only.
 *
 * Three independent parts run in parallel within the request's time budget:
 *   1. Code review: Claude Haiku 5.5 reads the final script (numbered lines)
 *      and lists look-ahead problems with line numbers. About $0.001.
 *   2. Re-runs: the fixed harness (lib/desk/audit-harness.ts) is uploaded
 *      with the Files API into the test's own sandbox (same container, data
 *      already there) and run by a one-command Claude Haiku turn with the code
 *      execution tool. It calls the script's run() with costs x2, lag +1 day
 *      and random-pick placebos and writes falcon_audit.json. The sandbox has
 *      one CPU, so a slow run() may not finish its 23 re-runs in one request:
 *      the harness saves every finished one in the sandbox and the audit then
 *      continues in the next request (AUDIT_CONTINUE_TEXT, at most
 *      AUDIT_MAX_CONTINUES times). Whatever is still missing after that is
 *      reported as incomplete and never counts as passed (lib/desk/audit.ts).
 *   3. Bars: the daily bars the test loaded, from the server's price cache,
 *      for the fill, timing and hindsight checks.
 * lib/desk/audit.ts turns them into checks and the evidence label.
 */

import { randomBytes } from "node:crypto";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { getDailyBars } from "./data";
import { AUDIT_FILE, HARNESS_PY } from "./audit-harness";
import { auditForModel, buildDeskAudit, parseHarnessOutput, parseReview, type AuditUniverse, type CodeReview, type DayBar, type DeskAudit, type HarnessOutput } from "./audit";
import { RESULT_FILE, validateRunResult, type RunResult } from "./run-result";
import { isContextText } from "./history-context";
import { CODE_EXECUTION_TOOL, MODEL, parseLoadPrices, type LoadPricesInput } from "./strategy-run";
import { isCanonicalEventScript } from "./event-backtest-py";
import { checkEventResult } from "./event-backtest-run";
import { LOAD_EVENTS_TOOL_NAME } from "./tools/load-events";

export const AUDIT_MODEL = "claude-haiku-5-5";

export const AUDIT_TOOL = {
  name: "audit_run",
  description:
    "Audits the strategy test you just ran, independently of your script: a code review for look-ahead, fill prices against each day's high and low, entry timing, trading costs, re-runs of your script's run() with costs doubled, the signal one day later and random-pick placebo versions, and, for a list chosen today, the list held at equal weight. Call it once after the script has written falcon_result.json, before you write the summary. Returns the evidence label the member sees and the flags.",
  input_schema: {
    type: "object",
    properties: { script_path: { type: "string", description: "Path of the script that wrote falcon_result.json, as you created it (e.g. backtest.py)." } },
    required: ["script_path"],
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

/** Below this much time left, the audit waits for the next request (the tool asks to be called again). */
export const AUDIT_MIN_MS = 30_000;
/** The tool_result when the audit waits for the next request (the route hands off right after it). */
export const AUDIT_DEFER_TEXT = "Not enough time left in this step for the audit. Call audit_run again now with the same input; the next step has the time.";
/**
 * The tool_result when the re-runs are still going (finished ones are saved in the sandbox): the model calls audit_run
 * again and the route hands off to a new request first. Plain words only (it is matched inside the JSON tail).
 */
export const AUDIT_CONTINUE_TEXT = "The audit re-runs are still going in the sandbox and the finished ones are saved there. Call audit_run again now with the same input; the next step carries on from where they stopped.";
/** Requests the re-runs may continue into after the first (each about 25 s of re-runs). */
export const AUDIT_MAX_CONTINUES = 3;
/** At most this long for the whole audit. */
const AUDIT_MAX_MS = 42_000;
/** Kept for the Haiku turn around the harness and the downloads. */
const HARNESS_OVERHEAD_MS = 14_000;
const PLACEBOS = 20;
const HARNESS_TIMEOUT = "The re-runs ran out of time.";

/** USD for Claude Haiku 5.5 ($0.10 in, $0.50 out per million; prompts under 100K). */
const haikuUsd = (u: { in: number; out: number }) => (u.in * 0.1 + u.out * 0.5) / 1e6;
/** USD for Claude Opus 5.5 (fallback runner). */
const opusUsd = (u: { in: number; out: number }) => (u.in * 4 + u.out * 20) / 1e6;

/* ------------------------------------------------------------------ universe */

/** A load_prices call of this reply; `typedSpy` when SPY was asked for as a ticker (not only added as the benchmark); `typed` the tickers asked for. */
export type AuditLoad = LoadPricesInput & { typedSpy: boolean; typed?: string[] };

/** The lists the reply loaded, from its load_prices calls (in the reply's turns, which survive a resume). */
export function loadsInTurns(turns: Anthropic.Beta.BetaMessageParam[]): AuditLoad[] {
  const out: AuditLoad[] = [];
  for (const m of turns) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_use" || b.name !== "load_prices") continue;
      try {
        const raw = (b.input as { tickers?: unknown }).tickers;
        out.push({ ...parseLoadPrices(b.input), typedSpy: Array.isArray(raw) && raw.some((t) => String(t).toUpperCase() === "SPY"), typed: Array.isArray(raw) ? raw.map((t) => String(t).toUpperCase().trim()) : [] });
      } catch {
        // a call the tool rejected loaded nothing
      }
    }
  }
  return out;
}

export function auditUniverse(loads: AuditLoad[]): AuditUniverse | null {
  if (!loads.length) return null;
  const set = new Set<string>();
  let typedSpy = false;
  let named: AuditLoad | null = null;
  let typedOther = false;
  for (const l of loads) {
    l.tickers.forEach((t) => set.add(t));
    typedSpy ||= l.typedSpy;
    if (l.universe) named = l;
    else typedOther = true;
  }
  // The benchmark is not part of the traded list (SPY unless typed; another benchmark ticker unless typed as a ticker too).
  const benches = new Set(loads.map((l) => l.benchmark).filter((b) => b && b !== "SPY"));
  const typed = new Set(loads.flatMap((l) => l.typed ?? []));
  const tickers = Array.from(set).filter((t) => (t !== "SPY" || typedSpy) && (!benches.has(t) || typed.has(t)));
  // SPY on its own is the benchmark, not a list.
  const list = tickers.length === 1 && tickers[0] === "SPY" ? [] : tickers;
  return {
    tickers: list,
    listName: named?.universeLabel ?? null,
    todaysPick: Boolean(named?.todaysPick),
    fixedSet: named?.universe === "sector_etfs" && !typedOther,
  };
}

/** The benchmark ticker the reply's last load_prices call asked for (null when none was named: SPY by default). */
export function loadsBenchmark(loads: AuditLoad[]): string | null {
  for (let i = loads.length - 1; i >= 0; i--) if (loads[i]!.benchmark && loads[i]!.benchmark !== "SPY") return loads[i]!.benchmark;
  return null;
}

/* ------------------------------------------------------------------ 1. code review */

const REVIEW_SYSTEM = `You review Python backtest scripts for look-ahead bias. Daily bars: a signal computed from data up to day t's close can only trade from day t+1's open (or later).
Report only real problems you can point to in the code:
- same-bar fills: trading at the close (or open) of the same day whose close computed the signal; positions applied to the same day's return that set them (e.g. position[t] * return[t] where position uses close[t]) without a shift;
- future data: shift(-k), center=True rolling windows, bfill across time, statistics or rankings computed over the whole sample (full-period mean, std, max, quantiles, normalisation) used to decide past trades, using a later row's values;
- shift mistakes: signal or entry shifted the wrong way, off-by-one so the trade uses the bar it reacts to, look-back returns that include the trade day;
- survivorship the code adds: dropping tickers without full history over the whole period, choosing names by data after the start, forward-filling prices of names before they listed.
Do not report style, speed, or the fact that the input list is today's index membership (that is checked separately). Do not report something the code already handles correctly. Severity: high = the result uses information not available at the time of the trade; medium = likely but depends on data; low = minor.
Reply with JSON only: {"issues": [{"line": <line number>, "severity": "high"|"medium"|"low", "kind": "same-bar fill"|"future data"|"shift"|"survivorship"|"other", "issue": "<one plain sentence>"}]} and {"issues": []} when the script is clean.`;

export async function reviewScript(client: Anthropic, code: string, signal: AbortSignal): Promise<{ review: CodeReview; usd: number }> {
  const lines = code.split("\n");
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join("\n").slice(0, 60_000);
  try {
    const r = await client.messages.create(
      {
        model: AUDIT_MODEL,
        max_tokens: 3_000,
        output_config: { effort: "low" },
        system: REVIEW_SYSTEM,
        messages: [{ role: "user", content: `The script (line numbers on the left):\n\n${numbered}` }],
      },
      { signal },
    );
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { review: parseReview(text, lines.length), usd: haikuUsd({ in: r.usage.input_tokens, out: r.usage.output_tokens }) };
  } catch (error) {
    if (!signal.aborted) console.error("[desk/audit] review", error instanceof Error ? error.message : String(error));
    return { review: { ok: false, error: signal.aborted ? "The code review ran out of time." : "The code review could not run." }, usd: 0 };
  }
}

/* ------------------------------------------------------------------ 2. re-runs in the sandbox */

/** Downloads the named output files among `ids` (and deletes every one of them afterwards). */
async function downloadNamed(client: Anthropic, ids: string[], names: string[], signal: AbortSignal): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const meta = await client.files.retrieveMetadata(id, {}, { signal });
        if (names.includes(meta.filename) && meta.size_bytes < 9_000_000) out[meta.filename] = await (await client.files.download(id, {}, { signal })).text();
      } catch (error) {
        if (!signal.aborted) console.error("[desk/audit] download", error instanceof Error ? error.message : String(error));
      } finally {
        void client.files.delete(id).catch(() => undefined);
      }
    }),
  );
  return out;
}

/** Shell-quotes a path for the one bash command. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function runHarness(
  client: Anthropic,
  opts: { container: string; scriptPath: string; budgetMs: number; copyResult: boolean; signal: AbortSignal },
): Promise<{ harness: HarnessOutput | null; result: RunResult | null; error: string | null; usd: number }> {
  const budgetS = Math.max(6, Math.round((opts.budgetMs - HARNESS_OVERHEAD_MS) / 1000));
  const name = `falcon_audit_${randomBytes(3).toString("hex")}.py`;
  let fileId: string | null = null;
  let usd = 0;
  try {
    fileId = (await client.files.upload({ file: await toFile(Buffer.from(HARNESS_PY), name, { type: "text/x-python" }) }, { signal: opts.signal })).id;
    const command = `python3 "$(ls -t /files/input/*/${name} "$INPUT_DIR"/${name} 2>/dev/null | head -1)" --script ${shq(opts.scriptPath)} --budget ${budgetS} --placebos ${PLACEBOS}${opts.copyResult ? " --copy-result" : ""}`;
    const ask = async (model: string) =>
      client.beta.messages.create(
        {
          model,
          max_tokens: 1_024,
          output_config: { effort: "low" },
          tools: [CODE_EXECUTION_TOOL],
          container: opts.container,
          messages: [
            {
              role: "user",
              content: [
                { type: "container_upload", file_id: fileId! },
                { type: "text", text: `Run exactly this one bash command, unchanged, once. Then reply OK and nothing else.\n\n${command}` },
              ],
            },
          ],
        },
        { signal: opts.signal, timeout: Math.max(5_000, opts.budgetMs - 1_000) },
      );
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await ask(AUDIT_MODEL);
      usd += haikuUsd({ in: msg.usage.input_tokens, out: msg.usage.output_tokens });
    } catch (error) {
      // A model without the code execution tool here: the main model runs the one command instead.
      if (!(error instanceof Anthropic.BadRequestError) || opts.signal.aborted) throw error;
      console.error("[desk/audit] harness on", AUDIT_MODEL, error.message);
      msg = await ask(MODEL);
      usd += opusUsd({ in: msg.usage.input_tokens, out: msg.usage.output_tokens });
    }
    const results = msg.content.filter((b): b is Anthropic.Beta.BetaBashCodeExecutionToolResultBlock => b.type === "bash_code_execution_tool_result");
    const ids: string[] = [];
    let stderr = "";
    for (const b of results) {
      if (b.content.type === "bash_code_execution_result") {
        ids.push(...b.content.content.map((f) => f.file_id));
        stderr = b.content.stderr.slice(-300);
      }
    }
    if (!ids.length) return { harness: null, result: null, error: `The re-runs produced no output${stderr ? ` (${stderr.trim().split("\n").pop()})` : ""}.`, usd };
    const files = await downloadNamed(client, ids, [AUDIT_FILE, RESULT_FILE], opts.signal);
    let harness: HarnessOutput | null = null;
    if (files[AUDIT_FILE]) {
      try {
        harness = parseHarnessOutput(JSON.parse(files[AUDIT_FILE]!));
      } catch {
        harness = null;
      }
    }
    let result: RunResult | null = null;
    if (files[RESULT_FILE]) {
      try {
        const v = validateRunResult(JSON.parse(files[RESULT_FILE]!));
        if (v.ok) result = v.result;
      } catch {
        result = null;
      }
    }
    return { harness, result, error: harness ? null : "The re-runs did not write their results.", usd };
  } catch (error) {
    if (!opts.signal.aborted) console.error("[desk/audit] harness", error instanceof Error ? error.message : String(error));
    return { harness: null, result: null, error: opts.signal.aborted ? HARNESS_TIMEOUT : "The re-runs could not start in the sandbox.", usd };
  } finally {
    if (fileId) void client.files.delete(fileId).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ 3. bars */

/** The data note shown with the results: which source answered, and the July 2024 boundary. */
export function dataSourceNote(source: string | null): string | null {
  if (!source) return null;
  if (/databento/i.test(source)) return "Prices: Databento daily bars (Falcon's store starts July 2024), split-adjusted, price return without dividends.";
  return "Prices: Yahoo Finance daily bars, split- and dividend-adjusted. Falcon's Databento store starts July 2024, so tests starting earlier use Yahoo for the whole period.";
}

export async function loadAuditBars(loads: LoadPricesInput[], signal: AbortSignal): Promise<{ bars: Map<string, DayBar[]>; source: string } | null> {
  if (!loads.length) return null;
  const tickers = Array.from(new Set(loads.flatMap((l) => l.tickers)));
  const from = loads.map((l) => l.from).sort()[0]!;
  const end = loads.map((l) => l.end).sort().pop()!;
  try {
    // The same span load_prices asked for: served from the price cache it just filled.
    const got = await getDailyBars(tickers, from, end, signal);
    return got.bars.size ? { bars: got.bars, source: got.source } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ the tool */

export type AuditContext = {
  client: Anthropic;
  container: string | null;
  /** The script the model named, and the scripts the route has seen this reply. */
  input: unknown;
  files: Record<string, string>;
  lastScript: string;
  /** The result downloaded this request, if any (else the harness copies it back). */
  result: RunResult | null;
  /** This reply's turns (load_prices calls), and the conversation (intent, trials). */
  tail: Anthropic.Beta.BetaMessageParam[];
  messages: Anthropic.Beta.BetaMessageParam[];
  budgetMs: number;
  signal: AbortSignal;
  /** The reply can still resume in a new request (the route hands off when the outcome is `continued`). */
  canContinue?: boolean;
};

/** `continued`: the re-runs carry on in the next request (no audit yet; the route hands off). */
export type AuditOutcome = { ok: boolean; content: string; label: string; audit?: DeskAudit; ms: number; usd: number; continued?: boolean };

/** How many times this reply's audit already continued (its tool results in the reply's turns). */
export function auditContinues(tail: Anthropic.Beta.BetaMessageParam[]): number {
  return JSON.stringify(tail).split(AUDIT_CONTINUE_TEXT).length - 1;
}

/**
 * Whether the re-runs should carry on in the next request instead of the audit settling now: some are still pending
 * (or the harness answer was lost to the time limit), continues are left, and the last call made progress (a version
 * longer than a whole request would never finish; the first continue is always tried).
 */
export function shouldContinue(o: { harness: HarnessOutput | null; error: string | null; continues: number; canContinue: boolean }): boolean {
  if (!o.canContinue || o.continues >= AUDIT_MAX_CONTINUES) return false;
  const h = o.harness;
  if (!h) return o.error === HARNESS_TIMEOUT && o.continues === 0;
  if (h.error || h.complete !== false) return false;
  return (h.ran ?? 0) > 0 || o.continues === 0;
}

/** A turn's own words; `context`: with the app's history context blocks (lib/desk/history-context.ts). */
const textOf = (m: Anthropic.Beta.BetaMessageParam, context = false) =>
  typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b) => (b.type === "text" && (context || !isContextText(b.text)) ? b.text : "")).join("\n") : "";

/** Runs the audit. Never throws. */
export async function runAuditTool(ctx: AuditContext): Promise<AuditOutcome> {
  const started = Date.now();
  const scriptPath = String((ctx.input as { script_path?: unknown })?.script_path ?? "").trim().slice(0, 300) || Object.keys(ctx.files).pop() || "backtest.py";
  const code = ctx.files[scriptPath] ?? ctx.files[Object.keys(ctx.files).find((k) => k.endsWith(`/${scriptPath.replace(/^.*\//, "")}`)) ?? ""] ?? (ctx.lastScript || ctx.result?.code || "");
  const budgetMs = Math.min(AUDIT_MAX_MS, ctx.budgetMs);
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)]);
  const loads = loadsInTurns(ctx.tail);
  // Falcon's event-backtest script, unedited: nothing model-written to review (the helper is unit-tested), and the
  // review's verdict would be the one part of the audit that can differ run to run.
  const canonical = !!code && isCanonicalEventScript(code);
  const turns = [...ctx.messages, ...ctx.tail];
  const checkSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(20_000, budgetMs))]);
  // Started with the other parts when the result is already here (usually cached from the event_backtest call).
  const earlyCheck = ctx.result?.spec ? checkEventResult(ctx.result, turns, checkSignal) : null;

  const [rev, run, loaded] = await Promise.all([
    code && !canonical ? reviewScript(ctx.client, code, AbortSignal.any([signal, AbortSignal.timeout(Math.min(25_000, budgetMs))])) : Promise.resolve(null),
    ctx.container
      ? runHarness(ctx.client, { container: ctx.container, scriptPath, budgetMs: budgetMs - 1_000, copyResult: !ctx.result, signal })
      : Promise.resolve({ harness: null, result: null, error: "The test's sandbox is not known, so the script could not be re-run.", usd: 0 }),
    loadAuditBars(loads, AbortSignal.any([signal, AbortSignal.timeout(12_000)])),
  ]);
  const bars = loaded?.bars ?? null;
  const result = ctx.result ?? run.result;
  const usd = (rev?.usd ?? 0) + run.usd;
  const ms = Date.now() - started;
  if (!result) {
    console.error("[desk/audit] no result", JSON.stringify({ ms, harnessError: run.harness?.error ?? run.error, errors: run.harness?.errors ?? [] }));
    return { ok: false, content: JSON.stringify({ error: "No falcon_result.json from this test was found, so it could not be audited. Make sure the script wrote it and copied it to $OUTPUT_DIR." }), label: "Could not audit the test", ms, usd };
  }
  const continues = auditContinues(ctx.tail);
  const progress = (h: HarnessOutput | null) =>
    h ? `${h.placebo.length} of ${h.placebo_wanted} random versions${h.costs_x2 && h.lag_plus1 ? ", doubled costs and the one-day delay" : ""} done` : "re-runs started";
  if (shouldContinue({ harness: run.harness, error: run.error, continues, canContinue: !!ctx.canContinue })) {
    console.info("[desk/audit] continue", JSON.stringify({ ms, continues: continues + 1, placebos: run.harness?.placebo.length ?? null, pending: run.harness?.pending.length ?? null, jobS: run.harness?.job_s ?? null, ran: run.harness?.ran ?? null }));
    return { ok: true, continued: true, content: JSON.stringify({ status: "continuing", progress: progress(run.harness), note: AUDIT_CONTINUE_TEXT }), label: `Audit re-runs: ${progress(run.harness)}, continuing`, ms, usd };
  }
  // An event test from declared rules: its trades against the rules (cached from the run; recomputed after a resume).
  const eventCheck = earlyCheck ? await earlyCheck : result.spec ? await checkEventResult(result, turns, checkSignal) : null;
  const loadedEvents = ctx.tail.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.name === LOAD_EVENTS_TOOL_NAME));
  const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user");
  // Earlier tests in this conversation: the history context names each finished one (older clients: a note in the reply).
  const trials = 1 + ctx.messages.filter((m) => (m.role === "user" ? textOf(m, true).includes("Strategy test in your previous reply:") : textOf(m).includes("[Strategy test in this reply:"))).length;
  const audit = buildDeskAudit({
    result,
    review: rev?.review ?? null,
    harness: run.harness,
    harnessError: run.error,
    bars,
    universe: auditUniverse(loads),
    intent: lastUser ? textOf(lastUser) : "",
    trials,
    today: new Date().toISOString().slice(0, 10),
    dataSource: dataSourceNote(loaded?.source ?? null),
    benchmarkHint: loadsBenchmark(loads),
    canonicalScript: canonical && !!result.spec,
    eventCheck,
    customEventScript: !result.spec && loadedEvents,
  });
  console.info(
    "[desk/audit]",
    JSON.stringify({ ms, usd: Number(usd.toFixed(4)), label: audit.label.level, flags: audit.checks.filter((c) => c.status === "flag").map((c) => c.id), placebos: run.harness?.placebo.length ?? 0, pending: run.harness?.pending.length ?? null, hops: run.harness?.hops ?? null, jobS: run.harness?.job_s ?? null, harness: run.harness?.elapsed_s ?? null, harnessError: run.harness?.error ?? run.error }),
  );
  return { ok: true, content: auditForModel(audit), label: `Audited the test: ${audit.label.title}`, audit, ms, usd };
}
