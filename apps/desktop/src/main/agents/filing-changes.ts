import type { AgentFilingChangeKind, AgentLine, AgentTrigger } from "../../shared/agent-types";
import { plainDashes } from "../../shared/copy-rules";
import type { FilingChangeItem, FilingChanges, FilingDocRef } from "../../shared/filing-changes";
import type { FilingRef } from "./sources";
import { filingMs, line, type TriggerCheck, type TriggerContext } from "./triggers";
import { DAY_MS, HOUR_MS, MINUTE_MS, isEdgarOpen } from "./time";

/**
 * The `filing_changes` trigger: "tell me when SMCI's next 10-K or 10-Q adds
 * a risk factor, reports a material weakness, changes auditor, or names a new
 * customer."
 *
 * The source is the Filing changes service (main/filings/service.ts, the
 * Stock tab's section and the dashboard card), which compares a company's
 * newest annual report with the one before, its latest 10-Q with the annual
 * report it updates, and reads the red flags in its EDGAR index. Nothing
 * here calls a model; the write-up's opening paragraph is written here from
 * the service's items, with the filing's own words quoted.
 *
 * What it watches. Every new filing in the company's EDGAR index (through
 * the agent's spaced, cached reader) filed after the agent was created:
 *   periodic    10-K, 10-KT, 20-F, 10-Q, 10-QT (always)
 *   red flags   an 8-K with item 4.01 or 4.02, a late filing notice (NT 10-K,
 *               NT 10-Q, ...), when `kinds` has "red_flags"
 * For each, the service is asked for an answer that covers that filing (it
 * reads EDGAR again when its kept answer predates it, at most every ten
 * minutes). The filing fires when it has a change of a watched kind that is
 * neither a repeat of the previous annual report's red flag (`repeat`) nor
 * already in the 10-Q filed right before it (`carried`). A filing with none
 * is consumed quietly under its own key (`filing_changes:<accession>`), so a
 * plain filing trigger on the same agent still reports it; a filing that
 * fires is consumed as `filing:<accession>`, the plain filing trigger's key,
 * so one filing is never two reports in one agent. The plain trigger waits
 * up to six hours for this one to decide (triggers.ts).
 *
 * Pure apart from `AgentDataSources`, so every rule runs against fakes.
 */

export type FilingChangesTrigger = Extract<AgentTrigger, { kind: "filing_changes" }>;

export const FILING_CHANGE_KINDS_ORDER: readonly AgentFilingChangeKind[] = ["risk_factors", "red_flags", "customers", "suppliers"];

/** Periodic reports the service compares. */
const PERIODIC = new Set(["10-K", "10-KT", "10-K405", "20-F", "10-Q", "10-QT"]);
/** How long a covered answer missing a document is waited on before what is there is reported. */
const DOCUMENTS_WAIT_MS = DAY_MS;
/** The plain filing trigger defers a filing to this one for at most this long. */
export const DEFER_TO_CHANGES_MS = 6 * HOUR_MS;
/** Filings one report covers. */
const MAX_FILINGS = 3;
/** Risk factor headings quoted in the opening paragraph before "and N more". */
const MAX_QUOTED_HEADINGS = 6;

/** The kinds a trigger watches; absent or empty is all four. */
export function kindsOf(t: Pick<FilingChangesTrigger, "kinds">): AgentFilingChangeKind[] {
  return t.kinds && t.kinds.length > 0 ? FILING_CHANGE_KINDS_ORDER.filter((k) => t.kinds!.includes(k)) : [...FILING_CHANGE_KINDS_ORDER];
}

/** Whether the trigger looks at a filing at all. */
export function watchesFiling(f: Pick<FilingRef, "form" | "items">, kinds: readonly AgentFilingChangeKind[]): boolean {
  const form = f.form.toUpperCase().trim();
  if (PERIODIC.has(form)) return true;
  if (!kinds.includes("red_flags")) return false;
  if (/^8-K/.test(form)) return f.items.includes("4.01") || f.items.includes("4.02");
  return /^NT /.test(form);
}

/** The watched kind an item belongs to; null for items that never fire (removed or reworded headings). */
export function kindOfItem(item: Pick<FilingChangeItem, "kind">): AgentFilingChangeKind | null {
  switch (item.kind) {
    case "risk_new":
    case "quarter_risk_new":
      return "risk_factors";
    case "restatement":
    case "going_concern":
    case "material_weakness":
    case "auditor_change":
    case "auditor_name":
    case "late_filing":
      return "red_flags";
    case "customer_named":
    case "customer_share":
    case "customer_share_new":
    case "customer_share_dropped":
      return "customers";
    case "supplier_named":
    case "sole_source_new":
      return "suppliers";
    default:
      return null;
  }
}

/** Whether an item fires for these kinds: watched, new to this filing, and big enough to say. */
export function itemFires(item: FilingChangeItem, kinds: readonly AgentFilingChangeKind[]): boolean {
  const kind = kindOfItem(item);
  if (!kind || !kinds.includes(kind)) return false;
  if (item.repeat || item.carried === true) return false;
  // A share that moved by less than the service's notable bar (5 points) is not news.
  if (item.kind === "customer_share") return item.notable;
  return true;
}

/** The accession an item comes from (service ids are `<kind>:<accession>[:...]`). */
export function itemAccession(item: Pick<FilingChangeItem, "id">): string {
  return item.id.split(":")[1] ?? "";
}

/** Whether the answer compares the filing or lists an item from it. */
function covers(answer: FilingChanges, accession: string): boolean {
  if (answer.latest?.accession === accession || answer.quarter?.accession === accession) return true;
  return answer.items.some((i) => itemAccession(i) === accession);
}

/** One filing that fired: every item the service has for it, and the ones that fire. */
export type ChangesHit = { filing: FilingRef; items: FilingChangeItem[]; firing: FilingChangeItem[] };

/* ------------------------------------------------------------------ */
/* Words                                                                */
/* ------------------------------------------------------------------ */

function article(form: string): string {
  return /^(8|11|18|S|F|A|E|NT)/i.test(form) ? "an" : "a";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "";
  return `${Math.round(n * 10) / 10}%`;
}

/** The filing's own words, set in a sentence of ours: one line, plain dashes, inner quotes made single, capped. */
export function quoteText(text: string, max: number): string {
  const one = plainDashes(text.replace(/\s+/g, " ").trim()).replace(/"/g, "'").replace(/[.;,:\s]+$/, "");
  return one.length <= max ? one : `${one.slice(0, max - 3).replace(/\s+\S*$/, "")}...`;
}

function quoted(text: string | null, max = 260): string | null {
  return text && text.trim() ? `"${quoteText(text, max)}"` : null;
}

function basisWord(item: Pick<FilingChangeItem, "detail">): string {
  return item.detail === "receivables" ? "accounts receivable" : "revenue";
}

/** The comparison's base for an item: the annual report a 10-Q updates, or the previous annual report. */
function baseOf(item: FilingChangeItem, answer: FilingChanges): FilingDocRef | null {
  return item.kind === "quarter_risk_new" ? answer.latest : answer.previous;
}

/** What the filing itself is, in one sentence. */
export function openerSentence(f: Pick<FilingRef, "form" | "filedAt" | "items">, ticker: string): string {
  const form = f.form.toUpperCase();
  if (/^8-K/.test(form)) {
    const parts: string[] = [];
    if (f.items.includes("4.01")) parts.push("item 4.01, a change in its certifying accountant");
    if (f.items.includes("4.02")) parts.push("item 4.02, non-reliance on previously issued financial statements or a related audit report");
    return `${ticker} filed an ${f.form} on ${f.filedAt} under ${parts.join(", and ")}.`;
  }
  if (/^NT /.test(form)) return `${ticker} filed ${article(f.form)} ${f.form} on ${f.filedAt}, a notice that its ${f.form.slice(3).trim()} could not be filed on time.`;
  return `${ticker} filed ${article(f.form)} ${f.form} on ${f.filedAt}.`;
}

/** One sentence per firing item that the opener does not already say. */
export function itemSentences(firing: readonly FilingChangeItem[], answer: FilingChanges, all: readonly FilingChangeItem[] = firing): string[] {
  const out: string[] = [];
  const risks = firing.filter((i) => i.kind === "risk_new" || i.kind === "quarter_risk_new");
  if (risks.length > 0) {
    const base = baseOf(risks[0]!, answer);
    const heads = risks.slice(0, MAX_QUOTED_HEADINGS).map((i) => quoted(i.text, 200)).filter((q): q is string => q !== null);
    const more = risks.length - heads.length;
    const against = base ? ` against the ${base.form} filed ${base.filedAt}` : "";
    out.push(`${plural(risks.length, "new risk factor heading", "new risk factor headings")}${against}: ${heads.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`);
    const carried = all.filter((i) => (i.kind === "risk_new" || i.kind === "quarter_risk_new") && i.carried === true).length;
    if (carried > 0) out.push(`${plural(carried, "other heading new against that report was", "other headings new against that report were")} already in the 10-Q filed before this one.`);
    if (risks[0]!.kind === "risk_new" && answer.riskCount) {
      out.push(`The section has ${answer.riskCount.latest} headings, against ${answer.riskCount.previous} in the previous annual report.`);
    }
  }
  for (const i of firing) {
    const q = quoted(i.text);
    switch (i.kind) {
      case "material_weakness":
        out.push(`The filing reports a material weakness in internal control${q ? `: ${q}` : ""}.`);
        break;
      case "going_concern":
        out.push(`The filing has going concern language${q ? `: ${q}` : ""}.`);
        break;
      case "auditor_name":
        out.push(`The auditor named in this report is ${i.name ?? "not stated"}; the previous annual report named ${i.previous ?? "another firm"}.`);
        break;
      case "customer_named":
        out.push(`${i.name} is named as a customer${i.pct !== null ? ` (${fmtPct(i.pct)})` : ""}; the previous annual report does not name it${q ? `: ${q}` : ""}.`);
        break;
      case "supplier_named":
        out.push(`${i.name} is named as a supplier; the previous annual report does not name it${q ? `: ${q}` : ""}.`);
        break;
      case "customer_share":
        out.push(`${i.name}: ${fmtPct(i.pct)} of ${basisWord(i)}, against ${fmtPct(i.previousPct)} in the previous annual report${q ? `: ${q}` : ""}.`);
        break;
      case "customer_share_new":
        out.push(`${i.name}: ${fmtPct(i.pct)} of ${basisWord(i)}; the previous annual report states no share for it${q ? `: ${q}` : ""}.`);
        break;
      case "customer_share_dropped":
        out.push(`${i.name} was ${fmtPct(i.previousPct)} of ${basisWord(i)} in the previous annual report; this one states no share for it.`);
        break;
      case "sole_source_new":
        if (q) out.push(`A sole or single source passage not in the previous annual report: ${q}.`);
        break;
      default:
        // Risk headings are said above; 8-K items and late notices by the opener.
        break;
    }
  }
  return out;
}

/** Where to read it: the risk factors section when the change is there and has an anchor, else the document. */
export function readUrl(hit: ChangesHit): string {
  const risk = hit.firing.find((i) => i.kind === "risk_new" || i.kind === "quarter_risk_new");
  return (risk ?? hit.firing[0])?.url ?? hit.filing.url;
}

/**
 * The paragraphs that open a filing changes report, one per filing: what was
 * filed, each change with the filing's own words quoted, and the link to the
 * filing on SEC EDGAR. Written here, not by the model, so the evidence is
 * always there and always as filed.
 */
export function changesLead(hits: readonly ChangesHit[], ticker: string, answer: FilingChanges): string {
  return hits
    .map((h) => [openerSentence(h.filing, ticker), ...itemSentences(h.firing, answer, h.items), `SEC EDGAR: ${readUrl(h)}`].join(" "))
    .join("\n\n");
}

/** What one filing changed, in a few words, for the title. */
function changeWords(h: ChangesHit): string[] {
  const words: string[] = [];
  const form = h.filing.form.toUpperCase();
  if (/^8-K/.test(form)) {
    if (h.filing.items.includes("4.01")) words.push("auditor change");
    if (h.filing.items.includes("4.02")) words.push("non-reliance notice");
    return words;
  }
  if (/^NT /.test(form)) return ["late filing notice"];
  const n = (kinds: readonly string[]) => h.firing.filter((i) => kinds.includes(i.kind)).length;
  const risks = n(["risk_new", "quarter_risk_new"]);
  if (risks > 0) words.push(plural(risks, "new risk factor", "new risk factors"));
  if (n(["material_weakness"]) > 0) words.push("material weakness");
  if (n(["going_concern"]) > 0) words.push("going concern language");
  const auditor = h.firing.find((i) => i.kind === "auditor_name");
  if (auditor) words.push(`auditor now ${auditor.name ?? "changed"}`);
  const customers = n(["customer_named", "customer_share", "customer_share_new", "customer_share_dropped"]);
  if (customers > 0) words.push(plural(customers, "customer change", "customer changes"));
  const suppliers = n(["supplier_named", "sole_source_new"]);
  if (suppliers > 0) words.push(plural(suppliers, "supplier change", "supplier changes"));
  return words;
}

/** The event's one line (also the fallback headline). */
export function changesTitle(hits: readonly ChangesHit[], ticker: string): string {
  if (hits.length === 1) {
    const h = hits[0]!;
    return `${ticker} ${h.filing.form} filed ${h.filing.filedAt}: ${changeWords(h).join(", ")}.`;
  }
  return `${ticker} filing changes in ${hits.length} filings: ${hits.map((h) => `${h.filing.form} ${h.filing.filedAt} (${changeWords(h).join(", ")})`).join("; ")}.`;
}

/**
 * Lines for the model beside the opening paragraph: every item the service
 * has for each filing (also the ones that do not fire: removed and reworded
 * headings, small share moves), and what the comparison could not see.
 */
export function changesFacts(hits: readonly ChangesHit[], answer: FilingChanges): string[] {
  const out: string[] = [];
  for (const h of hits) {
    const label = `${h.filing.form} filed ${h.filing.filedAt}`;
    for (const i of h.items) {
      if (h.firing.includes(i)) continue;
      const text = i.text ? ` "${quoteText(i.text, 200)}"` : "";
      const was = i.previous && i.kind !== "auditor_name" ? ` (previously "${quoteText(i.previous, 160)}")` : "";
      const tag = i.repeat ? ", also in the previous annual report" : i.carried ? ", also in the 10-Q before it" : "";
      out.push(`Other item in the ${label}: ${i.kind.replace(/_/g, " ")}${i.name ? ` ${i.name}` : ""}${i.pct !== null ? ` ${fmtPct(i.pct)}` : ""}${i.previousPct !== null ? ` (was ${fmtPct(i.previousPct)})` : ""}${text}${was}${tag}.`);
    }
  }
  if (answer.latest && answer.previous) out.push(`Compared: ${answer.latest.form} filed ${answer.latest.filedAt} against ${answer.previous.form} filed ${answer.previous.filedAt}.`);
  // No reading (no section, or one that did not read as risk factors: `risk_unreadable`): nothing is said about it.
  if (answer.quarter && answer.quarterRisk) {
    const status =
      answer.quarterRisk === "no_material_changes"
        ? "says there are no material changes to the risk factors"
        : answer.quarterRisk === "updated"
          ? "lists risk factor headings, compared with the annual report"
          : "has a risk factors section that could not be compared";
    out.push(`The ${answer.quarter.form} filed ${answer.quarter.filedAt} ${status}.`);
  }
  if (answer.relationships === "graph_older") out.push("Customer and supplier names were not compared: the filing graph was built from an older annual report.");
  if (answer.relationships === "none") out.push("No customer or supplier names from the filing graph for this company, so none were compared by name.");
  if (answer.missing.includes("risk_section")) out.push("A risk factors section could not be read in one of the reports.");
  if (answer.missing.includes("documents")) out.push("One of the filings could not be read from EDGAR, so the comparison is incomplete.");
  return out;
}

/* ------------------------------------------------------------------ */
/* The check                                                            */
/* ------------------------------------------------------------------ */

export async function checkFilingChanges(t: FilingChangesTrigger, ctx: TriggerContext): Promise<TriggerCheck> {
  const { now, sources, agent, state } = ctx;
  const nowMs = now.getTime();
  const created = Date.parse(agent.createdAt);
  const kinds = kindsOf(t);
  const cadence = isEdgarOpen(now) ? 15 * MINUTE_MS : 2 * HOUR_MS;
  const fired = (key: string) => state.firedKeys.includes(key);
  const seen = (acc: string) => fired(`filing:${acc}`) || fired(`filing_changes:${acc}`);

  // Oldest first, so a report reads in filing order.
  const candidates = (await sources.filings(t.ticker))
    .filter((f) => watchesFiling(f, kinds) && filingMs(f) >= created && !seen(f.accession))
    .sort((a, b) => filingMs(a) - filingMs(b));

  const hits: ChangesHit[] = [];
  const quiet: FilingRef[] = [];
  const reading: FilingRef[] = [];
  let answer: FilingChanges | null = null;
  let failed = 0;
  for (const f of candidates) {
    let a: FilingChanges;
    try {
      a = await sources.filingChanges(t.ticker, f.accession);
    } catch {
      failed++;
      continue;
    }
    const age = nowMs - filingMs(f);
    if (!covers(a, f.accession)) {
      // Read after the filing and still not compared (an amendment, no
      // primary document): nothing to say about it, so it is let go.
      if (!a.missing.includes("documents") && Date.parse(a.checkedAt) >= filingMs(f)) quiet.push(f);
      else reading.push(f);
      continue;
    }
    if (a.missing.includes("documents") && age < DOCUMENTS_WAIT_MS) {
      reading.push(f);
      continue;
    }
    answer = a;
    const items = a.items.filter((i) => itemAccession(i) === f.accession);
    const firing = items.filter((i) => itemFires(i, kinds));
    if (firing.length === 0) quiet.push(f);
    else hits.push({ filing: f, items, firing });
  }
  if (candidates.length > 0 && failed === candidates.length) throw new Error("the filing changes could not be read from EDGAR");

  // Read and found nothing watched: consumed under this trigger's own key, so
  // a plain filing trigger on the same agent still reports the filing.
  if (quiet.length > 0) state.firedKeys = [...state.firedKeys, ...quiet.map((f) => `filing_changes:${f.accession}`)];

  if (hits.length > 0 && answer) {
    const picked = hits.slice(-MAX_FILINGS);
    return {
      status: "fired",
      event: {
        keys: picked.map((h) => `filing:${h.filing.accession}`),
        kind: "filing_changes",
        trigger: t,
        title: changesTitle(picked, t.ticker),
        at: now.toISOString(),
        ticker: t.ticker,
        filings: picked.map((h) => h.filing),
        changes: { answer, hits: picked },
      },
      nextCheckMs: cadence,
    };
  }

  const every = cadence === 15 * MINUTE_MS ? line("filing.checksEdgarEvery15m") : line("filing.checksEdgarEvery2h");
  const everyText = cadence === 15 * MINUTE_MS ? "Checks EDGAR every 15 minutes." : "Checks EDGAR every 2 hours.";
  if (reading.length > 0) {
    const f = reading[reading.length - 1]!;
    const l = line("changes.reading", { ticker: t.ticker, form: f.form, date: f.filedAt });
    const text = `Reading the ${t.ticker} ${f.form} filed ${f.filedAt}.`;
    return { status: "waiting", note: text, detail: text, noteLines: [l], detailLines: [l], nextCheckMs: 10 * MINUTE_MS };
  }
  const watching = line("changes.watching", { ticker: t.ticker });
  const watchingText = `Watching the next ${t.ticker} annual or quarterly report for changes.`;
  if (quiet.length > 0) {
    const f = quiet[quiet.length - 1]!;
    const none = line("changes.noneWatched", { ticker: t.ticker, form: f.form, date: f.filedAt });
    const noneText = `Read the ${t.ticker} ${f.form} filed ${f.filedAt}: none of the watched changes.`;
    return {
      status: "waiting",
      note: noneText,
      detail: `${noneText} ${everyText}`,
      noteLines: [none],
      detailLines: [none, every],
      nextCheckMs: cadence,
    };
  }
  const detailLines: AgentLine[] = [watching, every];
  const detail = [watchingText, everyText];
  if (failed > 0) {
    detailLines.push(line("changes.unavailable"));
    detail.push("The filing changes could not be read this time.");
  }
  return {
    status: "waiting",
    note: watchingText,
    detail: detail.join(" "),
    noteLines: [watching],
    detailLines,
    nextCheckMs: failed > 0 ? Math.min(cadence, 30 * MINUTE_MS) : cadence,
  };
}

/**
 * Whether a plain filing trigger on the same agent leaves this filing to a
 * filing changes trigger for now: the changes trigger watches it and has not
 * decided yet, and the filing is less than six hours old.
 */
export function deferredToChanges(
  f: FilingRef,
  ticker: string,
  triggers: readonly AgentTrigger[],
  firedKeys: readonly string[],
  nowMs: number,
): boolean {
  if (firedKeys.includes(`filing_changes:${f.accession}`)) return false;
  if (nowMs - filingMs(f) >= DEFER_TO_CHANGES_MS) return false;
  return triggers.some((x) => x.kind === "filing_changes" && x.ticker === ticker && watchesFiling(f, kindsOf(x)));
}
