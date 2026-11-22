/**
 * The sources of one Falcon AI reply, for its "N sources" list and the inline
 * source chips (components/ui/streaming-text.tsx): every data lookup of the
 * reply that carries a source id (LabTool.src, lib/desk/citations.ts), named
 * by the route's citation check when the reply cites it, else by the tool
 * result's own source block. Lookups that hold no data (charts, app actions,
 * memory, question cards) and failed ones are left out. Derived from what the
 * session already stores (tools and cites), so a reloaded reply lists the same
 * sources. Pure and client-safe.
 */

import { sourceOf, stripSourceId, type CiteReport, type SourceBlock } from "./citations";

export type SourceKind = "databento" | "sec" | "yahoo" | "falcon" | "computed";

export type ReplySource = {
  /** The source id the reply's citations name ("t3", or "audit"). */
  id: string;
  /** "Databento EQUS.SUMMARY, end of day", "SEC XBRL company facts". */
  label: string;
  kind: SourceKind;
  /** The short mono name ("sec.gov", "Databento"). */
  domain: string;
  url?: string;
  asOf?: string;
  /** "/quote AAPL". */
  command?: string;
  /** Whether a figure in the reply cites it. */
  cited: boolean;
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

export const KIND_DOMAIN: Record<SourceKind, string> = {
  databento: "Databento",
  sec: "sec.gov",
  yahoo: "Yahoo",
  falcon: "Falcon",
  computed: "Falcon AI",
};

export function sourceKind(label: string, tool?: string): SourceKind {
  if (tool === "audit_run" || tool === "code") return "computed";
  if (/databento|opra|equs\.|xnas\./i.test(label)) return "databento";
  if (/\bsec\b|edgar|xbrl|form 4/i.test(label)) return "sec";
  if (/yahoo/i.test(label)) return "yahoo";
  if (/audit|computed|hesap/i.test(label)) return "computed";
  return "falcon";
}

const toolOf = (cmd: string | undefined): string | null | undefined => {
  const head = /^\/([\w-]+)/.exec(cmd ?? "")?.[1]?.toLowerCase();
  return head === undefined ? undefined : head in TOOL_BY_COMMAND ? TOOL_BY_COMMAND[head] : undefined;
};

const parse = (raw: string | undefined): unknown => {
  if (!raw) return undefined;
  const s = stripSourceId(raw).content;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

const SEC = /^https:\/\/(?:www\.)?sec\.gov\//i;

/** The reply's sources in call order (one per lookup; the same source and command once). */
export function replySources(tools: readonly SourceTool[] | undefined, cites?: CiteReport): ReplySource[] {
  const checks = cites?.checks ?? [];
  const cited = new Set(checks.map((c) => c.ref));
  const fromCheck = (ref: string): { source?: SourceBlock; url?: string; tool?: string } => {
    const c = checks.find((x) => x.ref === ref && x.source) ?? checks.find((x) => x.ref === ref);
    return { source: c?.source, url: c?.url ?? c?.source?.url, tool: c?.tool };
  };
  const out: ReplySource[] = [];
  const seen = new Set<string>();
  const add = (s: ReplySource) => {
    const k = `${s.label}|${s.command ?? ""}`;
    if (seen.has(k) || seen.has(`id:${s.id}`)) return;
    seen.add(k);
    seen.add(`id:${s.id}`);
    out.push(s);
  };
  for (const t of tools ?? []) {
    if (!t.src || t.ok === false) continue;
    const name = toolOf(t.cmd);
    const isCited = cited.has(t.src);
    if (name === null && !isCited) continue;
    if (name === undefined && !isCited) continue;
    const c = fromCheck(t.src);
    const block = c.source ?? sourceOf(name ?? c.tool ?? "", {}, parse(t.result));
    const kind = sourceKind(`${block.dataset ?? ""} ${block.label}`, name ?? c.tool);
    const url = [c.url, block.url, t.ref].find((u) => !!u && SEC.test(u)) ?? (c.url && /^https:\/\//.test(c.url) ? c.url : undefined);
    add({ id: t.src, label: block.label, kind, domain: KIND_DOMAIN[kind], ...(url ? { url } : {}), ...(block.as_of ? { asOf: block.as_of } : {}), ...(t.cmd ? { command: t.cmd } : {}), cited: isCited });
  }
  // The strategy test's audit, when the reply cites it and no lookup above stands for it.
  if (cited.has("audit") && !out.some((s) => s.kind === "computed")) {
    const c = fromCheck("audit");
    const label = c.source?.label ?? "Falcon's independent audit of the test";
    add({ id: "audit", label, kind: "computed", domain: KIND_DOMAIN.computed, ...(c.source?.as_of ? { asOf: c.source.as_of } : {}), cited: true });
  }
  return out;
}
