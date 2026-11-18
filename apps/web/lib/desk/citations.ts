/**
 * Numeric source citations for Falcon AI (founder rule: every figure comes
 * from a tool, the chat and the panel read the same source, and every figure
 * opens its source on click).
 *
 *  - Source ids: every tool result of a reply gets a stable id by call order
 *    (t1, t2, ... continuing the conversation's last id, `base`), written in
 *    front of the result the model reads ("src:t3 fetched_at:...") and sent on
 *    the tool's done line. The ids come from the reply's turns themselves
 *    (assignSourceIds), so a reply resumed in a new request numbers the same.
 *  - Markup: the model writes a figure as `[%58,9](src:t3 "atmIv30Pct")`: the
 *    label is the number as written, the ref a source id (or `audit`, the
 *    strategy test's audit) and an optional field path in that result.
 *  - Verification (checkReply, no model call): each citation must resolve to a
 *    tool result and the cited number must match the field (or, failing that,
 *    a value somewhere in the result) at the precision shown, tolerant to
 *    Turkish and English formats ("%58,9", "$1,2 mlr", "-0,8 puan", "1,234.5").
 *    Data-like numbers left uncited (%, currency, multiples, decimals; not
 *    dates or plain counts) are listed as unverified.
 *
 * Pure and client-safe: the route builds the report; the chat renders the
 * markup (lab/Markdown.tsx, lab/SourceCite.tsx) and re-checks a citation of an
 * earlier reply against that reply's stored tool result.
 */

export type SourceBlock = { label: string; dataset?: string; as_of?: string; fetched_at?: string; url?: string };
export type CiteStatus = "verified" | "mismatch" | "unresolved" | "unchecked";
/** One citation in the reply, checked against its source. */
export type CiteCheck = {
  ref: string;
  field?: string;
  label: string;
  status: CiteStatus;
  /** The path of the value it matched (or the named field's, on a mismatch). */
  path?: string;
  /** The raw value at `path`. */
  value?: number | string;
  /** Why it is not verified, or how it matched. */
  note?: string;
  tool?: string;
  cmd?: string;
  source?: SourceBlock;
  /** The part of the tool result around the value (JSON or the audit's line). */
  excerpt?: string;
  /** The source document of that value (an SEC filing), when the result names one. */
  url?: string;
};
/** A data-like number in the reply with no citation. */
export type UncitedNumber = { text: string; status: "unverified" | "derived"; note: string };
export type CiteStats = { cited: number; verified: number; mismatch: number; unresolved: number; unchecked: number; uncited: number; derived: number };
/** Where a source's data comes from, for an icon or a chip. */
export type SourceKind = "databento" | "opra" | "sec" | "yahoo" | "falcon" | "audit" | "other";
/**
 * One source the reply used (a tool result with a source id), for a sources list or inline chip
 * (`message.cites.sources`). `cited`: the reply cites at least one figure from it.
 */
export type ReplySource = { id: string; label: string; kind: SourceKind; domain?: string; url?: string; asOf?: string; fetchedAt?: string; command?: string; tool: string; cited: boolean };
/**
 * The route's check of a reply, stored on the message (lab/sessions.ts `LabMessage.cites`):
 * `checks` one per distinct citation, `uncited` data-like numbers with none, `sources` the reply's sources.
 */
export type CiteReport = { v: 1; checks: CiteCheck[]; uncited: UncitedNumber[]; stats: CiteStats; /** Always sent by the route; optional for reports built elsewhere. */ sources?: ReplySource[] };

/** A tool result the reply can cite. `data` is the parsed JSON, or the text (the audit's summary). */
export type SourceEntry = { id: string; name: string; input: unknown; ok: boolean; data: unknown; source: SourceBlock; cmd?: string };

/* ------------------------------------------------------------------ ids */

type Block = { type: string; [k: string]: unknown };
export type Turn = { role: "user" | "assistant"; content: string | readonly Block[] | readonly unknown[] };

const blocks = (t: Turn): Block[] => (Array.isArray(t.content) ? (t.content as Block[]) : []);
const toolUses = (turns: readonly Turn[]) => turns.flatMap((t) => (t.role === "assistant" ? blocks(t).filter((b) => b.type === "tool_use" && typeof b.id === "string") : []));

/**
 * Source ids by tool_use id. The reply's own calls (`tail`) number on from `base` in call order; calls carried in the
 * history (`prior`: an earlier reply's turns coming back after a question card) take the ids just below `base`.
 */
export function assignSourceIds(prior: readonly Turn[], tail: readonly Turn[], base: number): Map<string, string> {
  const ids = new Map<string, string>();
  const before = toolUses(prior);
  before.forEach((b, i) => ids.set(b.id as string, `t${Math.max(1, base - before.length + 1 + i)}`));
  toolUses(tail).forEach((b, i) => ids.set(b.id as string, `t${base + 1 + i}`));
  return ids;
}

/** The conversation's id to number on from: a whole number from the client, 0 otherwise. */
export function cleanSourceBase(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : 0;
}

const PREFIX = /^src:(t\d{1,6}) fetched_at:(\S+)\n/;

/** The tool result as the model reads it: its source id and fetch time first. */
export function withSourceId(id: string | undefined, content: string, fetchedAt = new Date().toISOString()): string {
  return id ? `src:${id} fetched_at:${fetchedAt}\n${content}` : content;
}

export function stripSourceId(content: string): { id: string | null; fetchedAt: string | null; content: string } {
  const m = PREFIX.exec(content);
  return m ? { id: m[1]!, fetchedAt: m[2]!, content: content.slice(m[0].length) } : { id: null, fetchedAt: null, content };
}

/* ------------------------------------------------------------------ sources */

const DEFAULT_SOURCE: Record<string, string> = {
  quote: "Databento EQUS.SUMMARY, end of day",
  history: "Databento EQUS.SUMMARY, end of day",
  fundamentals: "SEC XBRL company facts",
  earnings: "Yahoo Finance earnings",
  filings: "SEC EDGAR",
  filing_text: "SEC EDGAR archive",
  insiders: "SEC EDGAR Form 4 filings",
  flow: "Databento XNAS.ITCH trades",
  falcon_options: "OPRA via Databento",
  falcon_sightings: "Falcon Sightings",
  falcon_graph: "Falcon filing graph",
  falcon_company: "Falcon company data",
  earnings_events: "Falcon earnings reactions",
  falcon_scoreboard: "Falcon scoreboard (forecasts vs options market)",
  audit_run: "Falcon's independent audit of the test",
  event_backtest: "Falcon's event-backtest helper (declared rules)",
  load_prices: "Daily prices loaded for the test",
  load_events: "Falcon historical events (SEC 8-K Item 2.02)",
  load_graph: "Falcon point-in-time filing graph (annual reports)",
  show_chart: "Chart data",
};

const DATASETS: [RegExp, string][] = [
  [/EQUS\.SUMMARY/i, "Databento EQUS.SUMMARY"],
  [/XNAS\.ITCH/i, "Databento XNAS.ITCH"],
  [/OPRA/i, "OPRA (Databento OPRA.PILLAR)"],
  [/XBRL/i, "SEC XBRL company facts"],
  [/full-text search/i, "SEC EDGAR full-text search"],
  [/Form 4/i, "SEC EDGAR Form 4"],
  [/EDGAR/i, "SEC EDGAR"],
  [/Yahoo/i, "Yahoo Finance"],
  [/Sightings/i, "Falcon Sightings"],
  [/graph/i, "Falcon filing graph"],
];

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, n = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const SEC_URL = /^https:\/\/(?:www\.)?sec\.gov\//i;

/** The compact source block of a tool result: the tool's own `source` (a line or a block), else a default for the tool. */
export function sourceOf(name: string, input: unknown, data: unknown, fetchedAt?: string): SourceBlock {
  const d = obj(data);
  const given = d.source;
  const g = obj(given);
  const label = str(given, 200) ?? str(g.label, 200) ?? DEFAULT_SOURCE[name] ?? name.replace(/_/g, " ");
  const dataset = str(g.dataset, 120) ?? DATASETS.find(([re]) => re.test(label))?.[1];
  const asOfText = /as of ([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[ T][0-9:]+(?: ?ET)?)?)/i.exec(label)?.[1];
  const as_of = str(g.as_of, 60) ?? str(d.as_of, 60) ?? str(d.snapshot, 60) ?? str(d.asOf, 60) ?? asOfText ?? str(d.date, 30) ?? str(d.session, 30) ?? periodEnd(d);
  const urlIn = str(obj(input).url, 400);
  const url = [str(g.url, 400), urlIn, str(d.url, 400), str(d.filing_url, 400), str(d.documentUrl, 400)].find((u) => !!u && /^https:\/\//.test(u) && (SEC_URL.test(u) || !!g.url));
  return { label, ...(dataset ? { dataset } : {}), ...(as_of ? { as_of } : {}), ...(fetchedAt ? { fetched_at: fetchedAt } : {}), ...(url ? { url } : {}) };
}

/** fundamentals: the latest period end it carries (revenue.ttm.end and the like). */
function periodEnd(d: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  const walk = (v: unknown, depth: number) => {
    if (depth > 3 || !v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "end" || k === "periodEnd") && typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)) best = !best || x > best ? x : best;
      else if (!Array.isArray(x)) walk(x, depth + 1);
    }
  };
  walk(d, 0);
  return best;
}

/** A source's kind and the domain to show for it. */
export function sourceKind(name: string, source: SourceBlock): { kind: SourceKind; domain?: string } {
  const l = `${source.label} ${source.dataset ?? ""}`;
  if (name === "audit_run") return { kind: "audit" };
  if (/OPRA/i.test(l)) return { kind: "opra", domain: "databento.com" };
  if (/Databento/i.test(l)) return { kind: "databento", domain: "databento.com" };
  if (/SEC|EDGAR|XBRL/i.test(l)) return { kind: "sec", domain: "sec.gov" };
  if (/Yahoo/i.test(l)) return { kind: "yahoo", domain: "finance.yahoo.com" };
  if (/Falcon/i.test(l) || name.startsWith("falcon_") || name === "earnings_events" || name === "load_events" || name === "load_graph" || name === "event_backtest") return { kind: "falcon", domain: "getfalcon.co" };
  return { kind: "other" };
}

/** Tools that hold no data to cite (charts, memory, questions, app actions). */
const NOT_SOURCES = /^(show_chart|remember|forget|ask_user|open_ticker|show_in_graph|set_graph_filters|open_sighting|open_dashboard)$/;

/* ------------------------------------------------------------------ registry */

/** The reply's citable tool results, by source id (and `audit` for the last audit). */
export function buildRegistry(prior: readonly Turn[], tail: readonly Turn[], base: number, cmdOf?: (name: string, input: unknown) => string | undefined): Map<string, SourceEntry> {
  const ids = assignSourceIds(prior, tail, base);
  const calls = new Map<string, { name: string; input: unknown }>();
  const out = new Map<string, SourceEntry>();
  for (const t of [...prior, ...tail]) {
    for (const b of blocks(t)) {
      if (t.role === "assistant" && b.type === "tool_use" && typeof b.id === "string") calls.set(b.id, { name: String(b.name ?? ""), input: b.input });
      if (t.role !== "user" || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const call = calls.get(b.tool_use_id);
      const id = ids.get(b.tool_use_id);
      if (!call || !id) continue;
      const raw = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((x) => (x.type === "text" ? String(x.text ?? "") : "")).join("\n") : "";
      const s = stripSourceId(raw);
      let data: unknown = s.content;
      try {
        data = JSON.parse(s.content);
      } catch {
        // prose (the audit's summary) stays text
      }
      const entry: SourceEntry = { id, name: call.name, input: call.input, ok: b.is_error !== true, data, source: sourceOf(call.name, call.input, data, s.fetchedAt ?? undefined), ...(cmdOf ? { cmd: cmdOf(call.name, call.input) } : {}) };
      out.set(id, entry);
      if (call.name === "audit_run" && entry.ok && typeof data === "string") out.set("audit", { ...entry, id: "audit" });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ numbers */

export type Shown = {
  /** Candidate values (an ambiguous "1,234" is 1234 or 1.234), each with its rounding tolerance. */
  values: { v: number; tol: number }[];
  pct: boolean;
  pts: boolean;
  bps: boolean;
  scale: number;
  signed: boolean;
};

const SCALE: Record<string, number> = {
  k: 1e3, bin: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, milyon: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, mlr: 1e9, milyar: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trilyon: 1e12, trillion: 1e12,
};
const SUFFIX = "%|×|x|bps|bp|baz puan|puan|pts|pp|mlr|milyar|milyon|trilyon|mn|bn|tn|bin|billion|million|trillion|thousand|usd|tl|[bmkt]";
/** A number as written in prose: sign, currency or a leading % (Turkish), digits with separators, a unit or scale. */
const NUMBER_RE = new RegExp(`(?<![\\p{L}\\p{N}_.,/:])([-+−–]\\s?)?(?:([$€£₺])\\s?|(%)\\s?)?([-+−])?(\\d(?:[\\d.,]*\\d)?)(?:\\s?(${SUFFIX})(?![\\p{L}\\p{N}]))?(?:\\s?(%))?`, "giu");

/** "1.234,5" / "1,234.5" / "58,9" / "1,234" (ambiguous) -> candidate values and their decimals. */
export function readDigits(s: string): { v: number; decimals: number }[] {
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  const plain = (x: string) => Number(x);
  if (commas && dots) {
    const dec = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const group = dec === "," ? "." : ",";
    const [int, frac = ""] = s.split(group).join("").split(dec);
    return [{ v: plain(`${int}.${frac}`), decimals: frac.length }];
  }
  if (!commas && !dots) return [{ v: plain(s), decimals: 0 }];
  const sep = commas ? "," : ".";
  const parts = s.split(sep);
  if (parts.length > 2) return parts.slice(1).every((p) => p.length === 3) ? [{ v: plain(parts.join("")), decimals: 0 }] : [];
  const [a, b] = parts as [string, string];
  const decimal = { v: plain(`${a}.${b}`), decimals: b.length };
  // "1,234" or "1.234": thousands or three decimals; "0,123" can only be a decimal.
  return b.length === 3 && a !== "0" && a !== "-0" ? [{ v: plain(a + b), decimals: 0 }, decimal] : [decimal];
}

type Token = { text: string; start: number; end: number; shown: Shown; decorated: boolean; separators: boolean };

function tokenAt(m: RegExpExecArray): Token | null {
  const [whole, lead, cur, pre, innerSign, inner, suf, post] = m;
  const unit = (suf ?? "").toLowerCase();
  const pct = !!pre || unit === "%" || !!post;
  const pts = /^(puan|pts|pp)$/.test(unit) || unit === "baz puan";
  const bps = unit === "bps" || unit === "bp" || unit === "baz puan";
  const scale = SCALE[unit] ?? 1;
  const neg = /[-−–]/.test(lead ?? "") || /[-−]/.test(innerSign ?? "");
  const digits = readDigits(inner!);
  if (!digits.length) return null;
  const values = digits.map((d) => ({ v: (neg ? -1 : 1) * d.v * scale, tol: 0.5 * 10 ** -d.decimals * scale * 1.0001 + 1e-12 }));
  const signed = !!lead || !!innerSign;
  const decorated = pct || pts || bps || !!cur || scale !== 1 || unit === "x" || unit === "×" || unit === "usd" || unit === "tl";
  return { text: whole.trim(), start: m.index + (whole.length - whole.trimStart().length), end: m.index + whole.trimEnd().length, shown: { values, pct, pts: pts && !bps, bps, scale, signed }, decorated, separators: /[.,]/.test(inner!) };
}

/** The first number in a citation label ("%58,9", "$1,2 mlr", "-0,8 puan"), or null. */
export function parseShown(label: string): Shown | null {
  const re = new RegExp(NUMBER_RE.source, NUMBER_RE.flags);
  const m = re.exec(label);
  return m ? (tokenAt(m)?.shown ?? null) : null;
}

/** Whether a raw value is the shown figure at its precision (fractions vs percents, raw vs scaled units, sign in words). */
export function sameNumber(raw: number, shown: Shown): boolean {
  if (!Number.isFinite(raw)) return false;
  const cands = [raw];
  if (shown.pct || shown.pts) cands.push(raw * 100);
  if (shown.bps) cands.push(raw * 1e4, raw * 100);
  if (shown.scale !== 1) cands.push(raw * shown.scale);
  return shown.values.some(({ v, tol }) => cands.some((c) => Math.abs(c - v) <= tol || (!shown.signed && Math.abs(Math.abs(c) - Math.abs(v)) <= tol)));
}

/** Numbers inside a string value ("+12.3%", "58.9", "$1.2B"), as shown figures. */
function numbersIn(s: string): Shown[] {
  const re = new RegExp(NUMBER_RE.source, NUMBER_RE.flags);
  const out: Shown[] = [];
  for (let m = re.exec(s); m && out.length < 40; m = re.exec(s)) {
    const t = tokenAt(m);
    if (t) out.push(t.shown);
  }
  return out;
}

/** Two shown figures agree (a number in a string value against the cited label). */
function sameShown(a: Shown, b: Shown): boolean {
  return a.values.some(({ v }) => {
    // The string's own value in its own units; scale it like a raw number would be read.
    const raw = a.pct && !b.pct ? v / 100 : v;
    return sameNumber(raw, b) || sameNumber(v, b);
  });
}

/* ------------------------------------------------------------------ leaves */

type Leaf = { path: string; key: string; value: number | string; parent: unknown; context?: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function leaves(data: unknown, max = 6_000): Leaf[] {
  const out: Leaf[] = [];
  if (typeof data === "string") {
    // Prose (the audit's summary): each number with the text before it on its line.
    const lines = data.split("\n");
    lines.forEach((line, i) => {
      const re = new RegExp(NUMBER_RE.source, NUMBER_RE.flags);
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const t = tokenAt(m);
        if (t) out.push({ path: `line ${i + 1}`, key: "", value: t.text, parent: line, context: line.slice(Math.max(0, t.start - 48), t.start) });
      }
    });
    return out;
  }
  const walk = (v: unknown, path: string, key: string, parent: unknown) => {
    if (out.length >= max) return;
    if (typeof v === "number" || typeof v === "string") out.push({ path, key, value: v, parent });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key, v));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, k, v);
  };
  walk(data, "", "", null);
  return out;
}

function leafMatches(l: Leaf, shown: Shown): boolean {
  if (typeof l.value === "number") return sameNumber(l.value, shown);
  if (/^\d{4}-\d{2}-\d{2}/.test(l.value)) return false;
  return numbersIn(l.value).some((s) => sameShown(s, shown));
}

/** Metric words the audit's lines use, for a cited field ("oos.cagr", "max_dd", "trades"). */
const PROSE_WORDS: [RegExp, RegExp][] = [
  [/maxdd|drawdown/, /drawdown/i],
  [/benchcagr|benchmarkcagr/, /vs \S+ [-+]?[\d.,]+%|CAGR/i],
  [/cagr/, /CAGR/i],
  [/sharpe/, /Sharpe/i],
  [/trades/, /trades/i],
  [/exposure/, /exposure/i],
  [/excess|difference|diff|edge|vs/, /difference/i],
  [/totalreturn/, /total return/i],
];

function namedLeaves(all: Leaf[], field: string, prose: boolean): Leaf[] {
  const f = field.trim();
  if (!f) return [];
  if (prose) {
    const segs = f.split(/[.[\]]/).filter(Boolean).map(norm);
    const last = segs[segs.length - 1] ?? "";
    const word = PROSE_WORDS.find(([k]) => k.test(last))?.[1];
    if (!word) return [];
    let hits = all.filter((l) => word.test(l.context ?? ""));
    const scope = segs.find((s) => /^(oos|outofsample|is|insample|whole|full|main)$/.test(s));
    if (scope) {
      const re = /^(oos|outofsample)$/.test(scope) ? /out[- ]of[- ]sample|\boos\b/i : /^(is|insample)$/.test(scope) ? /\bin[- ]sample\b/i : /whole test|HEADLINE/i;
      const scoped = hits.filter((l) => re.test(String(l.parent)));
      if (scoped.length) hits = scoped;
    }
    return hits;
  }
  // "rows.3.value" and "rows[3].value" name the same leaf; without an index, any row's.
  const indexed = norm(f.replace(/\.(\d+)(?=\.|$)/g, "[$1]"));
  const byIndex = all.filter((l) => norm(l.path) === indexed);
  if (byIndex.length) return byIndex;
  const want = norm(f.replace(/\[\d+\]|\.\d+(?=\.|$)/g, ""));
  const exact = all.filter((l) => norm(l.path.replace(/\[\d+\]/g, "")) === want || l.path === f);
  if (exact.length) return exact;
  const tail = norm(f.split(/[.[\]]/).filter(Boolean).pop() ?? "");
  return all.filter((l) => norm(l.path.replace(/\[\d+\]/g, "")).endsWith(want) || (tail && norm(l.key) === tail));
}

function excerptOf(l: Leaf, data: unknown): string {
  if (typeof data === "string") return String(l.parent).slice(0, 600);
  const p = l.parent && typeof l.parent === "object" ? l.parent : { [l.key || "value"]: l.value };
  const json = JSON.stringify(p, null, 1).replace(/\n\s*/g, " ");
  return json.length > 600 ? `${json.slice(0, 599)}…` : json;
}

function urlNear(l: Leaf): string | undefined {
  const p = obj(l.parent);
  for (const [k, v] of Object.entries(p)) if (/url|link|href/i.test(k) && typeof v === "string" && /^https:\/\//.test(v)) return v.slice(0, 400);
  return undefined;
}

/* ------------------------------------------------------------------ markup */

export const SRC_LINK = /\[([^\]\n]{1,80})\]\(src:([A-Za-z0-9_-]{1,24})(?:\s+"([^"\n]{0,120})")?\)/g;
export type Citation = { label: string; ref: string; field?: string; start: number; end: number };

export function parseCitations(text: string): Citation[] {
  const re = new RegExp(SRC_LINK.source, "g");
  const out: Citation[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ label: m[1]!, ref: m[2]!, ...(m[3] ? { field: m[3] } : {}), start: m.index, end: m.index + m[0].length });
  return out;
}

/** The text with each citation as its label (copying a reply, a title). */
export const stripCitations = (text: string) => text.replace(new RegExp(SRC_LINK.source, "g"), "$1");

export const citeKey = (c: { ref: string; field?: string; label: string }) => `${c.ref}|${c.field ?? ""}|${c.label}`;

/** Checks one citation against its source. */
export function verifyCitation(c: { label: string; ref: string; field?: string }, entry: SourceEntry | undefined): CiteCheck {
  const base: CiteCheck = { ref: c.ref, ...(c.field ? { field: c.field } : {}), label: c.label, status: "unresolved" };
  if (!entry) return { ...base, note: c.ref === "audit" ? "No audit of a strategy test in this reply." : `No tool result ${c.ref} in this reply.` };
  const withSource: CiteCheck = { ...base, tool: entry.name, ...(entry.cmd ? { cmd: entry.cmd } : {}), source: entry.source };
  if (!entry.ok) return { ...withSource, status: "mismatch", note: "That tool call failed, so it holds no figures." };
  const shown = parseShown(c.label);
  const all = leaves(entry.data);
  const prose = typeof entry.data === "string";
  if (!shown) {
    // A date or a word: shown with its source, not checked.
    const date = /\d{4}-\d{2}-\d{2}/.exec(c.label)?.[0];
    const hit = date ? all.find((l) => String(l.value).includes(date)) : undefined;
    return hit ? { ...withSource, status: "verified", path: hit.path, value: hit.value, excerpt: excerptOf(hit, entry.data) } : { ...withSource, status: "unchecked", note: "Not a number, so it was not checked." };
  }
  const named = c.field ? namedLeaves(all, c.field, prose) : [];
  const done = (l: Leaf, note?: string): CiteCheck => {
    const url = urlNear(l);
    return { ...withSource, status: "verified", path: l.path, value: l.value, excerpt: excerptOf(l, entry.data), ...(url ? { url } : {}), ...(note ? { note } : {}) };
  };
  const hit = named.find((l) => leafMatches(l, shown));
  if (hit) return done(hit);
  // Anywhere in the result only for a figure precise enough not to match by chance ("%2" could be many values).
  const digits = (/[\d.,]+/.exec(c.label)?.[0] ?? "").replace(/[.,]/g, "").replace(/^0+/, "").length;
  const any = digits >= 2 ? all.find((l) => leafMatches(l, shown)) : undefined;
  if (digits < 2 && !named.length) return { ...withSource, status: "unchecked", note: "Too few digits to check without its exact field." };
  if (any) return done(any, c.field ? (named.length ? `The cited field "${c.field}" holds another value; this figure is at ${any.path}.` : `No field "${c.field}"; this figure is at ${any.path}.`) : undefined);
  const near = named[0];
  return {
    ...withSource,
    status: "mismatch",
    ...(near ? { path: near.path, value: near.value, excerpt: excerptOf(near, entry.data) } : {}),
    note: near ? `The source has ${String(near.value)} at ${near.path}, not ${c.label}.` : `${c.label} is not in this tool result.`,
  };
}

/** Code, links and term markup blanked out (same length), so their numbers are not scanned. */
function blankMarkup(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/```[\s\S]*?(```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(new RegExp(SRC_LINK.source, "g"), blank)
    .replace(/\[[^\]\n]{1,120}\]\(term:[^)\n]*\)/g, blank)
    .replace(/\]\(https?:\/\/[^)\s]*\)/g, blank)
    .replace(/https?:\/\/\S+/g, blank);
}

const DATE_LIKE = /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$|^\d{4}[./]\d{1,2}([./]\d{1,2})?$/;

/** Data-like numbers outside citations, code and links: with a %, currency, scale or multiple, decimals, or grouped thousands. Not dates, years or plain counts. */
export function dataNumbers(text: string): { text: string; start: number; end: number }[] {
  const scan = blankMarkup(text);
  const re = new RegExp(NUMBER_RE.source, NUMBER_RE.flags);
  const out: { text: string; start: number; end: number }[] = [];
  for (let m = re.exec(scan); m; m = re.exec(scan)) {
    const t = tokenAt(m);
    if (!t) continue;
    const digits = m[5] ?? "";
    if (DATE_LIKE.test(digits)) continue;
    const before = scan.slice(Math.max(0, t.start - 6), t.start);
    // "Item 2.02", "v1.2", "Form 10-K" are names, not figures.
    if (/item\s*$/i.test(before) || /\bv$/i.test(before)) continue;
    // A thousand separator followed by a time ("15:45") or a plain year range is not data.
    if (!t.decorated && !t.separators) continue;
    if (!t.decorated && /^\d{1,2}[.,]\d{2}$/.test(digits) && /:\s*$/.test(before)) continue;
    out.push({ text: text.slice(t.start, t.end), start: t.start, end: t.end });
  }
  return out;
}

const DERIVED = /hesapland|türetil|computed|calculated|derived/i;

/** The sentence around [start, end). */
function sentenceAt(text: string, start: number, end: number): string {
  const a = Math.max(text.lastIndexOf(". ", start), text.lastIndexOf("\n", start), -1) + 1;
  const stops = [text.indexOf(". ", end), text.indexOf("\n", end)].filter((i) => i >= 0);
  return text.slice(a, stops.length ? Math.min(...stops) + 1 : text.length);
}

/** The whole reply checked: every citation, then the data-like numbers left uncited. */
export function checkReply(text: string, registry: Map<string, SourceEntry>): CiteReport {
  const checks: CiteCheck[] = [];
  const seen = new Set<string>();
  for (const c of parseCitations(text)) {
    const k = citeKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    checks.push(verifyCitation(c, registry.get(c.ref)));
  }
  const uncited: UncitedNumber[] = [];
  const known = new Set<string>();
  for (const n of dataNumbers(text)) {
    if (known.has(n.text)) continue;
    known.add(n.text);
    const derived = DERIVED.test(sentenceAt(text, n.start, n.end));
    uncited.push({ text: n.text, status: derived ? "derived" : "unverified", note: derived ? "Computed from cited figures; not itself in a tool result." : "Not linked to a tool result, so it could not be checked." });
  }
  const count = (s: CiteStatus) => checks.filter((c) => c.status === s).length;
  const citedIds = new Set(checks.filter((c) => c.status !== "unresolved").map((c) => c.ref));
  const sources: ReplySource[] = [];
  for (const e of registry.values()) {
    if (e.id === "audit" || !e.ok || NOT_SOURCES.test(e.name)) continue;
    const k = sourceKind(e.name, e.source);
    const url = e.source.url;
    sources.push({
      id: e.id,
      label: e.source.label,
      kind: k.kind,
      ...(k.domain ? { domain: k.domain } : {}),
      ...(url ? { url } : {}),
      ...(e.source.as_of ? { asOf: e.source.as_of } : {}),
      ...(e.source.fetched_at ? { fetchedAt: e.source.fetched_at } : {}),
      ...(e.cmd ? { command: e.cmd } : {}),
      tool: e.name,
      cited: citedIds.has(e.id) || (e.name === "audit_run" && citedIds.has("audit")),
    });
  }
  return {
    v: 1,
    sources: sources.slice(0, 40),
    checks: checks.slice(0, 80),
    uncited: uncited.slice(0, 60),
    stats: { cited: checks.length, verified: count("verified"), mismatch: count("mismatch"), unresolved: count("unresolved"), unchecked: count("unchecked"), uncited: uncited.filter((u) => u.status === "unverified").length, derived: uncited.filter((u) => u.status === "derived").length },
  };
}

/** The joined text of the reply's assistant turns (what the member reads, without tool activity). */
export function replyText(turns: readonly Turn[]): string {
  return turns
    .filter((t) => t.role === "assistant")
    .flatMap((t) => (typeof t.content === "string" ? [t.content] : blocks(t).filter((b) => b.type === "text").map((b) => String(b.text ?? ""))))
    .join("\n");
}

/* ------------------------------------------------------------------ storage */

const STATUSES: CiteStatus[] = ["verified", "mismatch", "unresolved", "unchecked"];

function cleanSource(v: unknown): SourceBlock | undefined {
  const o = obj(v);
  const label = str(o.label, 200);
  if (!label) return undefined;
  const url = str(o.url, 400);
  return { label, ...(str(o.dataset, 120) ? { dataset: str(o.dataset, 120) } : {}), ...(str(o.as_of, 60) ? { as_of: str(o.as_of, 60) } : {}), ...(str(o.fetched_at, 40) ? { fetched_at: str(o.fetched_at, 40) } : {}), ...(url && /^https:\/\//.test(url) ? { url } : {}) };
}

/** A stored or streamed report checked (anything malformed dropped). */
export function cleanCiteReport(v: unknown): CiteReport | undefined {
  const o = obj(v);
  if (o.v !== 1 || !Array.isArray(o.checks)) return undefined;
  const checks: CiteCheck[] = [];
  for (const x of o.checks as unknown[]) {
    const c = obj(x);
    const ref = str(c.ref, 24);
    const label = typeof c.label === "string" ? c.label.slice(0, 80) : undefined;
    if (!ref || !label || !STATUSES.includes(c.status as CiteStatus)) continue;
    const value = typeof c.value === "number" || typeof c.value === "string" ? (typeof c.value === "string" ? c.value.slice(0, 200) : c.value) : undefined;
    const source = cleanSource(c.source);
    const url = str(c.url, 400);
    checks.push({
      ref,
      label,
      status: c.status as CiteStatus,
      ...(str(c.field, 120) ? { field: str(c.field, 120) } : {}),
      ...(str(c.path, 200) ? { path: str(c.path, 200) } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(str(c.note, 300) ? { note: str(c.note, 300) } : {}),
      ...(str(c.tool, 60) ? { tool: str(c.tool, 60) } : {}),
      ...(str(c.cmd, 120) ? { cmd: str(c.cmd, 120) } : {}),
      ...(source ? { source } : {}),
      ...(str(c.excerpt, 700) ? { excerpt: str(c.excerpt, 700) } : {}),
      ...(url && /^https:\/\//.test(url) ? { url } : {}),
    });
  }
  const uncited: UncitedNumber[] = Array.isArray(o.uncited)
    ? (o.uncited as unknown[]).flatMap((x) => {
        const u = obj(x);
        const text = str(u.text, 40);
        return text ? [{ text, status: u.status === "derived" ? ("derived" as const) : ("unverified" as const), note: str(u.note, 200) ?? "" }] : [];
      })
    : [];
  const KINDS: SourceKind[] = ["databento", "opra", "sec", "yahoo", "falcon", "audit", "other"];
  const sources: ReplySource[] = Array.isArray(o.sources)
    ? (o.sources as unknown[]).flatMap((x) => {
        const r = obj(x);
        const id = str(r.id, 24);
        const label = str(r.label, 200);
        if (!id || !label) return [];
        const url = str(r.url, 400);
        return [
          {
            id,
            label,
            kind: KINDS.includes(r.kind as SourceKind) ? (r.kind as SourceKind) : "other",
            ...(str(r.domain, 80) ? { domain: str(r.domain, 80) } : {}),
            ...(url && /^https:\/\//.test(url) ? { url } : {}),
            ...(str(r.asOf, 60) ? { asOf: str(r.asOf, 60) } : {}),
            ...(str(r.fetchedAt, 40) ? { fetchedAt: str(r.fetchedAt, 40) } : {}),
            ...(str(r.command, 120) ? { command: str(r.command, 120) } : {}),
            tool: str(r.tool, 60) ?? "",
            cited: r.cited === true,
          },
        ];
      })
    : [];
  const s = obj(o.stats);
  const n = (k: string) => (Number.isFinite(Number(s[k])) ? Number(s[k]) : 0);
  return { v: 1, sources: sources.slice(0, 40), checks: checks.slice(0, 80), uncited: uncited.slice(0, 60), stats: { cited: n("cited"), verified: n("verified"), mismatch: n("mismatch"), unresolved: n("unresolved"), unchecked: n("unchecked"), uncited: n("uncited"), derived: n("derived") } };
}
