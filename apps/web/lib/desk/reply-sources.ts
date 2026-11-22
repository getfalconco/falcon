/**
 * The sources of one Falcon AI reply, for its "N sources" list and the inline
 * source chips (components/ui/streaming-text.tsx): every data lookup of the
 * reply that carries a source id (LabTool.src, lib/desk/citations.ts), named
 * by the tool result's own source (the route's list, else the stored result),
 * plus, for each cited figure whose field has a source of its own (a
 * multiple computed from Yahoo's price, a return computed from daily closes;
 * citations.ts fieldSource), that source, keyed by the citation (`keys`), so
 * the chip next to a figure names where that figure came from, never the
 * lookup's other inputs. Lookups that hold no data (charts, app actions,
 * memory, question cards) and failed ones are left out. Derived from what the
 * session already stores (tools and cites), so a reloaded reply lists the
 * same sources. Pure and client-safe.
 */

import { citeKey, providersIn, sourceKind as citeSourceKind, sourceOf, stripSourceId, type CiteCheck, type CiteReport, type SourceBlock } from "./citations";

export type SourceKind = "databento" | "sec" | "yahoo" | "falcon" | "computed" | "other";

export type ReplySource = {
  /** The source id the reply's citations name ("t3", or "audit"); a figure's own source is "t3#1". */
  id: string;
  /** "Databento EQUS.SUMMARY, end of day", "SEC XBRL company facts". */
  label: string;
  kind: SourceKind;
  /** The short mono name ("sec.gov", "Databento", "Databento + Yahoo" for a figure computed from both). */
  domain: string;
  url?: string;
  asOf?: string;
  /** "/quote AAPL". */
  command?: string;
  /** Whether a figure in the reply cites it. */
  cited: boolean;
  /** The citations (citeKey) whose figure comes from this source. */
  keys?: string[];
};

/** The minimal tool shape read here (lab/sessions.ts LabTool). */
export type SourceTool = { src?: string; cmd?: string; ok?: boolean; result?: string; ref?: string };

/** The tool behind a command ("/quote AAPL" -> quote); null for lookups that hold no data. */
const TOOL_BY_COMMAND: Record<string, string | null> = {
  quote: "quote",
  history: "history",
  fundamentals: "fundamentals",
  earnings: "earnings",
  insiders: "insiders",
  filings: "filings",
  filing: "filing_text",
  flow: "flow",
  sightings: "falcon_sightings",
  graph: "falcon_graph",
  options: "falcon_options",
  company: "falcon_company",
  events: "earnings_events",
  scoreboard: "falcon_scoreboard",
  news: "list_news",
  article: "get_news_article",
  load_prices: "load_prices",
  load_events: "load_events",
  load_graph: "load_graph",
  audit_run: "audit_run",
  run: "code",
  chart: null,
  remember: null,
  forget: null,
  open: null,
  "show-graph": null,
  filter: null,
  edit: null,
  ask_user: null,
};

export const KIND_DOMAIN: Record<Exclude<SourceKind, "other">, string> = {
  databento: "Databento",
  sec: "sec.gov",
  yahoo: "Yahoo",
  falcon: "Falcon",
  computed: "Falcon AI",
};
const PROVIDER_NAME: Record<string, string> = { opra: "Databento", databento: "Databento", sec: "sec.gov", yahoo: "Yahoo", falcon: "Falcon" };

/** The kind of a source line (citations.ts sourceKind: the provider it names first, or `computed`). */
export function sourceKind(label: string, tool?: string): SourceKind {
  if (tool === "audit_run" || tool === "code") return "computed";
  const k = citeSourceKind(tool ?? "", { label }).kind;
  return k === "opra" ? "databento" : k === "audit" ? "computed" : k;
}

/** The short name of a source: its provider, a computed figure's inputs ("Databento + Yahoo"), or a page's host. */
export function sourceDomain(kind: SourceKind, label: string, tool?: string, url?: string): string {
  if (kind === "computed") {
    if (tool === "audit_run" || tool === "code") return KIND_DOMAIN.computed;
    const names = Array.from(new Set(providersIn(label.replace(/^computed by falcon\b/i, "")).map((p) => PROVIDER_NAME[p]!)));
    const inputs = names.filter((n) => n !== "Falcon");
    return inputs.length ? inputs.join(" + ") : "Falcon";
  }
  if (kind !== "other") return KIND_DOMAIN[kind];
  const host = url && /^https:\/\//.test(url) ? new URL(url).hostname.replace(/^www\./, "") : undefined;
  return host ?? label.split(/[\s(,:;]/)[0] ?? label;
}

/** The tool behind a command ("/quote AAPL" -> "quote"); null for lookups that hold no data, undefined when unknown. */
export const toolOfCommand = (cmd: string | undefined): string | null | undefined => {
  const head = /^\/([\w-]+)/.exec(cmd ?? "")?.[1]?.toLowerCase();
  return head === undefined ? undefined : head in TOOL_BY_COMMAND ? TOOL_BY_COMMAND[head] : undefined;
};

const parse = (raw: string | undefined): unknown => {
  if (!raw) return undefined;
  const s = stripSourceId(raw).content;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const SEC = /^https:\/\/(?:www\.)?sec\.gov\//i;

/** The reply's sources in call order (one per lookup, then its cited figures' own sources; the same source and command once). */
export function replySources(tools: readonly SourceTool[] | undefined, cites?: CiteReport): ReplySource[] {
  const checks = cites?.checks ?? [];
  const cited = new Set(checks.map((c) => c.ref));
  const routeSource = new Map((cites?.sources ?? []).map((s) => [s.id, s]));
  const out: ReplySource[] = [];
  const seen = new Map<string, ReplySource>();
  const add = (s: ReplySource) => {
    const k = `${s.label}|${s.command ?? ""}`;
    const had = seen.get(k) ?? seen.get(`id:${s.id}`);
    if (had) {
      if (s.keys?.length) had.keys = Array.from(new Set([...(had.keys ?? []), ...s.keys]));
      return;
    }
    seen.set(k, s);
    seen.set(`id:${s.id}`, s);
    out.push(s);
  };
  for (const t of tools ?? []) {
    if (!t.src || t.ok === false) continue;
    const name = toolOfCommand(t.cmd);
    const isCited = cited.has(t.src);
    if (name === null && !isCited) continue;
    if (name === undefined && !isCited) continue;
    const own = checks.filter((x) => x.ref === t.src);
    const tool = name ?? own.find((x) => x.tool)?.tool ?? "";
    // The lookup's own source: the route's (read from the whole result), the stored result's, else (an older reply) its check's.
    const r = routeSource.get(t.src);
    const data = parse(t.result);
    const block: SourceBlock = r ? { label: r.label, ...(r.asOf ? { as_of: r.asOf } : {}), ...(r.url ? { url: r.url } : {}) } : data !== undefined ? sourceOf(tool, {}, data) : (own.find((x) => x.source)?.source ?? sourceOf(tool, {}, undefined));
    const kind = sourceKind(`${block.label} ${block.dataset ?? ""}`, tool);
    const fieldChecks = own.filter((x) => x.source && x.source.label !== block.label);
    const baseChecks = own.filter((x) => !fieldChecks.includes(x));
    const baseKeys = baseChecks.map(citeKey);
    const checkUrl = baseChecks.map((x) => x.url ?? x.source?.url).find((u) => !!u);
    const url = [checkUrl, block.url, t.ref].find((u) => !!u && SEC.test(u)) ?? [checkUrl, block.url].find((u) => !!u && /^https:\/\//.test(u));
    add({ id: t.src, label: block.label, kind, domain: sourceDomain(kind, block.label, tool, url), ...(url ? { url } : {}), ...(block.as_of ? { asOf: block.as_of } : {}), ...(t.cmd ? { command: t.cmd } : {}), cited: isCited, ...(baseKeys.length ? { keys: baseKeys } : {}) });
    // Figures with a source of their own (one entry per distinct source).
    const bySource = new Map<string, CiteCheck[]>();
    for (const x of fieldChecks) bySource.set(x.source!.label, [...(bySource.get(x.source!.label) ?? []), x]);
    let n = 0;
    for (const [label, list] of bySource) {
      const s = list[0]!.source!;
      const k = sourceKind(`${label} ${s.dataset ?? ""}`, tool);
      const u = list[0]!.url ?? s.url;
      add({ id: `${t.src}#${++n}`, label, kind: k, domain: sourceDomain(k, label, tool, u), ...(u && /^https:\/\//.test(u) ? { url: u } : {}), ...(s.as_of ? { asOf: s.as_of } : {}), ...(t.cmd ? { command: t.cmd } : {}), cited: true, keys: list.map(citeKey) });
    }
  }
  // The strategy test's audit, when the reply cites it and no lookup above stands for it.
  if (cited.has("audit") && !out.some((s) => s.kind === "computed")) {
    const c = checks.find((x) => x.ref === "audit" && x.source);
    const label = c?.source?.label ?? "Falcon's independent audit of the test";
    add({ id: "audit", label, kind: "computed", domain: KIND_DOMAIN.computed, ...(c?.source?.as_of ? { asOf: c.source.as_of } : {}), cited: true, keys: checks.filter((x) => x.ref === "audit").map(citeKey) });
  }
  return out;
}
