/**
 * EDGAR filing intake for the detectors: which filings of a form were
 * accepted in a window, with their true acceptance instants.
 *
 * Sources (docs/design/ripple-engine-v1.md 3.1):
 *   - the daily form index `daily-index/{YYYY}/QTR{q}/form.{YYYYMMDD}.idx`
 *     (complete days; published in the evening; 403 on holidays and before
 *     it is published), one row per filer, so a Form 4 shows up once per
 *     reporting owner and once for the issuer: rows are deduplicated by
 *     accession;
 *   - the `getcurrent` Atom feed for days whose index is not out yet
 *     (shallow: about 1.5 business days);
 *   - the SEC header of each filing (`<ACCEPTANCE-DATETIME>`, New York wall
 *     clock) for the acceptance instant, read from the submission text or
 *     the `-index-headers.html` page;
 *   - for 8-K item codes in bulk, efts `search-index` (items per filing,
 *     100 a page), with the header page as the fallback per filing.
 *
 * Index, Atom and efts pages go through `secGet` (src/http.ts); bulk archive
 * reads (submission texts, header pages) through `secPoolGet` (sec-pool.ts:
 * several in flight, starts at 6/s). Both: declared User-Agent, the same disk
 * cache. Archived documents are cached for good; index files of past days
 * too; Atom and efts pages briefly.
 */

import { nyOffsetMs } from "../edgar-time.ts";
import { FOREVER_MS, HOUR_MS, HttpError, secGet } from "../http.ts";
import { secPoolGet } from "./sec-pool.ts";

export type IndexRow = {
  form: string;
  companyName: string;
  /** 10-digit CIK of the row's filer (issuer, reporting owner or filer). */
  cik: string;
  /** YYYY-MM-DD as the index writes it. */
  dateFiled: string;
  accession: string;
  /** Full submission text file on EDGAR. */
  txtUrl: string;
};

export const pad10 = (cik: string | number): string => String(cik).replace(/^0+/, "").padStart(10, "0");

/** EDGAR archive folder of a filing. */
export function archiveFolder(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accession.replace(/-/g, "")}`;
}

export function indexPageUrl(cik: string, accession: string): string {
  return `${archiveFolder(cik, accession)}/${accession}-index.htm`;
}

export function submissionTxtUrl(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accession}.txt`;
}

/** The daily form index URL for a New York calendar day (YYYY-MM-DD). */
export function dailyIndexUrl(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  const q = Math.floor((Number(m) - 1) / 3) + 1;
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${y}${m}${d}.idx`;
}

/**
 * Rows of a daily form index. The file is fixed-width with a header ending
 * in a dashed line; columns are read from the right (the file name and the
 * date have no spaces; the company name can). Pure.
 */
export function parseDailyIndex(body: string): IndexRow[] {
  const out: IndexRow[] = [];
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^-{20,}/.test(l));
  for (const line of lines.slice(start + 1)) {
    const m = /^(.+?)\s{2,}(.+?)\s+(\d{1,10})\s+(\d{8})\s+(edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt)\s*$/.exec(line);
    if (!m) continue;
    const date = m[4]!;
    out.push({
      form: m[1]!.trim(),
      companyName: m[2]!.trim(),
      cik: pad10(m[3]!),
      dateFiled: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      accession: m[6]!,
      txtUrl: `https://www.sec.gov/Archives/${m[5]!}`,
    });
  }
  return out;
}

export type AtomEntry = {
  form: string;
  companyName: string;
  cik: string;
  /** "Issuer", "Reporting", "Filer", "Subject", ... */
  role: string;
  accession: string;
  dateFiled: string;
  /** Acceptance instant (ISO, UTC) from `<updated>`. */
  acceptedAt: string;
  items: string[];
  indexUrl: string;
};

/** Entries of a `getcurrent` Atom page. Pure. */
export function parseAtom(xml: string): AtomEntry[] {
  const out: AtomEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    const title = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? "";
    const t = /^(.+?) - (.+) \((\d{10})\) \(([^)]+)\)\s*$/.exec(decodeXml(title).trim());
    const summary = decodeXml(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(e)?.[1] ?? "");
    const accession = /accession-number=(\d{10}-\d{2}-\d{6})/.exec(e)?.[1] ?? /AccNo:<\/b>\s*(\d{10}-\d{2}-\d{6})/.exec(summary)?.[1];
    const updated = /<updated>([^<]+)<\/updated>/.exec(e)?.[1];
    const href = /<link[^>]*href="([^"]+)"/.exec(e)?.[1] ?? "";
    if (!t || !accession || !updated) continue;
    const ms = Date.parse(updated);
    if (!Number.isFinite(ms)) continue;
    out.push({
      form: t[1]!.trim(),
      companyName: t[2]!.trim(),
      cik: t[3]!,
      role: t[4]!,
      accession,
      dateFiled: /Filed:<\/b>\s*(\d{4}-\d{2}-\d{2})/.exec(summary)?.[1] ?? "",
      acceptedAt: new Date(ms).toISOString(),
      items: [...summary.matchAll(/Item (\d{1,2}\.\d{2})/g)].map((x) => x[1]!),
      indexUrl: href,
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

export { decodeXml };

/** New York wall time "YYYYMMDDHHMMSS" (SEC header) as a UTC ISO instant. Pure. */
export function nyWallToIso(stamp: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp.trim());
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  // Two passes settle the offset on either side of a clock change.
  let utc = wall + 5 * HOUR_MS;
  for (let i = 0; i < 2; i++) utc = wall - nyOffsetMs(utc);
  return new Date(utc).toISOString();
}

export type SecHeader = {
  accession: string | null;
  form: string | null;
  acceptedAt: string | null;
  items: string[];
  /** Filer / subject company CIK (8-K, NT) when the header has one. */
  filerCik: string | null;
  filerName: string | null;
  sic: string | null;
  periodOfReport: string | null;
};

/** Item descriptions in SEC headers mapped back to their 8-K item codes. */
const ITEM_BY_TITLE: Array<[RegExp, string]> = [
  [/^Entry into a Material Definitive Agreement/i, "1.01"],
  [/^Termination of a Material Definitive Agreement/i, "1.02"],
  [/^Bankruptcy or Receivership/i, "1.03"],
  [/^Mine Safety/i, "1.04"],
  [/^Material Cybersecurity Incidents/i, "1.05"],
  [/^Completion of Acquisition or Disposition of Assets/i, "2.01"],
  [/^Results of Operations and Financial Condition/i, "2.02"],
  [/^Creation of a Direct Financial Obligation/i, "2.03"],
  [/^Triggering Events That Accelerate or Increase/i, "2.04"],
  [/^Costs Associated with Exit or Disposal Activities/i, "2.05"],
  [/^Material Impairments/i, "2.06"],
  [/^Notice of Delisting or Failure to Satisfy/i, "3.01"],
  [/^Unregistered Sales of Equity Securities/i, "3.02"],
  [/^Material Modification to Rights of Security Holders/i, "3.03"],
  [/^Changes in Registrant's Certifying Accountant/i, "4.01"],
  [/^Non-Reliance on Previously Issued Financial Statements/i, "4.02"],
  [/^Changes in Control of Registrant/i, "5.01"],
  [/^Departure of Directors or Certain Officers/i, "5.02"],
  [/^Amendments to Articles of Incorporation or Bylaws/i, "5.03"],
  [/^Temporary Suspension of Trading Under Registrant's Employee Benefit Plans/i, "5.04"],
  [/^Amendments to the Registrant's Code of Ethics/i, "5.05"],
  [/^Change in Shell Company Status/i, "5.06"],
  [/^Submission of Matters to a Vote of Security Holders/i, "5.07"],
  [/^Shareholder Director Nominations/i, "5.08"],
  [/^Regulation FD Disclosure/i, "7.01"],
  [/^Other Events/i, "8.01"],
  [/^Financial Statements and Exhibits/i, "9.01"],
];

export function itemCodeOf(title: string): string | null {
  const t = title.replace(/[’]/g, "'").trim();
  return ITEM_BY_TITLE.find(([re]) => re.test(t))?.[1] ?? null;
}

/**
 * The SEC header of a submission text or an `-index-headers.html` page:
 * accession, form, acceptance instant, items (codes), the filer or subject
 * company. Pure.
 */
export function parseSecHeader(body: string): SecHeader {
  // The index-headers page carries an SGML copy in a comment first, then the readable header (escaped).
  const raw = body.slice(0, Math.min(body.length, 200_000));
  const escaped = raw.indexOf("&lt;SEC-HEADER&gt;");
  const head = decodeXml(escaped >= 0 ? (raw.slice(escaped).split("&lt;/SEC-HEADER&gt;")[0] ?? "") : (raw.split("</SEC-HEADER>")[0] ?? ""));
  const one = (re: RegExp) => re.exec(head)?.[1]?.trim() ?? null;
  const stamp = one(/<ACCEPTANCE-DATETIME>\s*(\d{14})/);
  const items = [...head.matchAll(/ITEM INFORMATION:\s*(.+)/g)].map((m) => itemCodeOf(m[1]!)).filter((x): x is string => x !== null);
  // The company block of an 8-K or NT is FILER; a Form 4's issuer is ISSUER; a 13D's is SUBJECT COMPANY.
  const block = /(?:^|\n)(?:FILER|SUBJECT COMPANY|ISSUER):\s*\n([\s\S]*?)(?=\n[A-Z][A-Z -]+:\s*\n|$)/.exec(head)?.[1] ?? head;
  const cik = /CENTRAL INDEX KEY:\s*(\d+)/.exec(block)?.[1];
  return {
    accession: one(/ACCESSION NUMBER:\s*(\S+)/),
    form: one(/CONFORMED SUBMISSION TYPE:\s*(.+)/),
    acceptedAt: stamp ? nyWallToIso(stamp) : null,
    items: [...new Set(items)],
    filerCik: cik ? pad10(cik) : null,
    filerName: /COMPANY CONFORMED NAME:\s*(.+)/.exec(block)?.[1]?.trim() ?? null,
    sic: /STANDARD INDUSTRIAL CLASSIFICATION:.*\[(\d{4})\]/.exec(block)?.[1] ?? null,
    periodOfReport: one(/CONFORMED PERIOD OF REPORT:\s*(\d{8})/),
  };
}

/** The documents of a submission text: type, file name, description and raw body. Pure. */
export type SubmissionDocument = { type: string; filename: string; description: string; body: string };

export function parseSubmissionDocuments(txt: string): SubmissionDocument[] {
  const out: SubmissionDocument[] = [];
  for (const m of txt.matchAll(/<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/g)) {
    const d = m[1]!;
    const type = /<TYPE>([^\n<]+)/.exec(d)?.[1]?.trim() ?? "";
    const filename = /<FILENAME>([^\n<]+)/.exec(d)?.[1]?.trim() ?? "";
    const description = /<DESCRIPTION>([^\n<]+)/.exec(d)?.[1]?.trim() ?? "";
    const body = /<TEXT>([\s\S]*?)<\/TEXT>/.exec(d)?.[1] ?? "";
    out.push({ type, filename, description, body });
  }
  return out;
}

/** New York calendar date of an instant, YYYY-MM-DD. */
export function nyDate(ms: number): string {
  return new Date(ms + nyOffsetMs(ms)).toISOString().slice(0, 10);
}

export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function isWeekend(ymd: string): boolean {
  const d = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

/** New York dates from `from` to `to` inclusive, weekends skipped. */
export function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d);
  return out;
}

export type DayIndex = { ymd: string; status: "ok" | "missing"; rows: IndexRow[] };

/**
 * One day's form index. "missing" when EDGAR has none (holiday, weekend, or
 * not published yet: 403/404). A past day's index never changes, so it is
 * cached for good once read; the current day's for an hour.
 */
export async function dailyIndex(ymd: string, todayNy: string): Promise<DayIndex> {
  try {
    const maxAgeMs = ymd < todayNy ? FOREVER_MS : HOUR_MS;
    const body = await secGet(dailyIndexUrl(ymd), { maxAgeMs });
    return { ymd, status: "ok", rows: parseDailyIndex(body) };
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return { ymd, status: "missing", rows: [] };
    throw err;
  }
}

/**
 * `getcurrent` Atom entries of one form type, newest first, down to `sinceMs`
 * (or until the feed runs out: it reaches about 1.5 business days back).
 */
export async function atomEntries(form: string, sinceMs: number, maxPages = 20): Promise<AtomEntry[]> {
  const out: AtomEntry[] = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&owner=include&count=100&start=${page * 100}&output=atom`;
    const entries = parseAtom(await secGet(url, { maxAgeMs: 2 * 60_000 }));
    if (entries.length === 0) break;
    out.push(...entries);
    if (Date.parse(entries[entries.length - 1]!.acceptedAt) < sinceMs) break;
  }
  return out;
}

/** A filing found in the window, before its document is read. */
export type FoundFiling = {
  form: string;
  accession: string;
  /** CIK the filing sits under in the archive (any party works for the URLs). */
  cik: string;
  /** Every CIK the index or feed lists the filing under (issuer, owners, filer). */
  ciks: string[];
  companyName: string;
  dateFiled: string;
  /** Known up front from Atom; otherwise read from the header later. */
  acceptedAt: string | null;
  items: string[] | null;
  txtUrl: string;
};

export type IntakeStats = { days: number; daysFromIndex: number; daysFromAtom: number; missingDays: string[]; rows: number; accessions: number };

/**
 * Filings of the given forms (exact form names, e.g. ["4"] or ["NT 10-Q"])
 * filed on New York days that can hold acceptances in [since, until). A
 * filing accepted after EDGAR's 17:30 cut-off can carry the next business
 * day's date, so one weekday before `since` is included; callers filter by
 * the true acceptance instant. Days with no index yet (today, before the
 * evening publish) come from the Atom feed. Deduplicated by accession.
 */
export async function filingsInWindow(forms: string[], since: Date, until: Date, log: (l: string) => void = () => {}): Promise<{ filings: FoundFiling[]; stats: IntakeStats }> {
  const today = nyDate(Date.now());
  const from = addDays(nyDate(since.getTime()), -1);
  const to = nyDate(until.getTime() - 1);
  const want = new Set(forms);
  const byAcc = new Map<string, FoundFiling>();
  const stats: IntakeStats = { days: 0, daysFromIndex: 0, daysFromAtom: 0, missingDays: [], rows: 0, accessions: 0 };
  const atomDays: string[] = [];
  for (const ymd of weekdaysBetween(from, to)) {
    stats.days++;
    const day = await dailyIndex(ymd, today);
    if (day.status === "missing") {
      // Recent days without an index are read from the live feed; older ones are holidays.
      if (ymd >= addDays(today, -2)) atomDays.push(ymd);
      else stats.missingDays.push(ymd);
      continue;
    }
    stats.daysFromIndex++;
    for (const r of day.rows) {
      if (!want.has(r.form)) continue;
      stats.rows++;
      const known = byAcc.get(r.accession);
      if (known) {
        if (!known.ciks.includes(r.cik)) known.ciks.push(r.cik);
        continue;
      }
      byAcc.set(r.accession, { form: r.form, accession: r.accession, cik: r.cik, ciks: [r.cik], companyName: r.companyName, dateFiled: r.dateFiled, acceptedAt: null, items: null, txtUrl: r.txtUrl });
    }
  }
  if (atomDays.length) {
    const sinceMs = Date.parse(`${atomDays[0]}T00:00:00Z`);
    for (const form of forms) {
      const entries = await atomEntries(form, sinceMs);
      for (const e of entries) {
        if (e.form !== form || !atomDays.includes(e.dateFiled)) continue;
        stats.rows++;
        const known = byAcc.get(e.accession);
        if (known) {
          if (!known.ciks.includes(e.cik)) known.ciks.push(e.cik);
          continue;
        }
        byAcc.set(e.accession, {
          form: e.form,
          accession: e.accession,
          cik: e.cik,
          ciks: [e.cik],
          companyName: e.companyName,
          dateFiled: e.dateFiled,
          acceptedAt: e.acceptedAt,
          items: e.items,
          txtUrl: submissionTxtUrl(e.cik, e.accession),
        });
      }
    }
    stats.daysFromAtom = atomDays.length;
    // Days the feed did not reach (an index that never came and an Atom that ran out) are logged.
    log(`intake: ${atomDays.join(", ")} read from the getcurrent feed (no daily index yet)`);
  }
  stats.accessions = byAcc.size;
  return { filings: [...byAcc.values()], stats };
}

/** The full submission text of a filing (archived, cached for good). */
export function submissionText(f: Pick<FoundFiling, "txtUrl">): Promise<string> {
  return secPoolGet(f.txtUrl, FOREVER_MS);
}

/** The SEC header page of a filing: acceptance time and items without the documents. */
export async function headerOf(cik: string, accession: string): Promise<SecHeader> {
  const url = `${archiveFolder(cik, accession)}/${accession}-index-headers.html`;
  return parseSecHeader(await secPoolGet(url, FOREVER_MS));
}

export type EftsFiling = { accession: string; form: string; ciks: string[]; items: string[]; fileDate: string; sics: string[]; names: string[] };

/** Filings of an efts `search-index` answer, one per accession. Pure. */
export function parseEfts(json: unknown): { total: number; filings: EftsFiling[] } {
  const hits = (json as { hits?: { total?: { value?: number }; hits?: Array<{ _source?: Record<string, unknown> }> } })?.hits;
  const out = new Map<string, EftsFiling>();
  for (const h of hits?.hits ?? []) {
    const s = h._source ?? {};
    const adsh = typeof s.adsh === "string" ? s.adsh : null;
    if (!adsh || out.has(adsh)) continue;
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    out.set(adsh, {
      accession: adsh,
      form: typeof s.form === "string" ? s.form : typeof s.file_type === "string" ? s.file_type : "",
      ciks: arr(s.ciks).map(pad10),
      items: arr(s.items),
      fileDate: typeof s.file_date === "string" ? s.file_date : "",
      sics: arr(s.sics),
      names: arr(s.display_names),
    });
  }
  return { total: hits?.total?.value ?? 0, filings: [...out.values()] };
}

/**
 * 8-K item codes for every 8-K filed on [fromYmd, toYmd], from efts in pages
 * of 100. Returns null when efts cannot be read (callers fall back to each
 * filing's header page).
 */
export async function eftsItems(form: string, fromYmd: string, toYmd: string, log: (l: string) => void = () => {}): Promise<Map<string, EftsFiling> | null> {
  const out = new Map<string, EftsFiling>();
  try {
    for (let from = 0; from < 10_000; from += 100) {
      const url = `https://efts.sec.gov/LATEST/search-index?forms=${encodeURIComponent(form)}&startdt=${fromYmd}&enddt=${toYmd}&from=${from}`;
      const { total, filings } = parseEfts(JSON.parse(await secGet(url, { maxAgeMs: HOUR_MS })));
      for (const f of filings) if (!out.has(f.accession)) out.set(f.accession, f);
      if (from + 100 >= total || filings.length === 0) break;
    }
    return out;
  } catch (err) {
    log(`efts unavailable (${(err as Error).message.split("\n")[0]}); reading 8-K items from each header`);
    return null;
  }
}
