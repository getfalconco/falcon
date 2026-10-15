/**
 * Filing changes: the plain lines the dashboard card and the Stock tab print
 * for an item. Every name, share and form is the item's own (main/filings);
 * the filing's own words are quoted, never rewritten.
 *
 * Pure: the wording comes in through `say` (the i18n table), dates and
 * numbers through Intl.
 */

import type { Say } from "./earnings-view";
import { LARGEST_CUSTOMER, type FilingChangeItem, type FilingChangeKind, type FilingDocRef } from "./filing-changes";

function formatter(lang: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...options });
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options });
  }
}

/** "Feb 20, 2026" in the reader's language. */
export function filingDate(ymd: string, lang: string): string {
  const ms = Date.parse(`${ymd}T12:00:00Z`);
  if (!Number.isFinite(ms)) return ymd;
  return formatter(lang, { year: "numeric", month: "short", day: "numeric" }).format(new Date(ms));
}

/** A share as the filing states it: "24%", "29.8%". */
export function sharePct(pct: number | null, lang: string): string {
  if (pct === null || !Number.isFinite(pct)) return "";
  try {
    return new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 }).format(pct / 100);
  } catch {
    return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(pct / 100);
  }
}

/** Kinds whose rows read "{count} new risk factors" when a filing has several. */
const COUNTED: ReadonlySet<FilingChangeKind> = new Set(["risk_new", "quarter_risk_new", "risk_removed", "risk_reworded", "quarter_risk_reworded", "customer_named", "supplier_named", "customer_share_new"]);

/**
 * What changed, in a few words: "New risk factor", "Auditor changed from
 * Ernst & Young LLP to KPMG LLP", "Globex: 24% of revenue, was 18%". With
 * `count` above one, the counted form ("3 new risk factors").
 */
export function changeLabel(item: FilingChangeItem, say: Say, lang: string, count = 1): string {
  if (count > 1 && COUNTED.has(item.kind)) return say(`filings.many.${item.kind}`, { count });
  const basis = item.detail === "receivables" ? "receivables" : "revenue";
  const customer = item.name === LARGEST_CUSTOMER ? say("filings.name.largestCustomer") : (item.name ?? "");
  switch (item.kind) {
    case "auditor_name":
      return say("filings.kind.auditor_name", { previous: item.previous ?? "", name: item.name ?? "" });
    case "late_filing":
      return say("filings.kind.late_filing", { form: item.detail ?? item.form });
    case "customer_named":
    case "supplier_named":
      return say(`filings.kind.${item.kind}`, { name: item.name ?? "" });
    case "customer_share":
      return say(`filings.kind.customer_share.${basis}`, { name: customer, pct: sharePct(item.pct, lang), previous: sharePct(item.previousPct, lang) });
    case "customer_share_new":
      return say(`filings.kind.customer_share_new.${basis}`, { name: customer, pct: sharePct(item.pct, lang) });
    case "customer_share_dropped":
      return say(`filings.kind.customer_share_dropped.${basis}`, { name: customer, previous: sharePct(item.previousPct, lang) });
    default:
      return say(`filings.kind.${item.kind}`);
  }
}

/** The filing's own words to quote under the label, when the label does not already carry them. */
export function quoteOf(item: FilingChangeItem): string | null {
  const text = item.text?.trim();
  if (!text) return null;
  return text;
}

/** "10-K filed Feb 20, 2026": a filing as a source line. */
export function filingLine(ref: Pick<FilingDocRef, "form" | "filedAt">, say: Say, lang: string): string {
  return say("filings.filed", { form: ref.form, date: filingDate(ref.filedAt, lang) });
}

/** Only sec.gov links are opened. */
export function safeSecUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  return /^https:\/\/(?:www\.)?sec\.gov\//i.test(url) ? url : null;
}

export type ItemGroup = "flags" | "risks" | "relations";

export function groupOf(kind: FilingChangeKind): ItemGroup {
  switch (kind) {
    case "restatement":
    case "going_concern":
    case "material_weakness":
    case "auditor_change":
    case "auditor_name":
    case "late_filing":
      return "flags";
    case "risk_new":
    case "quarter_risk_new":
    case "risk_removed":
    case "risk_reworded":
    case "quarter_risk_reworded":
      return "risks";
    default:
      return "relations";
  }
}
