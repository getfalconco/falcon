/**
 * `load_graph` (/load_graph): Falcon's point-in-time filing graph loaded in
 * bulk into the code execution sandbox, like `load_events` and `load_prices`.
 * Every link with when it was first and last stated in the filer's annual
 * reports (lib/workspace/graph-pit.ts; built by the engine's
 * scripts/graph-history.ts, split by scripts/graph-shards.mjs into
 * data/graph/_pit/_rows.json), as one gzipped CSV. With as_of only the links
 * known on that date; without it every link with its dates, so a backtest
 * can filter first_seen <= event date per event.
 *
 * The route (app/api/desk/chat/route.ts) uploads the file with the Files API
 * and puts it in the sandbox with a `container_upload` block, as for the
 * other loaders. Client-safe apart from runLoadGraph (command.ts imports the
 * command form): the rows file is read with a lazy node:fs import.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { knownAsOf, parseAsOf } from "../../workspace/graph-pit";
import { csvField, gzip } from "./load-events";
import { ToolError } from "./util";

export const LOAD_GRAPH_TOOL_NAME = "load_graph";

const RELATIONS = ["supplier", "customer", "competitor", "partner"] as const;

/** One link as data/graph/_pit/_rows.json holds it (column order of PIT_ROW_COLUMNS). */
export type PitRow = [
  from: string,
  to: string,
  relation: string,
  strength: string,
  firstSeen: string,
  firstAccession: string,
  firstForm: string,
  lastSeen: string,
  endedAt: string,
  seenIn: number,
  checkedIn: number,
  basis: string,
  current: number,
  firstUrl: string,
  firstQuote: string,
];
export const PIT_ROW_COLUMNS = ["from", "to", "relation", "strength", "first_seen", "first_accession", "first_form", "last_seen", "ended_at", "seen_in", "checked_in", "basis", "current", "first_url", "first_quote"] as const;
export type PitRowsFile = { generatedAt: string; since: string; columns: typeof PIT_ROW_COLUMNS; rows: PitRow[] };

export const COLUMN_DOCS: Record<(typeof PIT_ROW_COLUMNS)[number], string> = {
  from: "The filer: the company whose annual report states the link (share classes with a dash, BRK-B, as load_prices spells them).",
  to: "The company the report names.",
  relation: "What `to` is to `from`: supplier, customer, competitor or partner.",
  strength: "critical (a disclosed revenue/purchase share or a sole source), important (named on its own), marginal (one of a list); from the latest report naming it.",
  first_seen: "YYYY-MM-DD filing date of the FIRST annual report (10-K, 20-F, 40-F or an amendment) that states the link. The link is known from this date on, never before.",
  first_accession: "SEC accession number of that first report.",
  first_form: "Its form.",
  last_seen: "Filing date of the latest annual report that states the link.",
  ended_at: "Filing date of the first later ORIGINAL annual report that no longer names it (possibly ended from then); empty while the latest report still names it.",
  seen_in: "How many annual reports state it.",
  checked_in: "How many annual reports of the filer were read since first_seen (seen_in / checked_in shows how steady the link is).",
  basis: "history: every annual report of the filer since 2014 was read; source: only the report the link came from (so first_seen is that recent report, a late bound).",
  current: "1 when the link is in today's graph, 0 when only older reports state it.",
  first_url: "The first report's document on sec.gov.",
  first_quote: "The sentence of the first report that states the link.",
};

const DEFAULT_COLUMNS = PIT_ROW_COLUMNS.filter((c) => c !== "first_url" && c !== "first_quote");

export const LOAD_GRAPH_TOOL = {
  name: LOAD_GRAPH_TOOL_NAME,
  description:
    "Loads Falcon's point-in-time filing graph into the code execution sandbox as one gzipped CSV: every supplier / customer / competitor / partner link stated in US filers' annual reports since 2014, with first_seen (filing date of the first annual report that states it), last_seen, ended_at (a later report stopped naming it) and how often it was stated. " +
    "Use it for any ripple, supply-chain or link backtest: an event on date t may use a link only when first_seen <= t (and, to drop ended links, ended_at is empty or > t). With as_of only the links known on that date load; without it every link with its dates (filter per event in Python). " +
    "Returns the file's path in the sandbox, the row count, a column dictionary, counts by first_seen year and a preview. The member may type /load_graph --as-of 2018-06-30 [--include-ended] [--tickers NVDA,AMD] [--relation supplier] [--quotes]; map them to these fields.",
  input_schema: {
    type: "object",
    properties: {
      as_of: { type: "string", maxLength: 10, description: "Only links known on this date: YYYY-MM-DD (YYYY-MM or YYYY mean the period's last day). Leave out for every link with its dates." },
      include_ended: { type: "boolean", description: "With as_of: also links a later annual report (filed by as_of) stopped naming (default false)." },
      tickers: { type: ["array", "string"], items: { type: "string", maxLength: 10 }, description: "Only links touching these tickers (either end); a list or a comma-separated string." },
      relations: { type: ["array", "string"], items: { type: "string", enum: [...RELATIONS] }, description: "Only these relations (what `to` is to `from`)." },
      quotes: { type: "boolean", description: "Add first_url and first_quote (the first report's document and sentence; a much larger file)." },
    },
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

/* ------------------------------------------------------------------ input */

export type LoadGraphQuery = { asOf: string | null; includeEnded: boolean; tickers: string[] | null; relations: string[] | null; quotes: boolean };

type Input = Record<string, unknown>;
const blank = (v: unknown) => v === undefined || v === null || v === "";
/** Graph spelling of a ticker: upper case, share classes with a dot (BRK.B), as the graph files hold them. */
const graphTicker = (t: string) => t.trim().toUpperCase().replace(/^\$/, "").replace(/[-/]/g, ".");
const csvTicker = (t: string) => t.replace(/[./]/g, "-");

function list(v: unknown, what: string): string[] | null {
  if (blank(v)) return null;
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/).filter(Boolean) : null;
  if (!parts) throw new ToolError(`${what} must be a list or a comma-separated string.`);
  return parts.map((p) => String(p).trim()).filter(Boolean);
}

/** The tool's input, checked. Throws ToolError. Pure. */
export function parseLoadGraph(input: unknown): LoadGraphQuery {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  const asOfRaw = i.as_of ?? i.asOf;
  const asOf = blank(asOfRaw) ? null : parseAsOf(asOfRaw);
  if (!blank(asOfRaw) && !asOf) throw new ToolError("as_of must be a date: YYYY-MM-DD (or YYYY-MM, YYYY).");
  const tickers = list(i.tickers ?? i.ticker, "tickers");
  if (tickers?.some((t) => !/^[A-Z0-9]{1,6}([.-][A-Z0-9]{1,3})?$/i.test(t.replace(/^\$/, "")))) throw new ToolError("tickers must be US symbols such as NVDA or BRK.B.");
  if (tickers && tickers.length > 600) throw new ToolError("At most 600 tickers; leave tickers out to load every link.");
  const relations = list(i.relations ?? i.relation, "relations")?.map((r) => r.toLowerCase()) ?? null;
  const badRel = relations?.find((r) => !(RELATIONS as readonly string[]).includes(r));
  if (badRel) throw new ToolError(`relation "${badRel.slice(0, 20)}" is unknown. Use ${RELATIONS.join(", ")}.`);
  return { asOf, includeEnded: !!asOf && i.include_ended === true, tickers: tickers ? [...new Set(tickers.map(graphTicker))] : null, relations, quotes: i.quotes === true };
}

/** "/load_graph --as-of 2018-06-30 --tickers NVDA" as tool input (checked later by parseLoadGraph); null when not the command. Pure. */
export function parseLoadGraphCommand(text: string): Input | null {
  const m = /^\s*\/load[_-]graph\b(.*)$/is.exec(text);
  if (!m) return null;
  const words = m[1]!.trim().split(/\s+/).filter(Boolean);
  const out: Input = {};
  for (let k = 0; k < words.length; k++) {
    const flag = /^--?([a-z-]+)(?:=(.*))?$/i.exec(words[k]!);
    if (!flag) {
      if (/^\d{4}(-\d{2}){0,2}$/.test(words[k]!)) out.as_of = words[k];
      continue;
    }
    const name = flag[1]!.toLowerCase();
    const value = () => flag[2] ?? words[++k];
    if (name === "as-of" || name === "asof" || name === "date") out.as_of = value();
    else if (name === "include-ended" || name === "ended") out.include_ended = true;
    else if (name === "tickers" || name === "ticker") out.tickers = value();
    else if (name === "relation" || name === "relations") out.relations = value();
    else if (name === "quotes") out.quotes = true;
  }
  return out;
}

/** The tool row's command: "/load_graph --as-of 2018-06-30". Pure. */
export function loadGraphCommand(input: unknown): string {
  let q: LoadGraphQuery;
  try {
    q = parseLoadGraph(input);
  } catch {
    return "/load_graph";
  }
  const parts = ["/load_graph"];
  if (q.asOf) parts.push(`--as-of ${q.asOf}`);
  if (q.includeEnded) parts.push("--include-ended");
  if (q.tickers) parts.push(`--tickers ${q.tickers.length <= 4 ? q.tickers.join(",") : `${q.tickers.length}-tickers`}`);
  if (q.relations) parts.push(`--relation ${q.relations.join(",")}`);
  if (q.quotes) parts.push("--quotes");
  return parts.join(" ");
}

export function loadGraphLabel(input: unknown, phase: "running" | "done", rows?: number): string {
  const verb = phase === "running" ? "Loading" : "Loaded";
  let asOf: string | null = null;
  try {
    asOf = parseLoadGraph(input).asOf;
  } catch {
    // label only
  }
  return `${verb} ${rows !== undefined ? `${rows.toLocaleString("en-US")} ` : ""}filing links${asOf ? ` known on ${asOf}` : " with first-seen dates"}`;
}

/* ------------------------------------------------------------------ rows and CSV */

/** The rows the query keeps. Pure. */
export function selectRows(rows: readonly PitRow[], q: LoadGraphQuery): PitRow[] {
  const tickers = q.tickers ? new Set(q.tickers) : null;
  return rows.filter(
    (r) =>
      (!tickers || tickers.has(r[0]) || tickers.has(r[1])) &&
      (!q.relations || q.relations.includes(r[2])) &&
      (!q.asOf || knownAsOf({ firstSeen: r[4], endedAt: r[8] || null }, q.asOf, q.includeEnded)),
  );
}

/** The CSV text (header + one line per row). Pure. */
export function graphCsv(rows: readonly PitRow[], quotes: boolean): string {
  const cols = quotes ? PIT_ROW_COLUMNS : DEFAULT_COLUMNS;
  const idx = cols.map((c) => PIT_ROW_COLUMNS.indexOf(c));
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(idx.map((k) => csvField(k <= 1 ? csvTicker(r[k] as string) : r[k])).join(","));
  return lines.join("\n");
}

/* ------------------------------------------------------------------ run */

let cache: PitRowsFile | null = null;

async function readRows(): Promise<PitRowsFile | null> {
  if (cache) return cache;
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = [path.join(process.cwd(), "data", "graph"), path.join(process.cwd(), "apps", "web", "data", "graph")].find((d) => fs.existsSync(path.join(d, "_pit", "_rows.json")));
  if (!dir) return null;
  cache = JSON.parse(fs.readFileSync(path.join(dir, "_pit", "_rows.json"), "utf8")) as PitRowsFile;
  return cache;
}

export type LoadGraphOutcome = { ok: boolean; content: string; label: string; fileId?: string; log?: string; ms: number };

const POINT_IN_TIME =
  "Point in time: a link may be used for an event on date t only when first_seen <= t (the first annual report stating it was filed by then); drop it from ended_at on (a later report stopped naming it) unless the test says why not. Never use today's graph for past events.";

/** Builds and uploads the CSV. Never throws. `deps.rows` replaces the rows file in tests. */
export async function runLoadGraph(client: Pick<Anthropic, "files">, input: unknown, signal: AbortSignal, deps: { rows?: PitRowsFile } = {}): Promise<LoadGraphOutcome> {
  const started = Date.now();
  const fail = (error: string): LoadGraphOutcome => ({ ok: false, content: JSON.stringify({ error }), label: loadGraphLabel(input, "done"), log: `load_graph failed: ${error}`, ms: Date.now() - started });
  let q: LoadGraphQuery;
  try {
    q = parseLoadGraph(input);
  } catch (error) {
    return fail(error instanceof ToolError ? error.message : "Bad input.");
  }
  try {
    const file = deps.rows ?? (await readRows());
    if (!file) return fail("Falcon's point-in-time graph is not built here. Say so; do not use today's links for past events.");
    const rows = selectRows(file.rows, q);
    if (!rows.length) return { ok: true, content: JSON.stringify({ rows: 0, as_of: q.asOf, note: "No links match; nothing was uploaded." }), label: loadGraphLabel(input, "done", 0), ms: Date.now() - started };
    const csv = graphCsv(rows, q.quotes);
    const gz = await gzip(csv);
    if (signal.aborted) return fail("Time ran out before the file was uploaded. Call load_graph again.");
    const name = `graph_${q.asOf ? q.asOf.replace(/-/g, "") : "pit"}_${Math.random().toString(16).slice(2, 8)}.csv.gz`;
    const up = await client.files.upload({ file: new File([gz as BlobPart], name, { type: "application/gzip" }) }, { signal });
    const byYear: Record<string, number> = {};
    for (const r of rows) byYear[r[4].slice(0, 4)] = (byYear[r[4].slice(0, 4)] ?? 0) + 1;
    const cols = q.quotes ? PIT_ROW_COLUMNS : DEFAULT_COLUMNS;
    const history = rows.filter((r) => r[11] === "history").length;
    const content = JSON.stringify({
      file: name,
      path: `/files/input/*/${name} (glob it: glob.glob("/files/input/*/${name}")[0]; also in $INPUT_DIR when set)`,
      read_with: `pd.read_csv(path, parse_dates=["first_seen", "last_seen", "ended_at"], keep_default_na=False, na_values=[""])`,
      rows: rows.length,
      as_of: q.asOf,
      include_ended: q.includeEnded,
      filters: { tickers: q.tickers ? (q.tickers.length <= 20 ? q.tickers : `${q.tickers.length} tickers`) : null, relations: q.relations },
      columns: Object.fromEntries(cols.map((c) => [c, COLUMN_DOCS[c]])),
      counts: {
        by_first_seen_year: byYear,
        current: rows.filter((r) => r[12] === 1).length,
        older_only: rows.filter((r) => r[12] === 0).length,
        ended: rows.filter((r) => r[8]).length,
        basis_history: history,
        basis_source: rows.length - history,
      },
      preview: csv.split("\n", 6).join("\n"),
      source: `Falcon point-in-time filing graph (annual reports since ${file.since}, built ${file.generatedAt.slice(0, 10)})`,
      notes: [
        POINT_IN_TIME,
        "Links are written from the filer's side: relation is what `to` is to `from`. A link counts for either company's events; the filer's report dates it.",
        "basis source: the filer's older reports were not read, so first_seen is only the recent report the link came from (a late bound; the link may be older). Report how many links that affects.",
        "The extraction reads annual reports only and can miss a link in a year; first_seen is the earliest annual report where it was found. Tickers are today's symbols (survivorship).",
      ],
    });
    return { ok: true, content, label: loadGraphLabel(input, "done", rows.length), fileId: up.id, log: `Loaded ${rows.length.toLocaleString("en-US")} filing links${q.asOf ? ` known on ${q.asOf}` : ""}, ${(gz.length / 1024).toFixed(0)} KB gzipped.`, ms: Date.now() - started };
  } catch (error) {
    if (signal.aborted) return fail("Time ran out while loading the graph. Call load_graph again.");
    console.error("[desk/load_graph]", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return fail("The graph file could not be prepared. Try again in a minute.");
  }
}
