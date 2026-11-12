/**
 * A company's past events of one kind, from EDGAR, for the history of a card
 * (src/history.ts):
 *
 *   earnings         8-K filings with item 2.02 (results of operations), the
 *                    US filers' earnings releases. Preliminary results filed
 *                    under 2.02 are in the list too; they have no EPS surprise
 *                    on record, so the history leaves them out.
 *   monthly_revenue  the Taiwan monthly revenue 6-Ks (TSMC, ASE, UMC), each
 *                    read for its change from a year earlier.
 *
 * Each with its true acceptance instant (src/edgar-time.ts: the index's clock
 * is read per file) as the moment the market could know. The submissions
 * index's `recent` block reaches back at least a year; the older blocks
 * (`filings.files`) are read when it does not reach back far enough.
 */

import { filingMonthlyRevenue, signOf, type EventBasis, type Sign } from "./events.ts";
import { HOUR_MS, secGet } from "./http.ts";
import { cikForTicker, filingsFromSubmissions, submissions, type Filing, type Recent } from "./sec.ts";

export type PastEvent = {
  kind: EventBasis["kind"];
  accession: string;
  /** True acceptance instant on EDGAR, ISO. */
  acceptedAt: string;
  /** Which way it went: the EPS surprise (filled later from the EPS record) or the change in revenue from a year earlier. */
  sign: Sign | null;
  /** For monthly revenue: the month reported, e.g. "October 2026". */
  label?: string;
  /**
   * For monthly revenue: the Taiwan date the release went out, from its text.
   * Taiwan's afternoon is before New York's open of the same date, so the
   * market could trade on it that day even when the 6-K came later.
   */
  releasedOn?: string;
};

type OlderFile = { name: string; filingFrom?: string; filingTo?: string };

/**
 * Every filing of a company from `sinceYmd` on, newest first, with true
 * acceptance instants. Reads the older index blocks only when `recent` does
 * not reach back to `sinceYmd`.
 */
export async function filingsSince(cik: string, sinceYmd: string): Promise<Filing[]> {
  const { sub, fetchedAtMs } = await submissions(cik);
  const out = filingsFromSubmissions(sub, fetchedAtMs).filter((f) => f.filedAt >= sinceYmd);
  const dates = sub.filings.recent.filingDate ?? [];
  const oldestRecent = dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : "";
  if (oldestRecent && oldestRecent <= sinceYmd) return out;
  const files = ((sub.filings as { files?: OlderFile[] }).files ?? []).filter((f) => (f.filingTo ?? "9999") >= sinceYmd);
  for (const file of files) {
    // Older blocks change only when SEC rebuilds them; a day's cache is plenty.
    const body = await secGet(`https://data.sec.gov/submissions/${file.name}`, { maxAgeMs: 24 * HOUR_MS });
    const recent = JSON.parse(body) as Recent;
    // Each block gets its own clock reading: SEC rebuilds them separately.
    const older = filingsFromSubmissions({ ...sub, filings: { recent } }, Date.now());
    out.push(...older.filter((f) => f.filedAt >= sinceYmd && !out.some((o) => o.accession === f.accession)));
  }
  return out.sort((a, b) => (b.acceptedAt ?? b.filedAt).localeCompare(a.acceptedAt ?? a.filedAt));
}

/** The 8-K item 2.02 filings among `filings`, as events (sign unknown until the EPS record is read). Pure. */
export function earningsReleases(filings: Filing[]): PastEvent[] {
  return filings
    .filter((f) => f.form === "8-K" && f.items.includes("2.02") && f.acceptedAt)
    .map((f) => ({ kind: "earnings" as const, accession: f.accession, acceptedAt: f.acceptedAt!, sign: null }));
}

/** Taiwan monthly revenue comes out by the 10th; a 6-K later in the month is never one. Pure. */
export function mayBeMonthlyRevenue(f: Pick<Filing, "form" | "filedAt">): boolean {
  return f.form === "6-K" && Number(f.filedAt.slice(8, 10)) <= 16;
}

/**
 * The monthly revenue reports among `filings`, one per month reported (the
 * first filed that month; a report a year later that names the same month is
 * a typo in it, kept), each read from its documents (cached for good).
 */
export async function monthlyRevenueReports(filings: Filing[], log: (line: string) => void = () => undefined): Promise<PastEvent[]> {
  const out: PastEvent[] = [];
  const seen = new Set<string>();
  const candidates = filings.filter((f) => mayBeMonthlyRevenue(f) && f.acceptedAt).sort((a, b) => a.acceptedAt!.localeCompare(b.acceptedAt!));
  for (const f of candidates) {
    let found: Awaited<ReturnType<typeof filingMonthlyRevenue>>;
    try {
      found = await filingMonthlyRevenue(f);
    } catch (err) {
      log(`    ${f.accession}: unreadable (${err instanceof Error ? err.message : String(err)}), left out`);
      continue;
    }
    const key = `${found?.report.month}|${f.filedAt.slice(0, 7)}`;
    if (!found || seen.has(key)) continue;
    seen.add(key);
    // A dateline more than a week before the 6-K is a misread, not a late filing.
    const filedNy = f.acceptedAt!.slice(0, 10);
    const lagDays = found.releasedOn ? (Date.parse(`${filedNy}T12:00:00Z`) - Date.parse(`${found.releasedOn}T12:00:00Z`)) / 86_400_000 : NaN;
    const releasedOn = lagDays >= -1 && lagDays <= 7 ? found.releasedOn! : undefined;
    out.push({
      kind: "monthly_revenue",
      accession: f.accession,
      acceptedAt: f.acceptedAt!,
      sign: signOf(found.report.yoyPct),
      label: found.report.month,
      ...(releasedOn ? { releasedOn } : {}),
    });
  }
  return out.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
}

/** A company's past events of `kind` filed from `sinceYmd` on, newest first; empty for a company not on EDGAR. */
export async function edgarPastEvents(ticker: string, kind: EventBasis["kind"], sinceYmd: string, log?: (line: string) => void): Promise<PastEvent[]> {
  const cik = await cikForTicker(ticker);
  if (!cik) return [];
  const filings = await filingsSince(cik, sinceYmd);
  return kind === "earnings" ? earningsReleases(filings) : monthlyRevenueReports(filings, log);
}
