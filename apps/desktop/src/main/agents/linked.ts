import type { Agent, AgentLine, AgentLinkRelation, AgentLinkTier, AgentLinkedEvent, AgentTrigger } from "../../shared/agent-types";
import { plainDashes } from "../../shared/copy-rules";
import { tierMeasured } from "../../shared/strength-basis";
import { LINK_MIN_CONFIDENCE, isFilingBacked } from "../../shared/earnings-links";
import { copyIssues } from "./copy";
import type { FilingRef, LinkGraphEdge, MaterialNewsItem, ReadthroughRead } from "./sources";
import { filingMs, formMatches, hashKey, isResultsFiling, line, triggerSignature, type TriggerCheck, type TriggerContext } from "./triggers";
import { DAY_MS, HOUR_MS, MINUTE_MS, addDaysYmd, daysBetween, isEdgarOpen, nyInstant, nyYmd } from "./time";

/**
 * The `linked` trigger: a standing watch on the companies the filing graph
 * links to one name. "Tell me when any of NVDA's critical suppliers or
 * customers files an 8-K or reports."
 *
 * The set. Every edge of the local graph (graph.json, step1's extraction of
 * 10-K and 20-F filings) that touches the name, read from the name's side: a
 * company the name's 10-K calls a supplier is its supplier, and a company
 * whose own 10-K calls the name a supplier is its customer. Only links a
 * filing carries (an SEC address, the quote, the accession number) with
 * confidence 0.8 and up, the same bar the read-through radar uses; the tier
 * floor is the trigger's (`minTier`, critical and important when absent).
 * Nodes without a ticker have no filings and no results to watch (the U.S.
 * government node, private companies), so they are left out. One link per
 * company: the stronger tier, then the larger disclosed share, then the more
 * confident. The set is capped (25 per agent, split across its linked
 * triggers, at least 5 each) by the same order, and read again at every
 * check, so a rebuilt graph counts from the next look. A company that joins
 * the set later counts from when it joined, not from the agent's start.
 *
 * Polling. One pass over the set per check through the agent's EDGAR reader
 * (edgar.ts: the spaced queue, at most four requests a second, and its
 * four-minute cache, so two agents on one company make one request), every
 * 15 minutes while EDGAR takes filings and every 2 hours otherwise; every 10
 * minutes on a day one of them reports. Earnings dates for the set come from
 * the same calendar the earnings trigger reads, kept 12 hours per company.
 *
 * What fires, newest evidence first:
 *   earnings  an 8-K with item 2.02, or for a foreign filer a 6-K filed
 *             within a day of its results date
 *   filing    a filing of one of `forms` (8-K and 6-K when absent)
 *   news      a story the news feed cleared as material for one of them
 * A filing is consumed by its accession (`filing:<accession>`, shared with the
 * plain filing trigger, so one filing is never two reports in one agent), a
 * story by its url. Filings more than three days old when first seen are not
 * news any more and are left alone.
 *
 * Pure apart from `AgentDataSources`, so every rule runs against fakes.
 */

export type LinkedTrigger = Extract<AgentTrigger, { kind: "linked" }>;

/** Linked companies one agent watches in all. */
export const LINKED_MAX = 25;
/** The least one linked trigger watches when an agent has several. */
export const LINKED_MIN_PER_TRIGGER = 5;
/** Forms a `filing` event watches when the trigger names none: current reports, domestic and foreign. */
export const DEFAULT_LINK_FORMS: readonly string[] = ["8-K", "6-K"];
export const DEFAULT_MIN_TIER: AgentLinkTier = "important";
export const LINK_RELATIONS: readonly AgentLinkRelation[] = ["supplier", "customer", "competitor"];
export const LINK_TIERS: readonly AgentLinkTier[] = ["critical", "important", "marginal"];
export const LINKED_EVENTS: readonly AgentLinkedEvent[] = ["earnings", "filing", "news"];
/** A filing older than this when first seen is left alone. */
const FRESH_MS = 3 * DAY_MS;
/** How long one company's results date is kept before it is read again. */
const DATES_TTL_MS = 12 * HOUR_MS;
const NEWS_COOLDOWN_MS = 2 * HOUR_MS;
/** Filings or stories one report covers. */
const MAX_PER_EVENT = 4;

const TIER_RANK: Record<AgentLinkTier, number> = { critical: 0, important: 1, marginal: 2 };
const INVERSE: Record<AgentLinkRelation, AgentLinkRelation> = { supplier: "customer", customer: "supplier", competitor: "competitor" };

/** One company in the set, with the link that put it there. */
export type LinkedCompany = {
  ticker: string;
  /** What it is to the watched name. */
  relation: AgentLinkRelation;
  /** The tier it ranks and filters by; for an unclassified edge "important", never measured (`tierMeasured`). */
  tier: AgentLinkTier;
  /** False when the classifier never measured the tier: rank and filter by `tier`, never state it. */
  tierMeasured?: false;
  /** The ticker whose filing states the link. */
  namedBy: string;
  form: "10-K" | "20-F" | null;
  filingDate: string | null;
  sourceUrl: string | null;
  /** The filing's own words for the link. */
  quote: string;
  /** The share the filing states, in percent, and the words that state it. */
  sharePct: number | null;
  shareQuote: string | null;
  confidence: number;
};

/** One thing that happened at a linked company, as an event carries it. */
export type LinkedHit = {
  company: LinkedCompany;
  kind: "earnings" | "filing" | "news";
  filing?: FilingRef;
  news?: MaterialNewsItem;
};

function relationOf(category: unknown): AgentLinkRelation | null {
  return category === "supplier" || category === "customer" || category === "competitor" ? category : null;
}

function tierOf(raw: unknown, basis?: unknown): AgentLinkTier | null {
  // An unclassified edge ranks (and passes the tier filter) as important.
  if (basis === "unclassified") return "important";
  return raw === "critical" || raw === "important" || raw === "marginal" ? raw : null;
}

/** The U.S. government node (and any public body): no filings, no results. */
function isGovernment(e: LinkGraphEdge): boolean {
  return e.counterparty_id === "name:us government" || /government/i.test(e.counterparty_type ?? "");
}

/** Stronger tier (a measured one first), then the larger stated share (none last), then the more confident, then the ticker. */
export function compareLinked(a: LinkedCompany, b: LinkedCompany): number {
  if (a.tier !== b.tier) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
  // At the same rank, a measured tier before an unclassified one.
  if ((a.tierMeasured === false) !== (b.tierMeasured === false)) return a.tierMeasured === false ? 1 : -1;
  const sa = a.sharePct ?? -1;
  const sb = b.sharePct ?? -1;
  if (sa !== sb) return sb - sa;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.ticker.localeCompare(b.ticker);
}

/** How many linked companies one trigger of this agent watches. */
export function linkedCapFor(agent: Pick<Agent, "triggers">): number {
  const n = Math.max(1, agent.triggers.filter((t) => t.kind === "linked").length);
  return Math.max(LINKED_MIN_PER_TRIGGER, Math.floor(LINKED_MAX / n));
}

/**
 * The linked set of a trigger from the graph's edges, closest first and
 * capped; `total` is the size before the cap. Pure.
 */
export function resolveLinkedSet(
  edges: readonly LinkGraphEdge[],
  t: Pick<LinkedTrigger, "ticker" | "relations" | "minTier">,
  formOf: (filer: string) => "10-K" | "20-F" | null = () => null,
  cap = LINKED_MAX,
): { companies: LinkedCompany[]; total: number } {
  const holding = t.ticker.trim().toUpperCase();
  const relations = new Set(t.relations && t.relations.length > 0 ? t.relations : LINK_RELATIONS);
  const floor = TIER_RANK[t.minTier ?? DEFAULT_MIN_TIER];
  const best = new Map<string, LinkedCompany>();
  for (const e of edges) {
    const root = e.root_ticker?.trim().toUpperCase();
    const named = e.counterparty_ticker?.trim().toUpperCase();
    if (!root || !named || root === named) continue;
    if (root !== holding && named !== holding) continue;
    if (root === holding && isGovernment(e)) continue;
    const category = relationOf(e.category);
    const tier = tierOf(e.strength_tier, e.strength_basis);
    if (!category || !tier || TIER_RANK[tier] > floor) continue;
    if (!isFilingBacked(e) || typeof e.confidence !== "number" || !(e.confidence >= LINK_MIN_CONFIDENCE)) continue;
    const relation = root === holding ? category : INVERSE[category];
    if (!relations.has(relation)) continue;
    const ticker = root === holding ? named : root;
    const share = typeof e.disclosed_share_pct === "number" && Number.isFinite(e.disclosed_share_pct) ? e.disclosed_share_pct : null;
    const company: LinkedCompany = {
      ticker,
      relation,
      tier,
      ...(tierMeasured(e) ? {} : { tierMeasured: false as const }),
      namedBy: root,
      form: e.form === "10-K" || e.form === "20-F" ? e.form : formOf(root),
      filingDate: typeof e.filing_date === "string" && e.filing_date ? e.filing_date : null,
      sourceUrl: typeof e.source_url === "string" ? e.source_url : null,
      quote: (e.evidence_quote ?? "").trim(),
      sharePct: share,
      shareQuote: share !== null && typeof e.disclosed_share_quote === "string" && e.disclosed_share_quote.trim() ? e.disclosed_share_quote.trim() : null,
      confidence: e.confidence,
    };
    const known = best.get(ticker);
    if (!known || compareLinked(company, known) < 0) best.set(ticker, company);
  }
  const all = [...best.values()].sort(compareLinked);
  return { companies: all.slice(0, Math.max(0, cap)), total: all.length };
}

/* ------------------------------------------------------------------ */
/* Words                                                                */
/* ------------------------------------------------------------------ */

/** "supplier to NVDA", "customer of NVDA", "competitor of NVDA". */
export function relationPhrase(relation: AgentLinkRelation, holding: string): string {
  return relation === "supplier" ? `supplier to ${holding}` : `${relation} of ${holding}`;
}

/** "a critical supplier to NVDA", "an important customer of NVDA"; "a supplier to NVDA" when the tier was never measured. */
export function tierRelation(c: Pick<LinkedCompany, "tier" | "relation" | "tierMeasured">, holding: string): string {
  if (c.tierMeasured === false) return `a ${relationPhrase(c.relation, holding)}`;
  return `${c.tier === "important" ? "an" : "a"} ${c.tier} ${relationPhrase(c.relation, holding)}`;
}

function article(form: string): string {
  return /^(8|11|18|S|F|A|E)/i.test(form) ? "an" : "a";
}

/** "(item 2.02)", "(items 2.02, 7.01)" for an 8-K; the exhibits item says nothing and is left out. */
export function itemsText(f: Pick<FilingRef, "form" | "items">): string {
  if (!f.form.startsWith("8-K")) return "";
  const items = f.items.filter((i) => i !== "9.01");
  if (items.length === 0) return "";
  return ` (item${items.length === 1 ? "" : "s"} ${items.join(", ")})`;
}

function fmtPct(n: number, digits = 1): string {
  return `${(Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits)}%`;
}

function quoted(text: string, max: number): string {
  // The sentence around the quote ends it, so its own closing stop goes.
  const one = plainDashes(text.replace(/\s+/g, " ").trim()).replace(/"/g, "'").replace(/[.;,:\s]+$/, "");
  return one.length <= max ? one : `${one.slice(0, max - 3).replace(/\s+\S*$/, "")}...`;
}

/**
 * A quote from a filing in a sentence of ours: kept only when it passes the
 * copy rules as it stands. A filing's own words are never softened into
 * something it did not say; a quote that would break a rule is left out.
 */
function quoteSentence(prefix: string, text: string, max: number): string | null {
  if (!text.trim()) return null;
  const sentence = `${prefix} "${quoted(text, max)}"`;
  return copyIssues(sentence).length === 0 ? `${sentence}.` : null;
}

/** "AMKR is a critical supplier to NVDA, per NVDA's 10-K filed 2026-02-25." */
export function linkSentence(c: LinkedCompany, holding: string): string {
  const source = `${c.namedBy}'s ${c.form ?? "annual report"}${c.filingDate ? ` filed ${c.filingDate}` : ""}`;
  return `${c.ticker} is ${tierRelation(c, holding)}, per ${source}.`;
}

/**
 * The read-through radar's measured line for a report, or null. No figure
 * under three measured reports; the count is said instead.
 */
export function reactionSentence(c: LinkedCompany, holding: string, rt: ReadthroughRead | undefined): string | null {
  if (!rt) return null;
  if (rt.stats && rt.stats.events >= 3) {
    const s = rt.stats;
    return (
      `On ${c.ticker}'s last ${s.events} report days (${s.from} to ${s.to}), ${holding} moved ${fmtPct(s.avgAbsMove * 100)} on average, ` +
      `${fmtPct(s.avgAbsAbnormal * 100)} beyond the market, and in the same direction as ${c.ticker} on ${s.withIt} of ${s.events}.`
    );
  }
  if (rt.sample > 0) {
    return `Only ${rt.sample} of ${c.ticker}'s past reports could be measured against ${holding}, too few for a figure.`;
  }
  return null;
}

/** What happened, in one sentence, for a hit. */
export function hitSentence(h: LinkedHit): string {
  const c = h.company;
  if (h.kind === "news" && h.news) {
    return `Material news on ${c.ticker}${h.news.publishedAt ? ` (${h.news.publishedAt.slice(0, 10)})` : ""}: ${h.news.title.replace(/[.\s]+$/, "")}.`;
  }
  const f = h.filing!;
  const what = `${c.ticker} filed ${article(f.form)} ${f.form}${itemsText(f)} on ${f.filedAt}`;
  return h.kind === "earnings" ? `${what}, its results release.` : `${what}.`;
}

/**
 * The paragraph that opens a linked report, one per company: what happened,
 * the link and its tier, the disclosed share and the filing's words, and for
 * a results release the measured reaction of the watched name. Written here,
 * not by the model, so the evidence is always there and always as filed.
 */
export function linkedLead(hits: readonly LinkedHit[], holding: string, readthrough: readonly ReadthroughRead[]): string {
  const byCompany = new Map<string, LinkedHit[]>();
  for (const h of hits) byCompany.set(h.company.ticker, [...(byCompany.get(h.company.ticker) ?? []), h]);
  const paragraphs: string[] = [];
  for (const [ticker, list] of byCompany) {
    const c = list[0]!.company;
    const parts = list.map(hitSentence);
    parts.push(linkSentence(c, holding));
    if (c.sharePct !== null) {
      const share = c.shareQuote ? quoteSentence(`The filing states a share of ${fmtPct(c.sharePct)}:`, c.shareQuote, 220) : null;
      parts.push(share ?? `The filing states a share of ${fmtPct(c.sharePct)}.`);
    }
    if (c.quote && c.quote !== c.shareQuote) {
      const q = quoteSentence("The filing says:", c.quote, 260);
      if (q) parts.push(q);
    }
    if (list.some((h) => h.kind === "earnings")) {
      const r = reactionSentence(c, holding, readthrough.find((x) => x.counterparty === ticker && x.holding === holding));
      if (r) parts.push(r);
    }
    paragraphs.push(parts.join(" "));
  }
  return paragraphs.join("\n\n");
}

/** The event's one line (also the fallback headline). */
export function linkedTitle(hits: readonly LinkedHit[], holding: string): string {
  const first = hits[0]!;
  const c = first.company;
  if (hits.length === 1) {
    const rel = tierRelation(c, holding);
    if (first.kind === "news") return `Material news on ${c.ticker}, ${rel}.`;
    const f = first.filing!;
    return `${c.ticker}, ${rel}, filed ${article(f.form)} ${f.form}${itemsText(f)}${first.kind === "earnings" ? " with its results" : ""}.`;
  }
  const tickers = [...new Set(hits.map((h) => h.company.ticker))];
  if (hits.every((h) => h.kind === "news")) return `Material news on ${tickers.length === 1 ? tickers[0] : `${tickers.length} companies linked to ${holding}`} (${hits.length} stories).`;
  return `${hits.length} new filings from companies linked to ${holding}: ${hits.map((h) => `${h.company.ticker} ${h.filing?.form ?? ""}`.trim()).join(", ")}.`;
}

/* ------------------------------------------------------------------ */
/* The check                                                            */
/* ------------------------------------------------------------------ */

function linkedSummary(t: LinkedTrigger, count: number): { note: string; lines: AgentLine[] } {
  return {
    note: `Watching ${count} ${count === 1 ? "company" : "companies"} linked to ${t.ticker}.`,
    lines: [line("linked.watching", { count, ticker: t.ticker })],
  };
}

/** A foreign filer's results: a 6-K filed within a day of its results date. */
function isForeignResults(f: FilingRef, resultsDate: string | null): boolean {
  if (!resultsDate || !f.form.startsWith("6-K") || !f.filedAt) return false;
  return Math.abs(daysBetween(resultsDate, f.filedAt)) <= 1;
}

export async function checkLinked(t: LinkedTrigger, ctx: TriggerContext): Promise<TriggerCheck> {
  const { now, sources, agent, state } = ctx;
  const sig = triggerSignature(t);
  const nowMs = now.getTime();
  const today = nyYmd(now);
  const { companies } = resolveLinkedSet(await sources.linkEdges(), t, (f) => sources.filingFormOf(f), linkedCapFor(agent));

  if (companies.length === 0) {
    state.linked = { ...(state.linked ?? {}), [sig]: {} };
    return {
      status: "waiting",
      note: `No companies linked to ${t.ticker} in the filing graph yet.`,
      detail: `No companies linked to ${t.ticker} in the filing graph yet. Reads the graph again every hour.`,
      noteLines: [line("linked.noneInGraph", { ticker: t.ticker })],
      detailLines: [line("linked.noneInGraph", { ticker: t.ticker }), line("linked.readsGraphHourly")],
      nextCheckMs: HOUR_MS,
    };
  }

  // When each company joined the set: the agent's start for the first set, the
  // moment it appeared for any that came with a rebuilt graph.
  const known = state.linked?.[sig];
  const joined: Record<string, string> = {};
  for (const c of companies) joined[c.ticker] = known?.[c.ticker] ?? (known ? now.toISOString() : agent.createdAt);
  state.linked = { ...(state.linked ?? {}), [sig]: joined };
  const sinceOf = (ticker: string) => Date.parse(joined[ticker] ?? agent.createdAt);
  const fired = (key: string) => state.firedKeys.includes(key);

  const events = new Set(t.events);
  const wantsEarnings = events.has("earnings");
  const wantsFilings = events.has("filing");
  const forms = t.forms && t.forms.length > 0 ? t.forms : DEFAULT_LINK_FORMS;

  // Results dates for the set, kept twelve hours each.
  const resultsDate = new Map<string, string>();
  if (wantsEarnings) {
    for (const c of companies) {
      const kept = state.earnings?.[c.ticker];
      if (kept && nowMs - Date.parse(kept.readAt) < DATES_TTL_MS && kept.date >= addDaysYmd(today, -3)) {
        resultsDate.set(c.ticker, kept.date);
        continue;
      }
      try {
        const read = await sources.earningsDates(c.ticker);
        const date = read.dates.find((d) => d >= addDaysYmd(today, -3)) ?? null;
        if (date) {
          resultsDate.set(c.ticker, date);
          state.earnings = { ...(state.earnings ?? {}), [c.ticker]: { date, estimated: read.estimated, readAt: now.toISOString() } };
        }
      } catch {
        // The date is a pacing hint and a 6-K reader; EDGAR still answers below.
        if (kept && kept.date >= addDaysYmd(today, -3)) resultsDate.set(c.ticker, kept.date);
      }
    }
  }

  let unread = 0;
  const hits: LinkedHit[] = [];
  if (wantsEarnings || wantsFilings) {
    for (const c of companies) {
      let filings: FilingRef[];
      try {
        filings = await sources.filings(c.ticker);
      } catch {
        unread++;
        continue;
      }
      const since = sinceOf(c.ticker);
      for (const f of filings) {
        const at = filingMs(f);
        if (!Number.isFinite(at) || at < since || nowMs - at > FRESH_MS) continue;
        if (fired(`filing:${f.accession}`)) continue;
        const results = wantsEarnings && (isResultsFiling(f) || isForeignResults(f, resultsDate.get(c.ticker) ?? null));
        const formHit = wantsFilings && formMatches(f.form, forms);
        if (results) hits.push({ company: c, kind: "earnings", filing: f });
        else if (formHit) hits.push({ company: c, kind: "filing", filing: f });
      }
    }
    if (unread === companies.length) throw new Error(`EDGAR could not be read for the ${companies.length} linked companies`);
  }

  const cadence = (() => {
    const reportingNow = [...resultsDate.values()].some((d) => Math.abs(daysBetween(today, d)) <= 1);
    if (!wantsEarnings && !wantsFilings) return 30 * MINUTE_MS;
    if (reportingNow) return isEdgarOpen(now) ? 10 * MINUTE_MS : 30 * MINUTE_MS;
    return isEdgarOpen(now) ? 15 * MINUTE_MS : 2 * HOUR_MS;
  })();

  if (hits.length > 0) {
    const order = (h: LinkedHit) => (h.kind === "earnings" ? 0 : 1);
    const picked = hits
      .sort((a, b) => order(a) - order(b) || compareLinked(a.company, b.company) || filingMs(b.filing!) - filingMs(a.filing!))
      .slice(0, MAX_PER_EVENT);
    return {
      status: "fired",
      event: {
        keys: picked.map((h) => `filing:${h.filing!.accession}`),
        kind: "linked",
        trigger: t,
        title: linkedTitle(picked, t.ticker),
        at: now.toISOString(),
        ticker: t.ticker,
        filings: picked.map((h) => h.filing!),
        linked: picked,
      },
      nextCheckMs: cadence,
    };
  }

  let newsUnread = false;
  if (events.has("news")) {
    const last = state.lastFiredByTrigger[sig];
    const cooling = last && nowMs - Date.parse(last) < NEWS_COOLDOWN_MS;
    if (!cooling) {
      const byTicker = new Map(companies.map((c) => [c.ticker, c] as const));
      let items: MaterialNewsItem[] = [];
      try {
        items = await sources.materialNews(new Date(Math.max(Date.parse(agent.createdAt), nowMs - DAY_MS)).toISOString());
      } catch {
        newsUnread = true;
      }
      const newsHits: LinkedHit[] = [];
      for (const n of items) {
        const at = n.publishedAt ? Date.parse(n.publishedAt) : NaN;
        if (!Number.isFinite(at) || fired(`news:${hashKey(n.url)}`)) continue;
        const match = n.tickers.map((x) => byTicker.get(x)).filter((c): c is LinkedCompany => c !== undefined).sort(compareLinked)[0];
        if (!match || at < sinceOf(match.ticker)) continue;
        newsHits.push({ company: match, kind: "news", news: n });
      }
      if (newsHits.length > 0) {
        const picked = newsHits.slice(0, MAX_PER_EVENT);
        return {
          status: "fired",
          event: {
            keys: picked.map((h) => `news:${hashKey(h.news!.url)}`),
            kind: "linked",
            trigger: t,
            title: linkedTitle(picked, t.ticker),
            at: now.toISOString(),
            ticker: t.ticker,
            news: picked.map((h) => h.news!),
            linked: picked,
          },
          nextCheckMs: cadence,
        };
      }
      if (newsUnread && !wantsEarnings && !wantsFilings) throw new Error("the news feed could not be read");
    }
  }

  const summary = linkedSummary(t, companies.length);
  const next = [...resultsDate.entries()].filter(([, d]) => d >= today).sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))[0];
  const detail: string[] = [summary.note, "Nothing new from them yet."];
  const detailLines: AgentLine[] = [...summary.lines, line("linked.nothingNew")];
  if (next) {
    detail.push(`Next report among them: ${next[0]} on ${next[1]}.`);
    detailLines.push(line("linked.nextReport", { ticker: next[0], date: next[1] }));
  }
  if (unread > 0) {
    detail.push(`${unread} of them could not be read this time.`);
    detailLines.push(line("linked.unread", { count: unread }));
  }
  if (newsUnread) {
    detail.push("The news feed could not be read.");
    detailLines.push(line("linked.newsUnavailable"));
  }
  if (cadence >= 2 * HOUR_MS) {
    detail.push("Checks EDGAR every 2 hours.");
    detailLines.push(line("filing.checksEdgarEvery2h"));
  } else {
    detail.push(`Checks every ${cadence / MINUTE_MS} minutes.`);
    detailLines.push(line("news.checksEvery", { count: cadence / MINUTE_MS }));
  }
  return {
    status: "waiting",
    note: summary.note,
    detail: detail.join(" "),
    noteLines: summary.lines,
    detailLines,
    nextCheckMs: cadence,
    ...(next ? { nextExpectedAt: nyInstant(next[1], "08:00").toISOString() } : {}),
  };
}
