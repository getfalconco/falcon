/**
 * Strategy tests on the Desk: the `load_prices` tool, the code execution
 * tool, the result file and the resume token. Server-only.
 *
 * How a test runs (wired in app/api/desk/chat/route.ts):
 *   1. Claude calls `load_prices`. The route loads daily bars (lib/desk/data.ts),
 *      writes them as one gzipped CSV, uploads it with the Files API and puts a
 *      `container_upload` block next to the tool_result, so the file appears in
 *      the code execution sandbox. A tiny request (`prepareContainer`) runs in
 *      parallel so the route knows the sandbox's container id from the start.
 *   2. Claude writes and runs Python with the code execution tool
 *      (`code_execution_20260521`, Anthropic-hosted, no internet). The script
 *      writes RESULT_FILE and copies it to $OUTPUT_DIR; the route downloads it
 *      (`readResultFile`) and checks it (lib/desk/run-result.ts).
 *   3. Netlify ends a function after 60 s. When a test needs longer, the route
 *      stops at a block boundary and sends a signed resume token; the client
 *      calls again with it and the conversation carries on in the same
 *      container (`signResume` / `verifyResume`).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { DESK_UNIVERSES, getDailyBars, universeTickers, type DeskUniverse, type LoadProgress } from "./data";
import type { Bar } from "@falcon/backtest/data";
import { MAX_RESULT_BYTES, RESULT_FILE, validateRunResult, type RunResult } from "./run-result";
import { ToolError, normalizeTicker } from "./tools/util";

export const MODEL = "claude-opus-5-5";

/** Anthropic's code execution tool (server-side Python + bash sandbox). No beta header needed. */
export const CODE_EXECUTION_TOOL = { type: "code_execution_20260521", name: "code_execution" } as const;

export const PRICE_FIELDS = ["open", "high", "low", "close", "volume"] as const;
type Field = (typeof PRICE_FIELDS)[number];

export const MAX_TICKERS = 600;
/** With tickers_from_events (every ticker of a load_events file, lib/desk/tools/load-events.ts). */
export const MAX_EVENT_TICKERS = 1500;
/** Years from start to end: 10 for lists, up to 30 for a few tickers (the file stays about the same size). */
const MAX_YEARS = 10;
/**
 * A window starting on or after this day may run to today in one call, whatever the number of tickers (an event
 * test "since 2016" over ~1,000 tickers): Yahoo answers each ticker's whole span in one request, and the file
 * stays under MAX_ROWS.
 */
export const LONG_FROM = "2015-01-01";
/** Rows in one price file (about 1,500 tickers x 12 years; ~40 MB gzipped with open and close). */
export const MAX_ROWS = 5_000_000;
const MAX_YEARS_FEW = 30;
const FEW_TICKERS = 50;
const DEFAULT_WARMUP_DAYS = 400;
const EARLIEST = "1995-01-01";
const BENCHMARK = "SPY";

export const LOAD_PRICES_TOOL = {
  name: "load_prices",
  description:
    "Loads daily price bars into the code execution sandbox for a strategy test (the sandbox has no internet; this is its only market data). Split- and dividend-adjusted daily bars (Yahoo Finance), one gzipped CSV in long format: date,ticker,<fields>. SPY is always included. The benchmark is SPY unless the member asked for another: pass it as benchmark (a ticker such as AGG or QQQ; it is loaded too), or, for a custom one (e.g. the basket held at equal weight), build it in the script and name it in the result's \"benchmark\". Give a named universe, explicit tickers, or both (at most 600 tickers, or every ticker of an earlier load_events file with tickers_from_events, up to 1,500). Any start from 2015-01-01 to today loads in ONE call (e.g. 2016-01-01 to today for an event test since 2016: never split it); a start before 2015 allows at most 10 years from start to end, or 30 years for up to 50 tickers. A big cold load can take a while; if time runs out the server finishes it on its own in the next step (do not call again). Rows before `start` are warm-up history for look-back signals (default 400 calendar days). Returns the file's path in the sandbox and what loaded; then, in the next step, run event_backtest for an event-driven test, or write and run the Python test with code execution.",
  input_schema: {
    type: "object",
    properties: {
      universe: {
        type: "string",
        enum: [...DESK_UNIVERSES],
        description:
          "Named list (today's membership, so tests over past years carry survivorship and hindsight bias): sp500_today (S&P 500 members today), us_large_caps (500 most traded US stocks), falcon_universe (1,500 US companies Falcon covers), falcon_graph (companies in Falcon's supply-chain graph), falcon_semis (58 semiconductor companies), sector_etfs (11 Select Sector SPDRs).",
      },
      tickers: { type: "array", items: { type: "string", maxLength: 10 }, maxItems: MAX_TICKERS, description: "Explicit symbols, e.g. [\"SPY\", \"QQQ\", \"AAPL\"]." },
      start: { type: "string", description: "First day of the test, YYYY-MM-DD." },
      end: { type: "string", description: "Last day of the test, YYYY-MM-DD (default: today)." },
      fields: { type: "array", items: { type: "string", enum: [...PRICE_FIELDS] }, description: "Columns to load besides date and ticker. Default [\"open\", \"close\"]; add high/low for intraday stops, volume for liquidity filters." },
      warmup_days: { type: "integer", minimum: 0, maximum: 800, description: "Calendar days of history before start for look-back signals (default 400)." },
      tickers_from_events: {
        type: "string",
        maxLength: 40,
        description: "Instead of listing the tickers of an event test: the file name an earlier load_events call of this reply returned (e.g. events_ab12cd.csv.gz). Loads every ticker in it (up to 1,500) plus any in tickers, in one call for any span from 2015-01-01 on.",
      },
      benchmark: { type: "string", maxLength: 10, description: "The benchmark ticker the member asked for (default SPY). Loaded with the rest; do not repeat it in tickers. Leave it out for a custom benchmark built in the script." },
    },
    required: ["start"],
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

export type LoadPricesInput = {
  tickers: string[];
  universe: DeskUniverse | null;
  universeLabel: string | null;
  todaysPick: boolean;
  start: string;
  end: string;
  from: string;
  fields: Field[];
  /** The benchmark ticker (SPY unless the member asked for another). */
  benchmark: string;
};

/** Checks and normalizes the tool input; throws ToolError with a message the model can act on. */
export function parseLoadPrices(input: unknown, today = iso(Date.now())): LoadPricesInput {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let universe: DeskUniverse | null = null;
  let universeLabel: string | null = null;
  let todaysPick = false;
  const set = new Set<string>();
  if (i.universe !== undefined) {
    if (typeof i.universe !== "string" || !(DESK_UNIVERSES as readonly string[]).includes(i.universe)) throw new ToolError(`universe must be one of ${DESK_UNIVERSES.join(", ")}.`);
    universe = i.universe as DeskUniverse;
    const u = universeTickers(universe);
    u.tickers.forEach((t) => set.add(t));
    universeLabel = u.label;
    todaysPick = u.todaysPick;
  }
  const bad: string[] = [];
  for (const t of Array.isArray(i.tickers) ? i.tickers : []) {
    try {
      set.add(normalizeTicker(t));
    } catch {
      bad.push(String(t).slice(0, 12));
    }
  }
  if (bad.length) throw new ToolError(`Not US tickers: ${bad.slice(0, 10).join(", ")}. Use symbols such as AAPL or BRK.B.`);
  let benchmark = BENCHMARK;
  if (typeof i.benchmark === "string" && i.benchmark.trim()) {
    try {
      benchmark = normalizeTicker(i.benchmark);
    } catch {
      throw new ToolError(`benchmark must be a ticker such as SPY, QQQ or AGG (got ${String(i.benchmark).slice(0, 12)}). For a custom benchmark, leave it out and build it in the script.`);
    }
  }
  set.add(BENCHMARK);
  set.add(benchmark);
  if (!universe && !(Array.isArray(i.tickers) && i.tickers.length)) throw new ToolError("Give a universe or a list of tickers.");
  const cap = typeof i.tickers_from_events === "string" ? MAX_EVENT_TICKERS : MAX_TICKERS;
  if (set.size > cap + 1) throw new ToolError(`At most ${cap} tickers per test (this asks for ${set.size - 1}). Use a smaller list, e.g. us_large_caps or sp500_today.`);

  const start = typeof i.start === "string" ? i.start.trim() : "";
  const end = typeof i.end === "string" && i.end.trim() ? i.end.trim() : today;
  if (!DATE.test(start) || Number.isNaN(dayMs(start))) throw new ToolError("start must be a date, YYYY-MM-DD.");
  if (!DATE.test(end) || Number.isNaN(dayMs(end))) throw new ToolError("end must be a date, YYYY-MM-DD.");
  if (start < EARLIEST) throw new ToolError(`start must be ${EARLIEST} or later.`);
  if (end > today) throw new ToolError(`end cannot be after today (${today}).`);
  if (start >= end) throw new ToolError("start must be before end.");
  const maxYears = set.size <= FEW_TICKERS + 1 ? MAX_YEARS_FEW : MAX_YEARS;
  if (start < LONG_FROM && dayMs(end) - dayMs(start) > (maxYears * 365.25 + 3) * 86_400_000) {
    throw new ToolError(`A start before ${LONG_FROM} allows at most ${maxYears} years per call with ${set.size > FEW_TICKERS + 1 ? `more than ${FEW_TICKERS}` : "these"} tickers; start on ${LONG_FROM} or later (any span to today loads in one call) or shorten the period.`);
  }
  const warm = typeof i.warmup_days === "number" && Number.isFinite(i.warmup_days) ? Math.max(0, Math.min(800, Math.round(i.warmup_days))) : DEFAULT_WARMUP_DAYS;
  const from = iso(Math.max(dayMs(EARLIEST), dayMs(start) - warm * 86_400_000));

  const fields = new Set<Field>(["close"]);
  const asked = Array.isArray(i.fields) ? i.fields : ["open", "close"];
  for (const f of asked) {
    if (!(PRICE_FIELDS as readonly unknown[]).includes(f)) throw new ToolError(`fields must be from ${PRICE_FIELDS.join(", ")}.`);
    fields.add(f as Field);
  }
  return { tickers: Array.from(set), universe, universeLabel, todaysPick, start, end, from, fields: PRICE_FIELDS.filter((f) => fields.has(f)), benchmark };
}

/** "Loading S&P 500 prices (504 tickers, 2021-11-16 to today)". */
export function loadPricesLabel(input: unknown, phase: "running" | "done"): string {
  const verb = phase === "running" ? "Loading" : "Loaded";
  try {
    const p = parseLoadPrices(input);
    const what = p.universe ? `${p.universe} prices` : p.tickers.length <= 4 ? `${p.tickers.join(", ")} prices` : "prices";
    return `${verb} ${what} (${p.tickers.length} tickers, ${p.start} to ${p.end})`;
  } catch {
    return `${verb} prices`;
  }
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  return String(a >= 1000 ? Math.round(v * 100) / 100 : a >= 1 ? Math.round(v * 10_000) / 10_000 : Number(v.toPrecision(6)));
}

export type LoadPricesOutcome = {
  ok: boolean;
  /** tool_result text for the model. */
  content: string;
  label: string;
  /** The uploaded file, for the container_upload block. */
  fileId?: string;
  /** One line for the results panel's log. */
  log?: string;
  ms: number;
  /**
   * Time ran out while prices were still loading (the loaded ones are cached): tickers done of the total. The route finishes the load in the next request instead of handing `content` to the model.
   */
  pending?: LoadProgress;
};

/**
 * The price file: gzipped CSV in long format, one gzip member per ticker (written as each ticker arrives, so a
 * 3M-row load never sits in memory as bars or as one string), tickers in alphabetical order. A file of several
 * gzip members is ordinary gzip: Python's gzip module and pandas read it whole.
 */
export class PriceFileWriter {
  private members = new Map<string, Buffer>();
  rows = 0;
  first = "9999";
  last = "";

  constructor(private fields: readonly Field[]) {}

  add(ticker: string, bars: readonly Bar[]): void {
    if (!bars.length) return;
    const lines: string[] = [];
    for (const b of bars) {
      lines.push(`${b.date},${ticker},${this.fields.map((f) => (f === "volume" ? String(Math.round(b.volume)) : fmt(b[f]))).join(",")}`);
      if (b.date < this.first) this.first = b.date;
      if (b.date > this.last) this.last = b.date;
    }
    this.rows += bars.length;
    this.members.set(ticker, gzipSync(Buffer.from(`${lines.join("\n")}\n`), { level: 4 }));
  }

  has(ticker: string): boolean {
    return this.members.has(ticker);
  }

  finish(): { gz: Buffer; rows: number; first: string; last: string; tickers: string[] } {
    const tickers = Array.from(this.members.keys()).sort();
    const head = gzipSync(Buffer.from(`date,ticker,${this.fields.join(",")}\n`));
    return { gz: Buffer.concat([head, ...tickers.map((t) => this.members.get(t)!)]), rows: this.rows, first: this.first, last: this.last, tickers };
  }
}

/** The price file from bars already in memory (see PriceFileWriter). */
export function buildPriceFile(bars: ReadonlyMap<string, readonly Bar[]>, fields: readonly Field[]) {
  const w = new PriceFileWriter(fields);
  for (const [t, b] of bars) w.add(t, b);
  return w.finish();
}

export type LoadPricesOptions = {
  /** Ends the loading part only (the file still gets written and uploaded within `signal`). */
  fetchSignal?: AbortSignal;
  onProgress?: (p: LoadProgress) => void;
};

/**
 * Loads, writes and uploads the price file. Never throws. A load cut short by
 * `signal` (or `fetchSignal`) reports which tickers are still to come in
 * `pending` (the finished ones are cached for the next call), and uploads nothing.
 */
export async function runLoadPrices(client: Anthropic, input: unknown, signal: AbortSignal, opts: LoadPricesOptions = {}): Promise<LoadPricesOutcome> {
  const started = Date.now();
  const label = loadPricesLabel(input, "done");
  const fail = (error: string, pending?: LoadPricesOutcome["pending"]): LoadPricesOutcome => ({ ok: false, content: JSON.stringify({ error }), label, log: `load_prices failed: ${error}`, ms: Date.now() - started, ...(pending ? { pending } : {}) });
  let p: LoadPricesInput;
  try {
    p = parseLoadPrices(input);
  } catch (error) {
    return fail(error instanceof ToolError ? error.message : "Bad input.");
  }
  try {
    const fetchSignal = opts.fetchSignal ? AbortSignal.any([signal, opts.fetchSignal]) : signal;
    const writer = new PriceFileWriter(p.fields);
    const got = await getDailyBars(p.tickers, p.from, p.end, fetchSignal, { onProgress: opts.onProgress, sink: (t, b) => writer.add(t, b) });
    if (got.notLoaded.length) {
      const loaded = p.tickers.length - got.notLoaded.length;
      return fail(
        `Time ran out while loading: ${loaded} of ${p.tickers.length} tickers are loaded and cached, ${got.notLoaded.length} still to come. Call load_prices again with the same input to finish (cached tickers load instantly).`,
        { loaded, total: p.tickers.length },
      );
    }
    if (!got.loaded.has(BENCHMARK)) return fail("SPY could not be loaded. The price source may be down; try again in a minute.");
    if (!got.loaded.has(p.benchmark)) return fail(`The benchmark ${p.benchmark} could not be loaded (no daily prices for it). Use another ticker or build a custom benchmark in the script.`);
    if (writer.rows > MAX_ROWS) return fail(`That is ${writer.rows.toLocaleString("en-US")} rows, over the ${MAX_ROWS.toLocaleString("en-US")} a file can hold. Load fewer tickers, a shorter span or fewer fields.`);
    const id = randomBytes(3).toString("hex");
    const name = `prices_${id}.csv.gz`;
    const { gz, rows, first, last, tickers } = writer.finish();
    if (signal.aborted) return fail("Time ran out before the file was uploaded. Call load_prices again with the same input (the prices are cached now).", { loaded: p.tickers.length, total: p.tickers.length });
    const file = await client.files.upload({ file: await toFile(gz, name, { type: "application/gzip" }) }, { signal });
    const notes = [
      // Databento's closes are split-adjusted only; Yahoo's are split- and dividend-adjusted.
      /databento/i.test(got.source)
        ? "Prices are split-adjusted, not dividend-adjusted (all fields on the same basis), so close-to-close changes are price returns; dividends are not included."
        : "Prices are split- and dividend-adjusted (all fields on the same basis), so close-to-close changes are total returns.",
      `Rows before ${p.start} are warm-up history for look-back signals; measure performance from ${p.start}.`,
    ];
    if (p.todaysPick) notes.push(`The list is ${p.universeLabel}: today's membership, so a test over past years has survivorship and hindsight bias. Say so in warnings.`);
    if (got.missing.length) notes.push(`No data for ${got.missing.length} ticker(s) (delisted, renamed or not yet listed): ${got.missing.slice(0, 30).join(", ")}${got.missing.length > 30 ? ", ..." : ""}.`);
    const content = JSON.stringify({
      file: name,
      path: `/files/input/*/${name} (glob it: glob.glob("/files/input/*/${name}")[0]; also in $INPUT_DIR when set)`,
      read_with: `pd.read_csv(path, parse_dates=["date"])`,
      columns: ["date", "ticker", ...p.fields],
      tickers_loaded: tickers.length,
      benchmark: p.benchmark,
      benchmark_note: `Compare with ${p.benchmark} and write "benchmark": "${p.benchmark}" in the result${p.benchmark === BENCHMARK ? " (or the custom benchmark the member asked for, by name)" : ""}.`,
      first_date: first,
      last_date: last,
      test_start: p.start,
      test_end: p.end,
      rows,
      universe: p.universeLabel,
      source: got.source,
      notes,
    });
    const mb = (gz.length / 1_048_576).toFixed(1);
    return {
      ok: true,
      content,
      label,
      fileId: file.id,
      log: `Loaded ${tickers.length} tickers (${p.fields.join(", ")}), ${first} to ${last}, ${rows.toLocaleString("en-US")} rows, ${mb} MB gzipped CSV${got.missing.length ? `; no data for ${got.missing.length}` : ""}.`,
      ms: Date.now() - started,
    };
  } catch (error) {
    if (signal.aborted) return fail("Time ran out while loading. Call load_prices again with the same input (loaded tickers are cached).", { loaded: 0, total: p.tickers.length });
    console.error("[desk/load_prices]", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return fail("The price file could not be prepared. Try again in a minute.");
  }
}

/**
 * Starts a sandbox and returns its container id (null on failure). The id
 * only arrives at the end of a response, so the long code-writing turn would
 * not know it if it were cut short; this small request learns it first.
 */
export async function prepareContainer(client: Anthropic, signal: AbortSignal): Promise<{ id: string | null; usage: { in: number; out: number } }> {
  try {
    const r = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 1024,
        output_config: { effort: "low" },
        tools: [CODE_EXECUTION_TOOL],
        messages: [{ role: "user", content: "Run exactly one bash command: `echo ready`. Then reply OK." }],
      },
      { signal },
    );
    return { id: r.container?.id ?? null, usage: { in: r.usage.input_tokens, out: r.usage.output_tokens } };
  } catch (error) {
    if (!signal.aborted) console.error("[desk/container]", error instanceof Error ? error.message : String(error));
    return { id: null, usage: { in: 0, out: 0 } };
  }
}

/**
 * Downloads the result file among a command's output files. Returns null when
 * none of them is RESULT_FILE; `error` when it is there but unusable. The
 * downloaded files are deleted from the Files API afterwards (best effort).
 */
export async function readResultFile(
  client: Anthropic,
  fileIds: string[],
  signal: AbortSignal,
): Promise<{ result: RunResult; problems: string[] } | { error: string } | null> {
  for (const id of fileIds) {
    try {
      const meta = await client.files.retrieveMetadata(id, {}, { signal });
      if (meta.filename !== RESULT_FILE) continue;
      if (meta.size_bytes > MAX_RESULT_BYTES) return { error: `${RESULT_FILE} is too large (${(meta.size_bytes / 1_048_576).toFixed(1)} MB). Downsample the series or keep fewer trades.` };
      const res = await client.files.download(id, {}, { signal });
      const body = await res.text();
      void client.files.delete(id).catch(() => undefined);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { error: `${RESULT_FILE} is not valid JSON (NaN or Infinity are not allowed; write null).` };
      }
      const v = validateRunResult(parsed);
      return v.ok ? { result: v.result, problems: v.problems } : { error: v.problems.join(" ") };
    } catch (error) {
      if (signal.aborted) throw error;
      console.error("[desk/result]", error instanceof Error ? error.message : String(error));
    }
  }
  return null;
}

/* ------------------------------------------------------------------ resume token */

/** What a cut-short reply needs to carry on in the next request. */
export type ResumeState = {
  /** Messages after the client's history: this reply's turns so far. */
  tail: Anthropic.Beta.BetaMessageParam[];
  container: string | null;
  runId: string | null;
  /** Price files uploaded for this reply (deleted when it ends). */
  dataFiles: string[];
  /** Scripts the sandbox has, by path, so later edits can be shown in full. */
  files: Record<string, string>;
  /** How many times this reply has been resumed, not counting `free` hand-offs. */
  n: number;
  /** Hand-offs that only waited on a data load that was still making progress (not counted in `n`; see FREE_HOPS). */
  free?: number;
  /** A round cut mid-text (lib/desk/resume.ts): what joins the kept text to the next request's text. */
  joint?: string;
  /** Tool calls of the tail's last turn still running at the hand-off (an options history pull): the next request waits on them. */
  waiting?: ToolWait;
};

/**
 * The tail's last assistant turn ended in tool calls and some were still running at the hand-off: `ids` are those
 * calls (run again, they wait on the same pull), `results` the round's other results, `since` when the round's tools
 * started (the member's row shows the whole time).
 */
export type ToolWait = { ids: string[]; results: Anthropic.Beta.BetaContentBlockParam[]; since: number; /** load_prices: tickers loaded at the hand-off (progress check). */ loaded?: number };

/** Hand-offs a reply may spend waiting on a price load that is still making progress without them counting toward its resume cap. */
export const FREE_HOPS = 4;

/**
 * Whether a hand-off counts toward the reply's resume cap: not when it ends waiting on a price load that has more
 * tickers loaded than at the previous hand-off (up to FREE_HOPS a reply), so a big cold load never eats the hops the
 * test, its audit and the written answer need. A load that stopped making progress counts, so it cannot loop.
 */
export function handOffCounts(o: { waitingOnPrices: boolean; loadedBefore: number; loadedNow: number; free: number }): boolean {
  return !(o.waitingOnPrices && o.loadedNow > o.loadedBefore && o.free < FREE_HOPS);
}

const TOKEN_TTL_MS = 30 * 60_000;

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("falcon-desk-resume-v1").digest();
}

export function signResume(state: ResumeState, secret: string, userId: string | null): string {
  const body = Buffer.from(JSON.stringify({ ...state, u: userId, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  const mac = createHmac("sha256", key(secret)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyResume(token: unknown, secret: string, userId: string | null): ResumeState | null {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "base64url");
  const want = createHmac("sha256", key(secret)).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ResumeState & { u: string | null; exp: number };
    if (s.u !== userId || typeof s.exp !== "number" || s.exp < Date.now() || !Array.isArray(s.tail)) return null;
    return {
      tail: s.tail,
      container: s.container ?? null,
      runId: s.runId ?? null,
      dataFiles: Array.isArray(s.dataFiles) ? s.dataFiles : [],
      files: s.files ?? {},
      n: Number(s.n) || 0,
      ...(Number(s.free) > 0 ? { free: Number(s.free) } : {}),
      ...(typeof s.joint === "string" ? { joint: s.joint.slice(0, 8) } : {}),
      ...(s.waiting && Array.isArray(s.waiting.ids) && s.waiting.ids.length && Array.isArray(s.waiting.results) ? { waiting: { ids: s.waiting.ids.map(String), results: s.waiting.results, since: Number(s.waiting.since) || Date.now(), ...(Number(s.waiting.loaded) > 0 ? { loaded: Number(s.waiting.loaded) } : {}) } } : {}),
    };
  } catch {
    return null;
  }
}
