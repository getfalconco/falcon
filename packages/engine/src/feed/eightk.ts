/**
 * 8-K intake for the detectors: every 8-K accepted in a window with its item
 * codes, routed by items before any document is read.
 *
 * Accessions come from the daily form index (Atom for days without one);
 * item codes for all of them from efts in a few pages, or from each filing's
 * header page when efts is down; acceptance instants from the header page,
 * read only for the filings a detector routes in.
 */

import { parseFilingIndex, type FilingDocument } from "../sec.ts";
import { FOREVER_MS } from "../http.ts";
import { htmlToText } from "../text.ts";
import { secPoolGet } from "./sec-pool.ts";
import { addDays, eftsItems, filingsInWindow, headerOf, indexPageUrl, nyDate, type FoundFiling } from "./edgar.ts";

export type EightK = {
  accession: string;
  form: string;
  /** Filer CIK (10 digits). */
  cik: string;
  /** Co-registrants and other CIKs listed for the filing. */
  ciks: string[];
  companyName: string;
  dateFiled: string;
  items: string[];
  /** Null until resolved from the header. */
  acceptedAt: string | null;
  sic: string | null;
  indexUrl: string;
};

const listCache = new Map<string, Promise<EightK[]>>();

/**
 * Every 8-K filed on the window's days with items (acceptance not yet
 * checked). Cached per window within the process: several detectors share it.
 */
export function eightKsFiled(since: Date, until: Date, log: (l: string) => void): Promise<EightK[]> {
  const key = `${since.toISOString()}|${until.toISOString()}`;
  if (!listCache.has(key)) listCache.set(key, load(since, until, log));
  return listCache.get(key)!;
}

async function load(since: Date, until: Date, log: (l: string) => void): Promise<EightK[]> {
  const { filings, stats } = await filingsInWindow(["8-K"], since, until, log);
  const from = addDays(nyDate(since.getTime()), -1);
  const to = nyDate(until.getTime() - 1);
  const efts = filings.some((f) => f.items === null) ? await eftsItems("8-K", from, to, log) : new Map();
  let headerReads = 0;
  const out: EightK[] = [];
  for (const f of filings) {
    const e = efts?.get(f.accession);
    let items = f.items ?? e?.items ?? null;
    let acceptedAt = f.acceptedAt;
    let sic = e?.sics[0] ?? null;
    if (items === null) {
      const h = await headerOf(f.cik, f.accession).catch(() => null);
      headerReads++;
      if (!h) continue;
      items = h.items;
      acceptedAt = h.acceptedAt;
      sic = h.sic;
    }
    out.push(fromFound(f, items, acceptedAt, sic, e?.ciks));
  }
  log(`8-K intake: ${out.length} 8-Ks on ${stats.daysFromIndex + stats.daysFromAtom} days (efts ${efts ? `${efts.size} records` : "down"}, ${headerReads} header reads)`);
  return out;
}

function fromFound(f: FoundFiling, items: string[], acceptedAt: string | null, sic: string | null, eftsCiks?: string[]): EightK {
  const ciks = [...new Set([...(eftsCiks ?? []), ...f.ciks])];
  const cik = eftsCiks?.[0] ?? f.cik;
  return { accession: f.accession, form: f.form, cik, ciks, companyName: f.companyName, dateFiled: f.dateFiled, items, acceptedAt, sic, indexUrl: indexPageUrl(cik, f.accession) };
}

/** Fills in the acceptance instant (and SIC) from the header page. */
export async function resolveAcceptance(k: EightK): Promise<EightK> {
  if (k.acceptedAt) return k;
  const h = await headerOf(k.cik, k.accession);
  return { ...k, acceptedAt: h.acceptedAt, sic: k.sic ?? h.sic, companyName: h.filerName ?? k.companyName };
}

export type EightKText = { docs: Array<FilingDocument & { text: string }>; main: string; exhibits99: string };

/** The 8-K's main document and its EX-99 exhibits as plain text (archived, cached for good). */
export async function eightKText(k: Pick<EightK, "indexUrl">, opts: { exhibits?: boolean } = {}): Promise<EightKText> {
  const index = parseFilingIndex(await secPoolGet(k.indexUrl, FOREVER_MS));
  const wanted = index.filter((d) => /^8-K/.test(d.type) || (opts.exhibits !== false && /^EX-99/.test(d.type)));
  const readable = wanted.filter((d) => /\.(htm|html|txt)$/i.test(d.url));
  const docs: EightKText["docs"] = await Promise.all(readable.map(async (d) => ({ ...d, text: htmlToText(await secPoolGet(d.url, FOREVER_MS)) })));
  return {
    docs,
    main: docs.filter((d) => /^8-K/.test(d.type)).map((d) => d.text).join("\n"),
    exhibits99: docs.filter((d) => /^EX-99/.test(d.type)).map((d) => d.text).join("\n"),
  };
}
