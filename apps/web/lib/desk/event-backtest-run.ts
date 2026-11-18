/**
 * The `event_backtest` tool, server side (wired in app/api/desk/chat/route.ts).
 * Server-only.
 *
 * Design: the helper runs in the test's own code execution sandbox, like every
 * Desk test, because the data is already there (load_events and load_prices
 * upload their files into it) and audit_run's harness re-runs a script's run()
 * in that sandbox. What changes is who writes the code: the model only
 * declares the rules (lib/desk/event-spec.ts); this file uploads Falcon's
 * helper (lib/desk/event-backtest-py.ts) and a generated script with those
 * rules, runs it with one bash command through a small Claude Haiku turn on
 * the same container (as the audit runs its harness), downloads
 * falcon_result.json, and checks the trades against the rules with Falcon's
 * events table and the daily bars read on the server (checkEventTrades).
 */

import { randomBytes } from "node:crypto";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { getDailyBars } from "./data";
import { checkEventTrades, describeEventRules, eventCountsLine, eventTestName, parseEventBacktestInput, skippedCheck, type CheckBars, type CheckEvent, type EventCheck, type EventRules } from "./event-spec";
import { EVENT_DIR, EVENT_HELPER_MODULE, EVENT_HELPER_PY, eventScript } from "./event-backtest-py";
import { RESULT_FILE, validateRunResult, type RunResult } from "./run-result";
import { CODE_EXECUTION_TOOL, MODEL, parseLoadPrices, type LoadPricesInput } from "./strategy-run";
import { DEFAULT_COLUMNS, LOAD_EVENTS_TOOL_NAME, eventTickersInTurns, fetchAllEvents, parseLoadEvents, supabaseEventPages, withEventTickers, type LoadEventsQuery, type Measure } from "./tools/load-events";
import { ToolError } from "./tools/util";

const RUNNER_MODEL = "claude-haiku-5-5";
/** Below this much time left the tool waits for the next request (the route hands off). */
export const EVENT_MIN_MS = 32_000;
export const EVENT_DEFER_TEXT = "Not enough time left in this step to run the event test. Call event_backtest again now with the same input; the next step has the time.";
const RUN_MAX_MS = 45_000;
const haikuUsd = (u: { in: number; out: number }) => (u.in * 0.1 + u.out * 0.5) / 1e6;
const opusUsd = (u: { in: number; out: number }) => (u.in * 4 + u.out * 20) / 1e6;

/* ------------------------------------------------------------------ the reply's data files */

type TurnLike = { role: string; content: unknown };
type Loaded<T> = { input: T; file: string };

/** Tool results of this reply by tool_use id (the JSON after the source-id line), successful ones only. */
function resultsById(turns: readonly object[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const t of turns as readonly TurnLike[]) {
    if (t.role !== "user" || !Array.isArray(t.content)) continue;
    for (const b of t.content as Record<string, unknown>[]) {
      if (b.type !== "tool_result" || b.is_error) continue;
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as { text?: string }[]).map((x) => x.text ?? "").join("") : "";
      try {
        const d = JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
        if (d && typeof d === "object" && !d.error) out.set(String(b.tool_use_id), d);
      } catch {
        // not JSON
      }
    }
  }
  return out;
}

/** The latest load_events and load_prices calls of these turns that returned a file. */
export function eventDataInTurns(turns: readonly object[]): { events: Loaded<LoadEventsQuery> | null; prices: Loaded<LoadPricesInput> | null } {
  const results = resultsById(turns);
  let events: Loaded<LoadEventsQuery> | null = null;
  let prices: Loaded<LoadPricesInput> | null = null;
  for (const t of turns as readonly TurnLike[]) {
    if (t.role !== "assistant" || !Array.isArray(t.content)) continue;
    for (const b of t.content as Record<string, unknown>[]) {
      if (b.type !== "tool_use") continue;
      const r = results.get(String(b.id));
      if (!r || typeof r.file !== "string") continue;
      try {
        if (b.name === LOAD_EVENTS_TOOL_NAME) events = { input: parseLoadEvents(b.input), file: r.file };
        else if (b.name === "load_prices") prices = { input: parseLoadPrices(withEventTickers(b.input, turns).input), file: r.file };
      } catch {
        // an input the tool rejected loaded nothing
      }
    }
  }
  return { events, prices };
}

/** Why the loaded files cannot answer these rules (null when they can): what to load instead. */
export function dataMismatch(r: EventRules, events: Loaded<LoadEventsQuery> | null, prices: Loaded<LoadPricesInput> | null, turns: readonly object[]): string | null {
  const want = `load_events with kinds ${JSON.stringify(r.event_kinds)}, measure "${r.measure}", min_abs_return ${r.threshold}, direction "${r.direction}", since "${r.since}"${r.until ? `, until "${r.until}"` : ""}`;
  if (!events) return `No load_events file in this reply yet. Call ${want}; then load_prices with tickers_from_events and start "${r.since}"; then event_backtest in a later step.`;
  const q = events.input;
  const gaps: string[] = [];
  if (!r.event_kinds.every((k) => q.kinds.includes(k))) gaps.push(`its kinds (${q.kinds.join(", ")}) leave out some of ${r.event_kinds.join(", ")}`);
  if (q.since && q.since > r.since) gaps.push(`it starts ${q.since}, after ${r.since}`);
  if (q.until && (!r.until || q.until < r.until)) gaps.push(`it ends ${q.until}`);
  if (q.tickers && (!r.tickers || !r.tickers.every((t) => q.tickers!.includes(t)))) gaps.push("it holds only some tickers");
  if (q.etf && q.etf !== r.sector_etf) gaps.push(`it holds only sector ${q.etf}`);
  if (q.min > 0 || q.direction !== "both") {
    if (q.measure !== r.measure) gaps.push(`it was filtered on ${q.measure}, the rules filter on ${r.measure}`);
    else if (q.min > r.threshold) gaps.push(`its threshold (${q.min}) is above the rules' (${r.threshold})`);
    if (q.direction !== "both" && q.direction !== r.direction) gaps.push(`it holds only ${q.direction} moves`);
  }
  if (!q.columns.includes(r.measure as (typeof q.columns)[number])) gaps.push(`it has no ${r.measure} column`);
  if (!q.columns.includes("filed_at")) gaps.push("it has no filed_at column");
  if (gaps.length) return `The load_events file ${events.file} cannot answer these rules: ${gaps.join("; ")}. Call ${want} (or a broader filter), then load_prices again with tickers_from_events of the new file, then event_backtest.`;
  if (!prices) return `No load_prices file in this reply yet. Call load_prices with tickers_from_events "${events.file}" and start "${r.since}", then event_backtest in a later step.`;
  const p = prices.input;
  const need: string[] = [];
  if (p.from > r.since) need.push(`it starts ${p.from}, after ${r.since}`);
  if (r.until && p.end < r.until) need.push(`it ends ${p.end}`);
  if (r.entry === "next_open" && !p.fields.includes("open")) need.push("it has no open prices");
  if (!p.tickers.includes(r.benchmark)) need.push(`it has no ${r.benchmark}`);
  const evTickers = eventTickersInTurns(turns, events.file)?.tickers ?? [];
  const have = new Set(p.tickers);
  const missing = evTickers.filter((t) => !have.has(t));
  if (missing.length > Math.max(5, evTickers.length * 0.02)) need.push(`it lacks ${missing.length} of the events' ${evTickers.length} tickers`);
  if (need.length) return `The load_prices file ${prices.file} cannot answer these rules: ${need.join("; ")}. Call load_prices with tickers_from_events "${events.file}", start "${r.since}", fields ["open", "close"], then event_backtest.`;
  return null;
}

/* ------------------------------------------------------------------ one command in the sandbox */

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

type CommandRun = { ids: string[]; stdout: string; stderr: string; rc: number | null; usd: number; error: string | null };

/** Uploads files into the container and runs one bash command there through a one-command model turn. */
async function runInContainer(client: Anthropic, o: { container: string; uploads: { name: string; text: string }[]; command: string; timeoutMs: number; signal: AbortSignal }): Promise<CommandRun> {
  const ids: string[] = [];
  let usd = 0;
  try {
    for (const u of o.uploads) ids.push((await client.files.upload({ file: await toFile(Buffer.from(u.text), u.name, { type: "text/x-python" }) }, { signal: o.signal })).id);
    const ask = (model: string) =>
      client.beta.messages.create(
        {
          model,
          max_tokens: 1_024,
          output_config: { effort: "low" },
          tools: [CODE_EXECUTION_TOOL],
          container: o.container,
          messages: [
            {
              role: "user",
              content: [...ids.map((file_id) => ({ type: "container_upload" as const, file_id })), { type: "text", text: `Run exactly this one bash command, unchanged, once. Then reply OK and nothing else.\n\n${o.command}` }],
            },
          ],
        },
        { signal: o.signal, timeout: Math.max(5_000, o.timeoutMs) },
      );
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await ask(RUNNER_MODEL);
      usd += haikuUsd({ in: msg.usage.input_tokens, out: msg.usage.output_tokens });
    } catch (error) {
      if (!(error instanceof Anthropic.BadRequestError) || o.signal.aborted) throw error;
      console.error("[desk/event_backtest] runner on", RUNNER_MODEL, error.message);
      msg = await ask(MODEL);
      usd += opusUsd({ in: msg.usage.input_tokens, out: msg.usage.output_tokens });
    }
    const out: CommandRun = { ids: [], stdout: "", stderr: "", rc: null, usd, error: null };
    for (const b of msg.content) {
      if (b.type !== "bash_code_execution_tool_result") continue;
      if (b.content.type === "bash_code_execution_result") {
        out.ids.push(...b.content.content.map((f) => f.file_id));
        out.stdout = b.content.stdout;
        out.stderr = b.content.stderr;
        out.rc = b.content.return_code;
      } else out.error = `Code execution error: ${b.content.error_code}`;
    }
    if (out.rc === null && !out.error) out.error = "The sandbox did not run the command.";
    return out;
  } catch (error) {
    if (!o.signal.aborted) console.error("[desk/event_backtest] runner", error instanceof Error ? error.message : String(error));
    return { ids: [], stdout: "", stderr: "", rc: null, usd, error: o.signal.aborted ? "Time ran out while the test ran." : "The test could not start in the sandbox." };
  } finally {
    for (const id of ids) void client.files.delete(id).catch(() => undefined);
  }
}

/** Downloads falcon_result.json among the command's output files (all are deleted afterwards). */
async function downloadResult(client: Anthropic, ids: string[], signal: AbortSignal): Promise<{ result: RunResult; problems: string[] } | { error: string } | null> {
  let found: { result: RunResult; problems: string[] } | { error: string } | null = null;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const meta = await client.files.retrieveMetadata(id, {}, { signal });
        if (meta.filename !== RESULT_FILE) return;
        const body = await (await client.files.download(id, {}, { signal })).text();
        const v = validateRunResult(JSON.parse(body));
        found = v.ok ? { result: v.result, problems: v.problems } : { error: v.problems.join(" ") };
      } catch (error) {
        if (!signal.aborted) console.error("[desk/event_backtest] download", error instanceof Error ? error.message : String(error));
      } finally {
        void client.files.delete(id).catch(() => undefined);
      }
    }),
  );
  return found;
}

/* ------------------------------------------------------------------ the check's data */

type CheckData = { events: CheckEvent[]; calendar: string[]; bars: Map<string, CheckBars> };
const checkData = new Map<string, { at: number; value: Promise<CheckData> }>();
const checks = new Map<string, EventCheck>();
const CHECK_TTL_MS = 15 * 60_000;

/** Falcon's events for the rules and the bars of their tickers over the price file's span (cached a while: the audit asks again). */
export function loadCheckData(r: EventRules, from: string, end: string, signal: AbortSignal): Promise<CheckData> {
  const key = JSON.stringify([r, from, end]);
  const hit = checkData.get(key);
  if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.value;
  const value = (async () => {
    const q: LoadEventsQuery = { tickers: r.tickers, etf: r.sector_etf, kinds: r.event_kinds, min: r.threshold, measure: r.measure as Measure, direction: r.direction, since: r.since, until: r.until, includeFlagged: false, columns: DEFAULT_COLUMNS };
    const { rows } = await fetchAllEvents(supabaseEventPages(q).fetch, q, signal);
    const events: CheckEvent[] = rows.map((x) => ({ ...x, ticker: x.ticker.trim().toUpperCase().replace(/[./]/g, "-"), accession: x.accession ?? "" }));
    const tickers = [...new Set([r.benchmark, ...events.map((e) => e.ticker)])].sort();
    const bars = new Map<string, CheckBars>();
    const got = await getDailyBars(tickers, from, end, signal, {
      sink: (t, b) => bars.set(t, { days: b.map((x) => x.date), open: b.map((x) => (x.open > 0 ? x.open : NaN)), close: b.map((x) => (x.close > 0 ? x.close : NaN)) }),
    });
    if (got.notLoaded.length) throw new Error(`${got.notLoaded.length} tickers did not load in time`);
    const bench = bars.get(r.benchmark);
    if (!bench) throw new Error(`no ${r.benchmark} prices`);
    const calendar = bench.days.filter((_, k) => bench.close[k]! > 0);
    return { events, calendar, bars };
  })();
  checkData.set(key, { at: Date.now(), value });
  value.catch(() => checkData.delete(key));
  while (checkData.size > 2) checkData.delete(checkData.keys().next().value!);
  return value;
}

/** The price file's span (from, end) of the reply's latest load_prices call. */
export function pricesSpan(turns: readonly object[]): { from: string; end: string } | null {
  const p = eventDataInTurns(turns).prices;
  return p ? { from: p.input.from, end: p.input.end } : null;
}

/**
 * Checks an event test's trades against its declared rules (checkEventTrades) with the server's events and bars.
 * Null for a result that is not an event test. Never throws: a check that cannot run comes back skipped.
 */
export async function checkEventResult(result: RunResult, turns: readonly object[], signal: AbortSignal): Promise<EventCheck | null> {
  const spec = result.spec;
  if (!spec) return null;
  const span = pricesSpan(turns) ?? { from: spec.rules.since, end: new Date().toISOString().slice(0, 10) };
  const key = JSON.stringify([spec.hash, spec.rules, span, result.period.end, result.trades.length, result.trades.slice(0, 3), result.trades.slice(-3)]);
  const cached = checks.get(key);
  if (cached) return cached;
  try {
    const d = await loadCheckData(spec.rules, span.from, span.end, signal);
    const c = checkEventTrades({
      rules: spec.rules,
      trades: result.trades,
      events: d.events,
      calendar: d.calendar,
      bars: d.bars,
      periodEnd: result.period.end,
      helperQualifying: spec.counts.qualifying,
      complete: result.trade_count <= result.trades.length,
    });
    checks.set(key, c);
    while (checks.size > 20) checks.delete(checks.keys().next().value!);
    return c;
  } catch (error) {
    if (!signal.aborted) console.error("[desk/event_backtest] check", error instanceof Error ? error.message : String(error));
    return skippedCheck(signal.aborted ? "The check of the trades against the rules ran out of time." : "Falcon's events or prices could not be read to check the trades against the rules.");
  }
}

/** Puts the check on the result: its spec block, and a visible warning when the trades do not follow the rules. */
export function withCheck(result: RunResult, check: EventCheck | null): RunResult {
  if (!result.spec || !check) return result;
  const warning = check.status === "flag" ? `The trades do not match the declared rules: ${check.detail}` : null;
  return { ...result, spec: { ...result.spec, check }, warnings: warning && !result.warnings.includes(warning) ? [warning, ...result.warnings] : result.warnings };
}

/* ------------------------------------------------------------------ the tool */

export type EventBacktestContext = {
  client: Anthropic;
  container: string | null;
  input: unknown;
  /** The conversation and this reply's turns (load_events and load_prices calls and results). */
  turns: readonly object[];
  budgetMs: number;
  signal: AbortSignal;
};

export type EventBacktestOutcome = {
  ok: boolean;
  /** tool_result text for the model. */
  content: string;
  label: string;
  ms: number;
  usd: number;
  /** The generated script (shown in the results panel; audit_run reads it by path). */
  script?: { path: string; code: string };
  command?: string;
  stdout?: { stdout: string; stderr: string; rc: number };
  result?: RunResult;
  problems?: string[];
  /** One line for the panel's log. */
  log?: string;
};

export function eventBacktestLabel(input: unknown, phase: "running" | "done"): string {
  try {
    const name = eventTestName(parseEventBacktestInput(input));
    return `${phase === "running" ? "Running" : "Ran"} Falcon's event test: ${name}`;
  } catch {
    return phase === "running" ? "Running Falcon's event test" : "Falcon's event test";
  }
}

/** Runs one event test. Never throws. */
export async function runEventBacktestTool(ctx: EventBacktestContext): Promise<EventBacktestOutcome> {
  const started = Date.now();
  const label = eventBacktestLabel(ctx.input, "done");
  const fail = (error: string, extra: Partial<EventBacktestOutcome> = {}): EventBacktestOutcome => ({ ok: false, content: JSON.stringify({ error }), label, ms: Date.now() - started, usd: 0, log: `event_backtest failed: ${error}`, ...extra });
  let rules: EventRules;
  try {
    rules = parseEventBacktestInput(ctx.input);
  } catch (error) {
    return fail(error instanceof ToolError ? error.message : "Bad input.");
  }
  const { events, prices } = eventDataInTurns(ctx.turns);
  const mismatch = dataMismatch(rules, events, prices, ctx.turns);
  if (mismatch) return fail(mismatch);
  if (!ctx.container) return fail("The sandbox is not ready yet. Call load_prices first, then event_backtest in the next step.");
  const plain = describeEventRules(rules);
  const name = eventTestName(rules);
  const id = randomBytes(3).toString("hex");
  const scriptName = `event_test_${id}.py`;
  const helperUpload = `${EVENT_HELPER_MODULE}_${id}.py`;
  const code = eventScript({ rules, name, plain, eventsFile: events!.file, pricesFile: prices!.file });
  const path = `${EVENT_DIR}/${scriptName}`;
  const pick = (n: string) => `"$(ls -t /files/input/*/${n} "$INPUT_DIR"/${n} 2>/dev/null | head -1)"`;
  const command = `mkdir -p ${EVENT_DIR} && cp ${pick(helperUpload)} ${shq(`${EVENT_DIR}/${EVENT_HELPER_MODULE}.py`)} && cp ${pick(scriptName)} ${shq(path)} && cd ${EVENT_DIR} && python3 ${scriptName}`;
  const budget = Math.min(RUN_MAX_MS, ctx.budgetMs);
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(budget)]);
  // The check's data loads while the sandbox runs.
  const span = { from: prices!.input.from, end: prices!.input.end };
  const dataP = loadCheckData(rules, span.from, span.end, signal).catch(() => null);
  const run = await runInContainer(ctx.client, {
    container: ctx.container,
    uploads: [
      { name: helperUpload, text: EVENT_HELPER_PY },
      { name: scriptName, text: code },
    ],
    command,
    timeoutMs: budget - 1_000,
    signal,
  });
  const base = { script: { path, code }, command, usd: run.usd, ...(run.rc !== null ? { stdout: { stdout: run.stdout.slice(-6_000), stderr: run.stderr.slice(-6_000), rc: run.rc } } : {}) };
  if (run.error) return { ...fail(`${run.error} Call event_backtest again with the same input.`, base), usd: run.usd };
  if (run.rc !== 0) {
    const last = run.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 600);
    return { ...fail(`The test stopped with an error: ${last || "no message"}`, base), usd: run.usd };
  }
  const got = await downloadResult(ctx.client, run.ids, signal);
  if (!got) return { ...fail("The test ran but wrote no falcon_result.json.", base), usd: run.usd };
  if ("error" in got) return { ...fail(`The result file could not be read: ${got.error}`, base), usd: run.usd };
  await dataP;
  const check = await checkEventResult(got.result, ctx.turns, signal);
  const result = withCheck(got.result, check);
  const spec = result.spec!;
  const content = JSON.stringify({
    status: "done",
    script_path: path,
    name,
    rules_hash: spec.hash,
    rules_plain: plain,
    counts: { ...spec.counts, summary: eventCountsLine(spec) },
    rules_check: check ? { status: check.status, detail: check.detail, ...(check.items.length ? { examples: check.items.slice(0, 4) } : {}) } : null,
    next: `Call audit_run with script_path "${path}" now (before writing anything). Then answer: state the rules tested in plain words (rules_plain; say these are Falcon's fixed defaults where the member did not specify), give the qualifying and entered counts, and quote figures only from the audit's panel numbers.${check?.status === "flag" ? " Say plainly that the trades do not match the declared rules, as the check found." : ""}`,
  });
  return {
    ok: true,
    content,
    label: `${label} (${(spec.counts.entered ?? 0).toLocaleString("en-US")} trades)`,
    ms: Date.now() - started,
    usd: run.usd,
    script: { path, code },
    command,
    stdout: { stdout: run.stdout.slice(-6_000), stderr: run.stderr.slice(-6_000), rc: run.rc ?? 0 },
    result,
    problems: got.problems,
    log: `Falcon's event helper: ${eventCountsLine(spec)} Rules hash ${spec.hash}.${check ? ` Rules check: ${check.status}.` : ""}`,
  };
}
