/**
 * `filings(ticker, form?, query?)`: a company's SEC filings, newest first
 * (its EDGAR submissions index), or, with a query, EDGAR full-text search
 * over its filings since 2001. `filing_text(url, query?)`: a bounded excerpt
 * of one archived document, around the query's best matches, so the model
 * can quote it.
 */

import { archiveBase, companyForTicker, documentText, fullTextSearch, secText, submissions, type FtsHit } from "./sec";
import { ToolError, addDays, displayName, nyParts, type DeskToolContext } from "./util";

export const FORM_FILTERS = ["8-K", "10-K", "10-Q", "4", "SC 13D", "SC 13G", "DEF 14A", "S-1", "S-3", "6-K", "20-F", "144", "any"] as const;
export type FormFilter = (typeof FORM_FILTERS)[number];

/** The EDGAR form types each filter matches (amendments included). */
const FORMS: Record<Exclude<FormFilter, "any">, string[]> = {
  "8-K": ["8-K", "8-K/A"],
  "10-K": ["10-K", "10-K/A", "10-KT"],
  "10-Q": ["10-Q", "10-Q/A"],
  "4": ["4", "4/A"],
  "SC 13D": ["SC 13D", "SC 13D/A", "SCHEDULE 13D", "SCHEDULE 13D/A"],
  "SC 13G": ["SC 13G", "SC 13G/A", "SCHEDULE 13G", "SCHEDULE 13G/A"],
  "DEF 14A": ["DEF 14A", "DEFA14A", "PRE 14A"],
  "S-1": ["S-1", "S-1/A"],
  "S-3": ["S-3", "S-3/A", "S-3ASR"],
  "6-K": ["6-K", "6-K/A"],
  "20-F": ["20-F", "20-F/A"],
  "144": ["144", "144/A"],
};

/** Without a form filter: these are left out (insider and routine paperwork; ask for "4" or "144" to see them). */
const NOISE = /^(4|4\/A|3|3\/A|5|5\/A|144|144\/A|424B\d|FWP|13F-HR|13F-NT|N-PX|UPLOAD|CORRESP|EFFECT|SD|CERT\w*|25-NSE|IRANNOTICE)$/;

export const ITEMS_8K: Record<string, string> = {
  "1.01": "Entry into a material definitive agreement",
  "1.02": "Termination of a material definitive agreement",
  "1.03": "Bankruptcy or receivership",
  "1.05": "Material cybersecurity incident",
  "2.01": "Completion of acquisition or disposition of assets",
  "2.02": "Results of operations and financial condition",
  "2.03": "Creation of a direct financial obligation",
  "2.04": "Triggering events that accelerate an obligation",
  "2.05": "Exit or disposal costs",
  "2.06": "Material impairments",
  "3.01": "Delisting or listing-rule notice",
  "3.02": "Unregistered sales of equity securities",
  "3.03": "Material modification of security holders' rights",
  "4.01": "Change in certifying accountant",
  "4.02": "Non-reliance on previous financial statements",
  "5.01": "Change in control",
  "5.02": "Departure or appointment of directors or officers; compensation",
  "5.03": "Amendments to articles or bylaws; fiscal year change",
  "5.05": "Code of ethics change or waiver",
  "5.07": "Shareholder vote results",
  "5.08": "Shareholder director nominations",
  "7.01": "Regulation FD disclosure",
  "8.01": "Other events",
  "9.01": "Financial statements and exhibits",
};

export const DEFAULT_LIMIT = 15;
/** Full-text search window when `days` is not given. */
export const FTS_DEFAULT_DAYS = 3 * 365;
export const MAX_LIMIT = 25;

const itemList = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((code) => (ITEMS_8K[code] ? `${code} ${ITEMS_8K[code]}` : code));

export type FilingsInput = { form?: FormFilter; query?: string; days?: number; limit?: number };

export async function filingsTool(symbol: string, input: FilingsInput, ctx: DeskToolContext, signal: AbortSignal) {
  const company = await companyForTicker(symbol, signal);
  if (!company) throw new ToolError(`${symbol} is not in SEC's list of registrants, so it has no EDGAR filings under that ticker.`);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(input.limit ?? DEFAULT_LIMIT)));
  const forms = input.form && input.form !== "any" ? FORMS[input.form] : null;
  const today = nyParts(ctx.now?.() ?? Date.now()).date;
  const since = input.days ? addDays(today, -Math.round(input.days)) : null;
  const name = displayName(company.name);

  if (input.query?.trim()) {
    const q = input.query.trim().slice(0, 200);
    const from = since ?? addDays(today, -FTS_DEFAULT_DAYS);
    const res = await fullTextSearch({ q, ciks: [company.cik], forms: forms ?? undefined, startdt: from, enddt: today }, signal);
    // EDGAR ranks by relevance; the newest matches are what a reader usually wants.
    const newest = [...res.hits].sort((a, b) => ((a._source.file_date ?? "") < (b._source.file_date ?? "") ? 1 : -1));
    const rows = newest.slice(0, limit).map((h: FtsHit) => {
      const [adsh, file] = h._id.split(":");
      const s = h._source;
      return {
        date: s.file_date ?? null,
        form: s.form ?? s.file_type ?? null,
        ...(s.period_ending ? { period: s.period_ending } : {}),
        ...(s.items?.length ? { items: s.items.map((c) => (ITEMS_8K[c] ? `${c} ${ITEMS_8K[c]}` : c)) } : {}),
        title: s.file_description || s.file_type || null,
        url: adsh && file ? `${archiveBase(company.cik, adsh)}/${file}` : null,
        accession: adsh ?? null,
      };
    });
    return {
      ticker: symbol,
      company: name,
      cik: company.cik,
      mode: "full-text search",
      query: q,
      window: { from, to: today },
      totalMatches: res.total,
      filings: rows,
      notes: [
        `Newest first among EDGAR's ${Math.min(res.hits.length, 100)} most relevant matches filed ${from} to ${today}${since ? "" : " (default window; pass days for another, up to 3650)"}. Read one with filing_text(url, query).`,
        'Use double quotes inside the query for an exact phrase, e.g. "supply agreement".',
      ],
      source: "SEC EDGAR full-text search",
    };
  }

  const sub = await submissions(company.cik, signal);
  const r = sub.filings.recent;
  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (let i = 0; i < r.form.length && rows.length < limit; i++) {
    const form = r.form[i]!;
    const date = r.filingDate[i]!;
    if (since && date < since) break;
    if (forms ? !forms.includes(form) : NOISE.test(form)) {
      if (!forms) skipped++;
      continue;
    }
    const acc = r.accessionNumber[i]!;
    const doc = r.primaryDocument?.[i] ?? "";
    const base = archiveBase(company.cik, acc);
    const items = itemList(r.items?.[i]);
    rows.push({
      date,
      form,
      ...(r.reportDate?.[i] ? { period: r.reportDate[i] } : {}),
      ...(items.length ? { items } : {}),
      title: r.primaryDocDescription?.[i] || form,
      // Form 4 and 13D/G primary documents are XSL views; the raw XML sits beside them.
      url: doc ? `${base}/${doc.replace(/^xsl[^/]+\//, "")}` : `${base}/${acc}-index.htm`,
      indexUrl: `${base}/${acc}-index.htm`,
    });
  }
  const oldest = r.filingDate.at(-1);
  return {
    ticker: symbol,
    company: name,
    cik: company.cik,
    mode: "recent filings",
    filter: input.form ?? "material (Forms 3/4/5, 144, prospectus supplements and routine paperwork left out)",
    filings: rows,
    notes: [
      ...(rows.length === 0 ? [`No matching filings${since ? ` since ${since}` : ""} in the last ${r.form.length} filings (back to ${oldest}).`] : []),
      ...(!forms && skipped ? [`${skipped} insider or routine filings skipped; ask for form "4" or "144" to list them.`] : []),
      "Dates are EDGAR filing dates. Read one with filing_text(url, query).",
    ],
    source: "SEC EDGAR submissions index",
  };
}

/* ------------------------------------------------------------------ filing_text */

export const EXCERPT_CHARS = 6_000;
const MAX_EXCERPT_CHARS = 9_000;

const ARCHIVE = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[\w.\-]+$/;

/** The documents of a filing's -index.htm page (engine sec.ts parseFilingIndex). Pure. */
export function parseFilingIndex(html: string): { type: string; description: string; url: string }[] {
  const out: { type: string; description: string; url: string }[] = [];
  const table = /<table[^>]*class="tableFile"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1] ?? "";
  for (const row of table.split(/<tr[^>]*>/i).slice(1)) {
    const cells = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => m[1] ?? "");
    if (cells.length < 4) continue;
    const href = /href="([^"]+)"/i.exec(cells[2] ?? "")?.[1];
    if (!href) continue;
    const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    out.push({ description: strip(cells[1] ?? ""), type: strip(cells[3] ?? ""), url: new URL(href.replace(/^\/ix\?doc=/, ""), "https://www.sec.gov").toString() });
  }
  return out;
}

/** A document's filing index page: .../{cik}/{18 digits}/{10-2-6 accession}-index.htm. Pure. */
export function filingIndexUrl(documentUrl: string): string | null {
  const m = /^(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/(\d{10})(\d{2})(\d{6}))\//.exec(documentUrl);
  return m ? `${m[1]}/${m[2]}-${m[3]}-${m[4]}-index.htm` : null;
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "its", "our", "their", "what", "how", "about", "any", "has", "have", "into"]);

/**
 * Up to `max` characters of `text` around the paragraphs that best match
 * `query` (word hits, an exact phrase counts extra), each with a paragraph
 * of context before and after, in document order. Without a query (or no
 * match): the start of the document. Pure.
 */
export function excerpt(text: string, query: string | undefined, max = EXCERPT_CHARS): { excerpts: string[]; matched: boolean } {
  const paras = text.split("\n");
  const terms = (query ?? "")
    .toLowerCase()
    .replace(/["']/g, " ")
    .split(/[^a-z0-9.%$-]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const phrase = (query ?? "").toLowerCase().replace(/["']/g, "").trim();
  const scored: { i: number; score: number }[] = [];
  if (terms.length) {
    paras.forEach((p, i) => {
      const low = p.toLowerCase();
      let score = 0;
      for (const t of Array.from(new Set(terms))) if (low.includes(t)) score += 1;
      if (phrase.length >= 6 && low.includes(phrase)) score += terms.length + 2;
      // A table-of-contents line matches words without saying anything.
      if (score > 0 && p.length < 60 && /\|\s*\d+\s*\|?$/.test(p)) score -= 1;
      if (score > 0) scored.push({ i, score: score + Math.min(1, p.length / 800) });
    });
  }
  if (!scored.length) {
    let out = "";
    for (const p of paras) {
      if (out.length + p.length + 1 > max) {
        if (!out) out = p.slice(0, max);
        break;
      }
      out += (out ? "\n" : "") + p;
    }
    return { excerpts: [out], matched: false };
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen = new Set<number>();
  let used = 0;
  for (const { i } of scored) {
    const window = [i - 1, i, i + 1].filter((j) => j >= 0 && j < paras.length && !chosen.has(j));
    const add = window.reduce((t, j) => t + paras[j]!.length + 1, 0);
    if (used + add > max) {
      if (used === 0) {
        chosen.add(i);
        used += Math.min(paras[i]!.length, max);
      }
      continue;
    }
    for (const j of window) chosen.add(j);
    used += add;
    if (used > max * 0.9) break;
  }
  const order = Array.from(chosen).sort((a, b) => a - b);
  const excerpts: string[] = [];
  let cur: string[] = [];
  let last = -2;
  for (const j of order) {
    if (j !== last + 1 && cur.length) {
      excerpts.push(cur.join("\n"));
      cur = [];
    }
    cur.push(paras[j]!.length > max ? `${paras[j]!.slice(0, max)} [cut]` : paras[j]!);
    last = j;
  }
  if (cur.length) excerpts.push(cur.join("\n"));
  return { excerpts, matched: true };
}

/** Section headings ("Item 1A. Risk Factors") found in a document, for a follow-up query. Pure. */
export function headings(text: string, max = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(item\s+\d{1,2}[a-z]?\.?)\s*[|:.-]?\s*([^|]{3,90})/i.exec(line.trim());
    if (!m) continue;
    const h = `${m[1]!.replace(/\s+/g, " ")} ${m[2]!.trim()}`.replace(/\s*\|.*$/, "").trim();
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

export async function filingTextTool(input: { url: string; query?: string; maxChars?: number }, _ctx: DeskToolContext, signal: AbortSignal) {
  let url = String(input.url ?? "").trim().replace(/^http:/, "https:").replace("https://sec.gov/", "https://www.sec.gov/").replace(/#.*$/, "");
  url = url.replace(/^https:\/\/www\.sec\.gov\/ix\?doc=\//, "https://www.sec.gov/");
  if (!ARCHIVE.test(url)) throw new ToolError("url must be an SEC archive document (https://www.sec.gov/Archives/edgar/data/...), as returned by the filings tool.");
  let documentUrl = url;
  if (/-index\.html?$/.test(url)) {
    const docs = parseFilingIndex(await secText(url, signal, "text/html"));
    const primary = docs.find((d) => /\.(htm|html|txt|xml)$/i.test(d.url));
    if (!primary) throw new ToolError("That filing index lists no readable document.");
    documentUrl = primary.url;
  }
  // The filing's other documents (an 8-K's press release is exhibit 99.1), read alongside.
  const indexUrl = filingIndexUrl(documentUrl);
  const [text, others] = await Promise.all([
    documentText(documentUrl, signal),
    indexUrl && indexUrl !== url ? secText(indexUrl, signal, "text/html").then(parseFilingIndex, () => []) : Promise.resolve([]),
  ]);
  if (!text.trim()) throw new ToolError("That document has no readable text (it may be an image or a PDF).");
  const max = Math.min(MAX_EXCERPT_CHARS, Math.max(1_000, Math.round(input.maxChars ?? EXCERPT_CHARS)));
  const q = input.query?.trim().slice(0, 200);
  const { excerpts, matched } = excerpt(text, q, max);
  const hs = headings(text);
  const otherDocs = others
    .filter((d) => d.url !== documentUrl && /\.(htm|html|txt|xml|pdf)$/i.test(d.url) && !/^(EX-101|GRAPHIC|ZIP|XML)/i.test(d.type) && !/R\d+\.htm$/i.test(d.url) && !/complete submission/i.test(d.description))
    .slice(0, 8)
    .map((d) => ({ type: d.type, description: d.description, url: d.url }));
  return {
    url: documentUrl,
    documentChars: text.length,
    ...(q ? { query: q, matched } : {}),
    excerpts,
    ...(hs.length && (!q || !matched) ? { sections: hs } : {}),
    ...(otherDocs.length && (!matched || text.length < 15_000) ? { otherDocuments: otherDocs } : {}),
    notes: [
      q && !matched ? "No paragraph matched the query; this is the start of the document. Try other words or a section name below." : null,
      !q ? "Start of the document. Pass query (e.g. a section name or topic) for the relevant passage." : null,
      otherDocs.length && (!matched || text.length < 15_000) ? "otherDocuments: the filing's exhibits (an 8-K's press release is usually EX-99.1); read one with filing_text." : null,
      "Quote only text that appears in excerpts; tables read as cells joined by |.",
    ].filter(Boolean),
    source: "SEC EDGAR archive",
  };
}
