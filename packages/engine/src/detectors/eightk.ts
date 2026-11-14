/**
 * 8-K classes that link companies (design 3.2):
 *
 *   - `customer_bankruptcy` (F5, linked): item 1.03 of a filer that is a
 *     customer in data/graph.json (its suppliers carry trade-credit exposure).
 *     Code only; the quote is the item's own first sentences. sign -1.
 *   - `contract_material` / `contract_termination` (F3, own): items 1.01 /
 *     1.02 of US-listed filers, financing filings dropped (items 2.03, 3.02,
 *     3.03). Haiku 5.5 extracts counterparty, type, value, term and
 *     exclusivity, each with a verbatim quote; value as % of the filer's
 *     trailing annual revenue in code. Anti-pump filter and an unlisted
 *     counterparty cap the event at Watch.
 *   - `guidance_down` / `guidance_up` (F1/F2, linked): items 7.01, 8.01 and
 *     2.02 (with EX-99) of companies that are customers in graph.json,
 *     triaged by Haiku 5.5 into a closed label set, a verbatim quote per
 *     label. sign from the label.
 */

import { loadGraph, type Graph } from "../graph.ts";
import { annualRevenue, filerMeta, isListed, loadListings, matchListed, type Listing, type Listings } from "../feed/companies.ts";
import { eightKsFiled, eightKText, resolveAcceptance, type EightK } from "../feed/eightk.ts";
import { checkedQuote, clipDoc, numbersNotIn, structured, UNTRUSTED_NOTE } from "./llm.ts";
import type { Detector, DetectorContext, DetectorEvent, EventType } from "./types.ts";
import { displayName, eachLimit, edgarSource, inWindow, usd } from "./util.ts";

/** Filings read and sent to the model at once. */
export const LLM_CONCURRENCY = 4;
import { leadQuote } from "./distress.ts";

/** Tickers the graph names as someone's customer (the watch set for F1/F2/F5). Pure. */
export function graphCustomers(g: Graph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (customer: string, supplier: string) => out.set(customer, [...new Set([...(out.get(customer) ?? []), supplier])]);
  for (const e of g.edges) {
    if (e.category === "customer" && e.to) add(e.to, e.from);
    if (e.category === "supplier" && e.to) add(e.from, e.to);
  }
  return out;
}

/** Watch set as CIK -> { ticker, suppliers }. */
function customerWatch(listings: Listings): Map<string, { ticker: string; suppliers: string[] }> {
  const out = new Map<string, { ticker: string; suppliers: string[] }>();
  for (const [ticker, suppliers] of graphCustomers(loadGraph())) {
    const l = listings.byTicker.get(ticker);
    if (l) out.set(l.cik, { ticker, suppliers });
  }
  return out;
}

/** The text of one 8-K item, from its heading to the next item heading. Pure. */
export function itemSection(text: string, item: string): string | null {
  const esc = item.replace(".", "\\.");
  const re = new RegExp(`Item\\s*${esc}\\.?[^\\n]*\\n?`, "gi");
  let best: string | null = null;
  for (const m of text.matchAll(re)) {
    const rest = text.slice(m.index! + m[0].length);
    const next = /\n\s*Item\s*\d\.\d\d\b|\n\s*SIGNATURES?\b/i.exec(rest);
    const body = (next ? rest.slice(0, next.index) : rest.slice(0, 4000)).trim();
    // The heading inside the cover page's item list has no body; the longest match is the section.
    if (!best || body.length > best.length) best = body;
  }
  return best && best.length > 30 ? best : null;
}

function listingOf(k: EightK, listings: Listings): Listing | null {
  return k.ciks.map((c) => listings.byCik.get(c)).find((l) => isListed(l)) ?? null;
}

// ---------------------------------------------------------------- F5

export function customerBankruptcyDetector(): Detector {
  return {
    eventTypes: ["customer_bankruptcy"],
    async detect(ctx: DetectorContext): Promise<DetectorEvent[]> {
      const listings = await loadListings();
      const watch = customerWatch(listings);
      const all = await eightKsFiled(ctx.since, ctx.until, ctx.log);
      const routed = all.filter((k) => k.items.includes("1.03"));
      const out: DetectorEvent[] = [];
      for (const k0 of routed) {
        const cik = k0.ciks.find((c) => watch.has(c));
        if (!cik) continue;
        try {
          const k = await resolveAcceptance(k0);
          if (!inWindow(k.acceptedAt, ctx.since, ctx.until)) continue;
          const text = await eightKText(k, { exhibits: false });
          const section = itemSection(text.main, "1.03") ?? text.main;
          const quote = leadQuote(section, 400);
          const w = watch.get(cik)!;
          const l = listings.byCik.get(cik);
          const company = displayName(l?.name ?? k.companyName);
          out.push({
            id: `customer_bankruptcy-${k.accession}`,
            eventType: "customer_bankruptcy",
            family: "F5",
            cik,
            ticker: w.ticker,
            companyName: company,
            acceptedAt: k.acceptedAt!,
            accession: k.accession,
            form: k.form,
            items: k.items,
            title: `${company} reported a bankruptcy or receivership (8-K Item 1.03)`,
            summary: [`${company} filed an 8-K under Item 1.03 (bankruptcy or receivership).`, ...(quote ? [`"${quote}"`] : [])],
            sign: -1,
            magnitude: null,
            facts: { suppliersInGraph: w.suppliers.join(", ") },
            sources: [edgarSource(`8-K Item 1.03: ${company}`, k.indexUrl, k.acceptedAt)],
            quotes: quote ? [quote] : [],
            propagates: "linked",
            watchOnlyReasons: [],
          });
        } catch (err) {
          ctx.log(`customer_bankruptcy: ${k0.accession} unreadable (${(err as Error).message.split("\n")[0]})`);
        }
      }
      ctx.log(`customer_bankruptcy: ${routed.length} 8-Ks with item 1.03 (all filers), ${out.length} from graph customers`);
      return out;
    },
  };
}

// ---------------------------------------------------------------- F3

export const FINANCING_ITEMS = ["2.03", "3.02", "3.03"];

/** S0 route for contracts: 1.01 or 1.02 without financing items. Pure. */
export function routesToContract(items: string[]): boolean {
  return (items.includes("1.01") || items.includes("1.02")) && !items.some((i) => FINANCING_ITEMS.includes(i));
}

export const CONTRACT_TYPES = [
  "supply_or_purchase",
  "customer_sales",
  "license",
  "collaboration_or_development",
  "distribution_or_reseller",
  "services",
  "government_contract",
  "merger_or_acquisition",
  "asset_sale_or_purchase",
  "financing_or_credit",
  "lease_or_real_estate",
  "employment_or_compensation",
  "settlement",
  "other",
] as const;

/** Types that count as commercial (the F3 class); the rest are dropped. */
export const COMMERCIAL_TYPES = new Set<string>(["supply_or_purchase", "customer_sales", "license", "collaboration_or_development", "distribution_or_reseller", "services", "government_contract"]);

export const CONTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agreement_type", "is_termination", "counterparty", "counterparty_is_government", "filer_role", "value_text", "term_text", "exclusivity", "quote_counterparty", "quote_value", "quote_term", "quote_exclusivity"],
  properties: {
    agreement_type: { type: "string", enum: [...CONTRACT_TYPES] },
    is_termination: { type: "boolean", description: "True when the main agreement described is being terminated or not renewed (Item 1.02); false when it is entered into or amended." },
    counterparty: { type: "string", description: "Legal name of the other party as written in the filing, empty when none is named." },
    counterparty_is_government: { type: "boolean" },
    filer_role: { type: "string", enum: ["supplier_or_seller", "customer_or_buyer", "licensor", "licensee", "partner", "other"] },
    value_text: { type: "string", description: "The agreement's total stated value exactly as written (e.g. \"$12.5 million\"), empty when not stated." },
    term_text: { type: "string", description: "The term or duration exactly as written, empty when not stated." },
    exclusivity: { type: "string", enum: ["exclusive", "non_exclusive", "not_stated"] },
    quote_counterparty: { type: "string", description: "Verbatim sentence naming the counterparty and the agreement." },
    quote_value: { type: "string", description: "Verbatim sentence stating the value, empty when none." },
    quote_term: { type: "string", description: "Verbatim sentence stating the term, empty when none." },
    quote_exclusivity: { type: "string", description: "Verbatim sentence on exclusivity, empty when none." },
  },
} as const;

export const CONTRACT_SYSTEM = `You read SEC Form 8-K filings under Item 1.01 (entry into a material definitive agreement) or Item 1.02 (termination of one) and extract the agreement's facts as structured data. ${UNTRUSTED_NOTE}

Rules:
- Every quote is one sentence copied word for word from the filing. Empty string when the filing does not state the fact.
- value_text and term_text are copied exactly as the filing writes them; never compute, convert or estimate.
- agreement_type: classify the main agreement. Loans, notes, credit facilities, equity purchase agreements, warrants and at-the-market programs are financing_or_credit. Mergers, asset or share purchases of a business are merger_or_acquisition. A one-off sale or purchase of a specific asset (a priority review voucher, a property, mineral or royalty interests, a product line) is asset_sale_or_purchase, not supply_or_purchase; supply_or_purchase is for recurring supply of goods.
- counterparty: the main other party (not the filer, not a subsidiary of the filer, not an agent or trustee).`;

/** "$12.5 million" -> 12_500_000. Null when the text does not hold one dollar figure. Pure. */
export function parseUsd(text: string): number | null {
  const m = /\$\s*([\d,]+(?:\.\d+)?)\s*(thousand|million|billion|[kmb]n?)?\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit.startsWith("b") ? 1e9 : unit.startsWith("m") ? 1e6 : unit.startsWith("t") || unit === "k" ? 1e3 : 1;
  return n * mult;
}

export type AntiPump = { goingConcern: boolean; recentOffering: string | null; shell: boolean };

/** Anti-pump checks from the filing text and the filer's recent filings. Pure. */
export function antiPump(text: string, recent: Array<{ form: string; filingDate: string }>, sic: string | null, acceptedAt: string): AntiPump {
  const since = new Date(Date.parse(acceptedAt) - 30 * 86_400_000).toISOString().slice(0, 10);
  const offering = recent.find((r) => /^(S-1|S-3|424B5)(\/A)?$/.test(r.form) && r.filingDate >= since && r.filingDate <= acceptedAt.slice(0, 10));
  return {
    goingConcern: /going concern|substantial doubt about (?:the Company's|our|its) ability to continue/i.test(text),
    recentOffering: offering ? `${offering.form} filed ${offering.filingDate}` : null,
    shell: sic === "6770" || /\bshell company\b[^.]{0,40}\b(?:☒|\[X\]|yes)/i.test(text),
  };
}

export function contractDetector(): Detector {
  return {
    eventTypes: ["contract_material", "contract_termination"],
    async detect(ctx: DetectorContext): Promise<DetectorEvent[]> {
      const listings = await loadListings();
      const all = await eightKsFiled(ctx.since, ctx.until, ctx.log);
      const withItem = all.filter((k) => k.items.includes("1.01") || k.items.includes("1.02"));
      const routed = withItem.filter((k) => routesToContract(k.items));
      const out: DetectorEvent[] = [];
      const counts = { unlisted: 0, notCommercial: 0, backlog: 0, outside: 0 };
      const types = new Map<string, number>();
      await eachLimit(routed, LLM_CONCURRENCY, async (k0) => {
        const listing = listingOf(k0, listings);
        if (!listing) {
          counts.unlisted++;
          return;
        }
        try {
          const k = await resolveAcceptance(k0);
          if (!inWindow(k.acceptedAt, ctx.since, ctx.until)) {
            counts.outside++;
            return;
          }
          const text = await eightKText(k, { exhibits: true });
          const section = [itemSection(text.main, "1.01"), itemSection(text.main, "1.02")].filter(Boolean).join("\n") || text.main;
          const doc = `${text.main}\n${text.exhibits99}`;
          const company = displayName(listing.name);
          const answer = (await structured(
            { system: CONTRACT_SYSTEM, user: `Filer: ${company}\nItems: ${k.items.join(", ")}\n<filing>\n${clipDoc(`${section}\n\n${text.exhibits99}`, 30_000)}\n</filing>`, schema: CONTRACT_SCHEMA as unknown as Record<string, unknown>, maxTokens: 2500 },
            ctx.llmBudgetUsd,
            ctx.log,
            `contract ${k.accession}`,
          )) as Record<string, unknown> | null;
          if (!answer) {
            counts.backlog++;
            return;
          }
          types.set(String(answer.agreement_type), (types.get(String(answer.agreement_type)) ?? 0) + 1);
          if (!COMMERCIAL_TYPES.has(String(answer.agreement_type))) {
            counts.notCommercial++;
            return;
          }
          const meta = await filerMeta(listing.cik).catch(() => null);
          const revenue = await annualRevenue(listing.cik).catch(() => null);
          const counterparty = typeof answer.counterparty === "string" ? answer.counterparty.trim() : "";
          const cp = counterparty ? matchListed(counterparty, listings) : null;
          const cpRevenue = cp ? await annualRevenue(cp.cik).catch(() => null) : null;
          const ev = contractEvent({
            k: { ...k, acceptedAt: k.acceptedAt! },
            listing,
            company,
            doc,
            answer,
            revenue: revenue ? { value: revenue.value, fiscalYearEnd: revenue.fiscalYearEnd } : null,
            counterparty: cp ? { listing: cp, revenue: cpRevenue?.value ?? null } : null,
            pump: antiPump(doc, meta?.recent ?? [], meta?.sic ?? k.sic, k.acceptedAt!),
          });
          if (ev) out.push(ev);
        } catch (err) {
          ctx.log(`contract: ${k0.accession} unreadable (${(err as Error).message.split("\n")[0]})`);
        }
      });
      ctx.log(
        `contract: ${withItem.length} 8-Ks with 1.01/1.02, ${withItem.length - routed.length} financing dropped, ${counts.unlisted} not US-listed, ${counts.outside} outside window, ` +
          `${counts.notCommercial} not commercial, ${counts.backlog} not read by the model, ${out.length} events (types: ${[...types].map(([t, n]) => `${t} ${n}`).join(", ")})`,
      );
      return out.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    },
  };
}

/** The contract event from the model's extraction, checked against the filing. Pure. */
export function contractEvent(a: {
  k: { accession: string; form: string; items: string[]; acceptedAt: string; indexUrl: string };
  listing: Listing;
  company: string;
  doc: string;
  answer: Record<string, unknown>;
  revenue: { value: number; fiscalYearEnd: string } | null;
  counterparty: { listing: Listing; revenue: number | null } | null;
  pump: AntiPump;
}): DetectorEvent | null {
  const { k, doc, answer: x, company } = a;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const qCounterparty = checkedQuote(x.quote_counterparty, doc);
  const qValue = checkedQuote(x.quote_value, doc);
  const qTerm = checkedQuote(x.quote_term, doc);
  const qExcl = checkedQuote(x.quote_exclusivity, doc);
  const watch: string[] = [];
  const counterparty = str(x.counterparty);
  if (!qCounterparty) watch.push("no verbatim quote for the agreement");
  // A fact counts only when its quote is in the filing and holds it.
  let valueText = str(x.value_text);
  if (valueText && (!qValue || !qValue.includes(valueText.replace(/\s+/g, " ")) || numbersNotIn(valueText, doc).length)) valueText = "";
  let termText = str(x.term_text);
  if (termText && (!qTerm || numbersNotIn(termText, doc).length)) termText = "";
  const exclusivity = qExcl ? str(x.exclusivity) : "not_stated";
  const value = valueText ? parseUsd(valueText) : null;
  const pctOfRevenue = value && a.revenue ? Math.round((value / a.revenue.value) * 100 * 100) / 100 : null;
  const isGov = x.counterparty_is_government === true;
  if (!counterparty) watch.push("no named counterparty");
  else if (!a.counterparty && !isGov) watch.push("counterparty is not a listed SEC filer");
  if (a.pump.goingConcern) watch.push("going-concern language");
  if (a.pump.recentOffering) watch.push(`recent offering (${a.pump.recentOffering})`);
  if (a.pump.shell) watch.push("shell company");
  // Item 1.02 alone is a termination; with 1.01 too, the model says which the main agreement is.
  const termination = k.items.includes("1.02") && (!k.items.includes("1.01") || x.is_termination === true);
  const eventType: EventType = termination ? "contract_termination" : "contract_material";
  const smaller =
    a.counterparty && a.revenue && a.counterparty.revenue ? (a.counterparty.revenue < a.revenue.value ? "counterparty" : "filer") : a.counterparty ? null : "filer";
  const cpName = a.counterparty ? displayName(a.counterparty.listing.name) : counterparty;
  const money = valueText ? (/(?:(?:up to|approximately|about|more than|over)\s+)?(?:US)?\$\s*[\d,]+(?:\.\d+)?(?:\s*(?:thousand|million|billion))?/i.exec(valueText)?.[0] ?? null) : null;
  const kind = str(x.agreement_type).replace(/_/g, " ").replace(/ or /g, "/");
  const title = termination
    ? `${company} reported ending a ${kind} agreement${cpName ? ` with ${cpName}` : ""}`
    : `${company} reported a ${kind} agreement${cpName ? ` with ${cpName}` : ""}${money ? ` valued at ${money}` : ""}`;
  const summary = [`${company} filed an 8-K under Item ${termination ? "1.02" : "1.01"}${counterparty ? ` naming ${counterparty}` : ""}.`];
  if (qCounterparty) summary.push(`"${qCounterparty}"`);
  if (pctOfRevenue !== null && a.revenue) summary.push(`The stated value of ${valueText} compares with ${usd(a.revenue.value)} of revenue in the fiscal year ended ${a.revenue.fiscalYearEnd}.`);
  return {
    id: `${eventType}-${k.accession}`,
    eventType,
    family: "F3",
    cik: a.listing.cik,
    ticker: a.listing.ticker,
    companyName: company,
    acceptedAt: k.acceptedAt,
    accession: k.accession,
    form: k.form,
    items: k.items,
    title,
    summary,
    sign: termination ? -1 : 1,
    magnitude: pctOfRevenue,
    facts: {
      agreementType: str(x.agreement_type),
      counterparty: counterparty || null,
      counterpartyTicker: a.counterparty?.listing.ticker ?? null,
      counterpartyCik: a.counterparty?.listing.cik ?? null,
      counterpartyIsGovernment: isGov,
      filerRole: str(x.filer_role),
      value: valueText || null,
      valueUsd: value,
      term: termText || null,
      exclusivity,
      valuePctOfRevenue: pctOfRevenue,
      revenueUsd: a.revenue?.value ?? null,
      revenueFiscalYearEnd: a.revenue?.fiscalYearEnd ?? null,
      smallerParty: smaller,
    },
    sources: [edgarSource(`8-K Item ${termination ? "1.02" : "1.01"}: ${company}`, k.indexUrl, k.acceptedAt)],
    quotes: [qCounterparty, qValue, qTerm, qExcl].filter((q, i, arr): q is string => !!q && arr.indexOf(q) === i),
    propagates: "own",
    watchOnlyReasons: watch,
  };
}

// ---------------------------------------------------------------- F1 / F2

export const GUIDANCE_LABELS = ["none", "guidance_raise", "guidance_cut", "preannouncement_positive", "preannouncement_negative", "production_disruption", "capex_raise", "capex_cut"] as const;
export type GuidanceLabel = (typeof GUIDANCE_LABELS)[number];

export const LABEL_SIGN: Record<GuidanceLabel, 1 | -1 | 0> = {
  none: 0,
  guidance_raise: 1,
  preannouncement_positive: 1,
  capex_raise: 1,
  guidance_cut: -1,
  preannouncement_negative: -1,
  production_disruption: -1,
  capex_cut: -1,
};

export const GUIDANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      description: "One entry per label that applies; a single entry with label none when nothing applies.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "quote", "change_text"],
        properties: {
          label: { type: "string", enum: [...GUIDANCE_LABELS] },
          quote: { type: "string", description: "One sentence copied word for word from the filing that shows the label; empty for none." },
          change_text: { type: "string", description: "The stated size of the change exactly as written (e.g. \"raised ... to $4.2 billion from $4.0 billion\" or \"15%\"), empty when not stated." },
        },
      },
    },
  },
} as const;

export const GUIDANCE_SYSTEM = `You triage a company's SEC Form 8-K (Item 7.01, 8.01 or a 2.02 earnings exhibit) for news its suppliers would care about. ${UNTRUSTED_NOTE}

Labels (closed set):
- guidance_raise / guidance_cut: the company raises or lowers its own forward outlook (revenue, earnings, units, margin) versus its prior outlook. Reaffirmed or first-time guidance is none.
- preannouncement_positive / preannouncement_negative: results for a period not yet reported are stated or expected above / below prior guidance or expectations.
- production_disruption: a plant shutdown, outage, strike, recall, cyber incident, supply shortage or similar that cuts output.
- capex_raise / capex_cut: planned capital spending raised or cut versus the prior plan.
- none: none of the above (routine news, investor presentations, dividends, financing, results already reported without a change in outlook).

Rules:
- Each quote is one sentence copied word for word from the filing; it must itself show the change.
- Do not infer: a label needs the filing to say it. When unsure, use none.
- change_text is copied exactly as written; never compute.`;

/** Findings checked against the filing: verbatim quote required, no outside numbers. Pure. */
export function checkFindings(answer: unknown, doc: string): Array<{ label: GuidanceLabel; quote: string; changeText: string | null }> {
  const fs = (answer as { findings?: unknown[] })?.findings;
  if (!Array.isArray(fs)) return [];
  const out: Array<{ label: GuidanceLabel; quote: string; changeText: string | null }> = [];
  for (const f of fs) {
    const x = f as Record<string, unknown>;
    const label = x.label as GuidanceLabel;
    if (!GUIDANCE_LABELS.includes(label) || label === "none") continue;
    const quote = checkedQuote(x.quote, doc);
    if (!quote) continue;
    const change = typeof x.change_text === "string" && x.change_text.trim() && numbersNotIn(x.change_text, doc).length === 0 ? x.change_text.trim() : null;
    out.push({ label, quote, changeText: change });
  }
  return out;
}

/** A percent change stated in the change text ("15%", "by 3.5 percent"), as a signed number for the label. Pure. */
export function statedPct(change: string | null, sign: 1 | -1): number | null {
  if (!change) return null;
  const m = /(\d+(?:\.\d+)?)\s*(?:%|percent)/i.exec(change);
  return m ? sign * Number(m[1]) : null;
}

const LABEL_TEXT: Record<GuidanceLabel, string> = {
  none: "",
  guidance_raise: "raised its outlook",
  guidance_cut: "lowered its outlook",
  preannouncement_positive: "reported preliminary results above its prior outlook",
  preannouncement_negative: "reported preliminary results below its prior outlook",
  production_disruption: "reported a production disruption",
  capex_raise: "raised its capital spending plan",
  capex_cut: "cut its capital spending plan",
};

export function guidanceEvents(a: {
  k: { accession: string; form: string; items: string[]; acceptedAt: string; indexUrl: string };
  cik: string;
  ticker: string;
  company: string;
  suppliers: string[];
  findings: ReturnType<typeof checkFindings>;
}): DetectorEvent[] {
  const out: DetectorEvent[] = [];
  for (const sign of [1, -1] as const) {
    const fs = a.findings.filter((f) => LABEL_SIGN[f.label] === sign);
    if (fs.length === 0) continue;
    const eventType: EventType = sign === 1 ? "guidance_up" : "guidance_down";
    const main = fs[0]!;
    const what = [...new Set(fs.map((f) => LABEL_TEXT[f.label]))];
    out.push({
      id: `${eventType}-${a.k.accession}`,
      eventType,
      family: sign === 1 ? "F2" : "F1",
      cik: a.cik,
      ticker: a.ticker,
      companyName: a.company,
      acceptedAt: a.k.acceptedAt,
      accession: a.k.accession,
      form: a.k.form,
      items: a.k.items,
      title: `${a.company} ${what.join(" and ")}`,
      summary: [`${a.company} ${what.join(" and ")} in an 8-K (Item ${a.k.items.filter((i) => i !== "9.01").join(", ")}).`, ...fs.slice(0, 2).map((f) => `"${f.quote}"`)],
      sign,
      magnitude: fs.map((f) => statedPct(f.changeText, sign)).find((x) => x !== null) ?? null,
      facts: { labels: fs.map((f) => f.label).join(", "), change: main.changeText, suppliersInGraph: a.suppliers.join(", ") },
      sources: [edgarSource(`8-K: ${a.company}`, a.k.indexUrl, a.k.acceptedAt)],
      quotes: fs.map((f) => f.quote),
      propagates: "linked",
      watchOnlyReasons: [],
    });
  }
  return out;
}

export function guidanceDetector(): Detector {
  return {
    eventTypes: ["guidance_down", "guidance_up"],
    async detect(ctx: DetectorContext): Promise<DetectorEvent[]> {
      const listings = await loadListings();
      const watch = customerWatch(listings);
      const all = await eightKsFiled(ctx.since, ctx.until, ctx.log);
      const routed = all.filter((k) => k.ciks.some((c) => watch.has(c)) && k.items.some((i) => i === "7.01" || i === "8.01" || i === "2.02"));
      const out: DetectorEvent[] = [];
      let backlog = 0;
      let none = 0;
      await eachLimit(routed, LLM_CONCURRENCY, async (k0) => {
        const cik = k0.ciks.find((c) => watch.has(c))!;
        try {
          const k = await resolveAcceptance(k0);
          if (!inWindow(k.acceptedAt, ctx.since, ctx.until)) return;
          const text = await eightKText(k, { exhibits: true });
          // 2.02 alone: only the EX-99 release counts; 7.01 / 8.01: the item text and its exhibits.
          const only202 = !k.items.includes("7.01") && !k.items.includes("8.01");
          if (only202 && !text.exhibits99) return;
          const body = only202 ? text.exhibits99 : [itemSection(text.main, "7.01"), itemSection(text.main, "8.01"), text.exhibits99].filter(Boolean).join("\n\n") || text.main;
          const w = watch.get(cik)!;
          const company = displayName(listings.byCik.get(cik)?.name ?? k.companyName);
          const answer = await structured(
            { system: GUIDANCE_SYSTEM, user: `Company: ${company} (${w.ticker})\nItems: ${k.items.join(", ")}\n<filing>\n${clipDoc(body, 60_000)}\n</filing>`, schema: GUIDANCE_SCHEMA as unknown as Record<string, unknown>, maxTokens: 1200 },
            ctx.llmBudgetUsd,
            ctx.log,
            `guidance ${k.accession}`,
          );
          if (answer === null) {
            backlog++;
            return;
          }
          const findings = checkFindings(answer, body);
          if (findings.length === 0) none++;
          out.push(...guidanceEvents({ k: { ...k, acceptedAt: k.acceptedAt! }, cik, ticker: w.ticker, company, suppliers: w.suppliers, findings }));
        } catch (err) {
          ctx.log(`guidance: ${k0.accession} unreadable (${(err as Error).message.split("\n")[0]})`);
        }
      });
      ctx.log(`guidance: watch set ${watch.size} graph customers, ${routed.length} 8-Ks routed, ${none} triaged none, ${backlog} not read by the model, ${out.length} events`);
      return out;
    },
  };
}
