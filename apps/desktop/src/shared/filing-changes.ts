/**
 * Filing changes: what a company changed in its latest annual or quarterly
 * report against the one before, read mechanically from EDGAR
 * (main/filings). Shared by main, the preload bridge and the renderer.
 *
 * Every item is a fact with its filing: a risk factor heading quoted
 * verbatim, a sentence quoted verbatim, a form and an item number from the
 * EDGAR index. Nothing is summarised or scored by a model.
 */

/** A filing the comparison read. */
export type FilingDocRef = {
  form: string;
  accession: string;
  /** "YYYY-MM-DD" */
  filedAt: string;
  /** The document on sec.gov. */
  url: string;
  /** The document at its risk factors section, when the filing gives the section an anchor. */
  sectionUrl: string | null;
};

export const FILING_CHANGE_KINDS = [
  "restatement",
  "going_concern",
  "material_weakness",
  "auditor_change",
  "auditor_name",
  "late_filing",
  "risk_new",
  "quarter_risk_new",
  "risk_removed",
  "risk_reworded",
  "quarter_risk_reworded",
  "customer_named",
  "supplier_named",
  "customer_share",
  "customer_share_new",
  "customer_share_dropped",
  "sole_source_new",
] as const;

export type FilingChangeKind = (typeof FILING_CHANGE_KINDS)[number];

/**
 * The name a customer share item carries when it compares unnamed customers
 * by size: the largest unnamed customer's share against the previous annual
 * report's largest (a filing's "Customer A" need not be the same customer
 * from one year to the next). The renderer says it in the reader's language.
 */
export const LARGEST_CUSTOMER = "Largest customer";

export type FilingChangeItem = {
  id: string;
  kind: FilingChangeKind;
  /** The filing that shows the change. */
  form: string;
  /** "YYYY-MM-DD", the day that filing was filed. */
  date: string;
  /** Where to read it: the section when there is an anchor, else the document or the filing index. */
  url: string;
  /** Verbatim from the filing: the heading, the sentence, or the evidence quote. */
  text: string | null;
  /** The previous filing's wording or value (the heading before rewording, the earlier auditor). */
  previous: string | null;
  /** A company or firm name: the customer, the supplier, the auditor. */
  name: string | null;
  /** A share in percent, as the filing states it. */
  pct: number | null;
  previousPct: number | null;
  /** 8-K item numbers ("4.01"), or the late notice's form ("NT 10-K"). */
  detail: string | null;
  /** Shown on the dashboard card as well as in the Stock tab. */
  notable: boolean;
  /** A red flag the previous filing already carried: still there, not new. */
  repeat: boolean;
  /**
   * New against the comparison's base (the previous annual report, or for a
   * 10-Q the annual report it updates), but already in the periodic report
   * filed right before this one (the 10-Q in between): a risk factor heading
   * or a red flag a reader of each report has seen. Set only on the newest
   * filing's items, and only when that report could be read; absent is not
   * known. The agents' filing changes watch skips these.
   */
  carried?: boolean;
};

export type QuarterRiskStatus = "no_material_changes" | "updated" | "unclear";

/**
 * How the customer and supplier names were compared:
 *   compared      the filing graph's names from the latest annual report,
 *                 each searched for in the previous report's full text
 *   graph_older   the filing graph was built from an older report than the
 *                 latest, so its names are not compared
 *   none          no filing graph names for this company
 */
export type RelationshipCoverage = "compared" | "graph_older" | "none";

/**
 * What the comparison could not do:
 *   annual / previous  no annual report, or only one, in the EDGAR index
 *   risk_section       a report's risk factors section, or its headings, was not found
 *   risk_unreadable    a report's risk factors section was found but did not read as
 *                      risk factors (an integrated report's layout): no risk factor item,
 *                      count or quarter line is given, and nothing is said about it
 *   documents          a filing could not be read from EDGAR
 */
export type FilingChangesMissing = "annual" | "previous" | "risk_section" | "risk_unreadable" | "documents";

export type FilingChanges = {
  ticker: string;
  /** ISO instant the EDGAR index was last read for this answer. */
  checkedAt: string;
  latest: FilingDocRef | null;
  previous: FilingDocRef | null;
  /** The latest 10-Q filed after `latest`, when there is one. */
  quarter: FilingDocRef | null;
  quarterRisk: QuarterRiskStatus | null;
  riskCount: { latest: number; previous: number } | null;
  relationships: RelationshipCoverage;
  items: FilingChangeItem[];
  missing: FilingChangesMissing[];
};

export type FilingChangesError = "invalid_request" | "unavailable";

export type FilingChangesResult = { ok: true; changes: FilingChanges } | { ok: false; error: FilingChangesError };

export type FilingOverviewRequest = { held: string[]; watchlist: string[] };

/** One dashboard line: one kind of change in one filing of one name. */
export type FilingOverviewRow = {
  id: string;
  ticker: string;
  held: boolean;
  watchlist: boolean;
  item: FilingChangeItem;
  /** How many items of this kind the filing has (three new risk factors make one row). */
  count: number;
};

export type FilingOverviewResult =
  /** `checked`: names read today (or paused after a failed read); `pending`: names still to read. */
  | { ok: true; rows: FilingOverviewRow[]; pending: string[]; checked: number }
  | { ok: false; error: FilingChangesError };

/** Names one overview reads; more are dropped (held names first). */
export const FILINGS_MAX_NAMES = 40;
/** A notable change older than this many days leaves the dashboard. */
export const FILINGS_CARD_DAYS = 400;

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export function normalizeTicker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().toUpperCase();
  return TICKER_RE.test(t) ? t : null;
}

export function parseChangesRequest(value: unknown): string | null {
  if (typeof value === "string") return normalizeTicker(value);
  if (value && typeof value === "object") return normalizeTicker((value as { ticker?: unknown }).ticker);
  return null;
}

export function parseOverviewRequest(value: unknown): FilingOverviewRequest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { held?: unknown; watchlist?: unknown };
  const list = (x: unknown): string[] | null => {
    if (x === undefined) return [];
    if (!Array.isArray(x)) return null;
    const out: string[] = [];
    for (const item of x) {
      const t = normalizeTicker(item);
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  };
  const held = list(v.held);
  const watchlist = list(v.watchlist);
  if (!held || !watchlist) return null;
  return { held, watchlist: watchlist.filter((t) => !held.includes(t)) };
}

/** Red flags first, then risk factors, then customers and suppliers. */
export function kindRank(kind: FilingChangeKind): number {
  return FILING_CHANGE_KINDS.indexOf(kind);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The dashboard's lines: each name's notable items, one line per kind per
 * filing (with a count), newest filing first, red flags before risk factors
 * on the same day, held names before watched ones on a tie.
 */
export function overviewRows(
  answers: readonly { changes: FilingChanges; held: boolean; watchlist: boolean }[],
  today: string,
  maxDays = FILINGS_CARD_DAYS,
): FilingOverviewRow[] {
  const rows: FilingOverviewRow[] = [];
  for (const { changes, held, watchlist } of answers) {
    const groups = new Map<string, FilingOverviewRow>();
    for (const item of changes.items) {
      if (!item.notable || item.repeat) continue;
      if (daysBetween(item.date, today) > maxDays) continue;
      const key = `${changes.ticker}|${item.kind}|${item.form}|${item.date}`;
      const row = groups.get(key);
      if (row) row.count++;
      else groups.set(key, { id: key, ticker: changes.ticker, held, watchlist, item, count: 1 });
    }
    rows.push(...groups.values());
  }
  return rows.sort(
    (a, b) =>
      b.item.date.localeCompare(a.item.date) ||
      kindRank(a.item.kind) - kindRank(b.item.kind) ||
      Number(b.held) - Number(a.held) ||
      a.ticker.localeCompare(b.ticker),
  );
}
