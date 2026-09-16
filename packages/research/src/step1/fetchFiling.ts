import { getConfig } from "../config.js";
import { applyCompetSanity, fractionAllCapsLines, isTocLikeSection } from "./sectionSanity.js";
import type { AnnualFilingForm, EvidenceLocatedAt } from "./types.js";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const ANNUAL_FORMS = new Set<AnnualFilingForm>(["10-K", "20-F"]);
const MIN_BODY = 15_000;
const MIN_10K_SPAN = 40_000;
const MIN_10K_SECTION_CHARS = 60_000;
/** Cap when extending a short 10-K cut to the next end anchors. */
const MAX_10K_SHORT_EXTEND = 250_000;
const MIN_CONTENT_AFTER_START = 30_000;
const TAIL_REJECT_FRACTION = 0.3;
const WINDOW_MIN_FRACTION = 0.05;
const WINDOW_MAX_FRACTION = 0.7;
const MAX_SECTION_LENGTH = 150_000;

const ITEM1_BUSINESS_RE = /item\s*1\s*[.:\-–—]?\s*business/gi;
const FLS_RE = /note\s+about\s+forward[- ]looking\s+statements/gi;

const END_ANCHOR_RES = [
  /item\s*2\s*[.:\-–—]?\s*propert/gi,
  /item\s*1b\s*[.:\-–—]?\s*unresolved/gi,
  /unresolved\s+staff\s+comments/gi,
  /item\s*3\s*[.:\-–—]?\s*legal/gi,
  /\bpart\s*ii\b/gi,
];

function documentTailThreshold(text: string): number {
  return Math.floor(text.length * (1 - TAIL_REJECT_FRACTION));
}

function collectEndCandidates(text: string, start: number): number[] {
  const minEnd = start + MIN_BODY;
  const set = new Set<number>();
  for (const endRe of END_ANCHOR_RES) {
    for (const idx of findAllMatches(text, endRe)) {
      if (idx >= minEnd) set.add(idx);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** 10-K end: skip anchors in final 30% or any anchor yielding span < 40k. */
function findEndAfterStart10K(text: string, start: number): number | null {
  const tail = documentTailThreshold(text);
  for (const end of collectEndCandidates(text, start)) {
    const span = end - start;
    if (span < MIN_10K_SPAN) continue;
    if (end >= tail && span < MIN_10K_SPAN) continue;
    return end;
  }
  return null;
}

/**
 * When the first end anchor yields a short section (<60k), walk later end anchors
 * (still before the final 30% tail) up to 250k until length >= 60k.
 * Only applies to the short-section case — leaves long cuts unchanged.
 */
export function extendShort10KEnd(text: string, start: number, end: number): number {
  const span = end - start;
  if (span >= MIN_10K_SECTION_CHARS) return end;

  const tail = documentTailThreshold(text);
  const maxEnd = Math.min(start + MAX_10K_SHORT_EXTEND, tail, text.length);
  const later = collectEndCandidates(text, start).filter((e) => e > end && e <= maxEnd);

  let current = end;
  for (const candidate of later) {
    current = candidate;
    if (current - start >= MIN_10K_SECTION_CHARS) break;
  }

  if (current !== end) {
    console.info(
      `[step1] short 10-K section ${span} chars → extended to ${current - start} chars ` +
        `(next end anchors, cap ${MAX_10K_SHORT_EXTEND})`,
    );
  } else if (span < MIN_10K_SECTION_CHARS) {
    console.warn(
      `[step1] short 10-K section ${span} chars; no further end anchors before tail/cap`,
    );
  }
  return current;
}

function findEndAfterStart(text: string, start: number): number | null {
  return findEndAfterStart10K(text, start);
}

function slice10KSection(
  fullText: string,
  start: number,
  end: number,
  sectionMethod: SectionMethod,
): SectionExtractResult {
  const extendedEnd = extendShort10KEnd(fullText, start, end);
  const { text, end: adjustedEnd, contentSuspect } = applyCompetSanity(
    fullText,
    start,
    extendedEnd,
  );
  void adjustedEnd;
  return { text, sectionMethod, contentSuspect };
}

function isItem1CrossReference(text: string, matchIndex: number): boolean {
  const snippet = text.slice(matchIndex, matchIndex + 100);
  return /item\s*1\s*[.:\-–—]?\s*business\s*[—\-–]/i.test(snippet);
}

function filterItem1Matches(text: string, item1Matches: number[]): number[] {
  return item1Matches.filter((m) => !isItem1CrossReference(text, m));
}

function pickLastStartWithEnd(
  text: string,
  starts: number[],
  findEnd: (text: string, start: number) => number | null = findEndAfterStart,
): number | null {
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i]!;
    if (findEnd(text, start) !== null) return start;
  }
  return null;
}

function pickWindowedStart(text: string, item1Matches: number[]): number | null {
  const minPos = Math.floor(text.length * WINDOW_MIN_FRACTION);
  const maxPos = Math.floor(text.length * WINDOW_MAX_FRACTION);
  for (const start of item1Matches) {
    if (start < minPos || start > maxPos) continue;
    if (text.length - start < MIN_CONTENT_AFTER_START) continue;
    return start;
  }
  return null;
}

function endForWindowed(text: string, start: number): number {
  const endAnchor = findEndAfterStart10K(text, start);
  const cap = start + MAX_SECTION_LENGTH;
  if (endAnchor !== null) return Math.min(cap, endAnchor, text.length);
  return Math.min(cap, text.length);
}

export type SectionExtractResult = {
  text: string;
  sectionMethod: SectionMethod;
  contentSuspect: boolean;
};

export type SecTickerEntry = { cik_str: number; ticker: string; title: string };

let tickersCache: SecTickerEntry[] | null = null;

async function secFetch(url: string, accept = "application/json"): Promise<Response> {
  const config = getConfig();
  return fetch(url, {
    headers: {
      "User-Agent": config.secUserAgent,
      Accept: accept,
    },
  });
}

export async function loadCompanyTickers(): Promise<SecTickerEntry[]> {
  if (tickersCache) return tickersCache;
  const res = await secFetch(TICKERS_URL);
  if (!res.ok) {
    throw new Error(`Failed to load company_tickers.json: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Record<string, SecTickerEntry>;
  tickersCache = Object.values(data);
  return tickersCache;
}

export async function resolveTickerToCik(
  ticker: string,
): Promise<{ cik10: string; cikNoPad: string; companyName: string; ticker: string }> {
  const entries = await loadCompanyTickers();
  const upper = ticker.trim().toUpperCase();
  const entry = entries.find((e) => e.ticker.toUpperCase() === upper);
  if (!entry) {
    throw new Error(`Ticker not found in SEC company_tickers.json: ${ticker}`);
  }
  const cik10 = String(entry.cik_str).padStart(10, "0");
  return {
    cik10,
    cikNoPad: String(entry.cik_str),
    companyName: entry.title,
    ticker: entry.ticker.toUpperCase(),
  };
}

function decodeBasicEntities(html: string): string {
  return html
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
}

/** Remove inline XBRL blocks before generic tag stripping. */
export function stripInlineXbrl(html: string): string {
  return html
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<ix:hidden[\s\S]*?<\/ix:hidden>/gi, " ");
}

export function htmlToPlainText(html: string): string {
  let text = stripInlineXbrl(html);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeBasicEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export type SectionMethod =
  | "item_span_last"
  | "anchor_windowed"
  | "anchor_fls"
  | "anchor_no_end"
  | "item4_span_20f"
  | "fallback_60pct";

function findAllMatches(text: string, re: RegExp): number[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const regex = new RegExp(re.source, flags);
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    indices.push(m.index);
  }
  return indices;
}

function findEndItem6AfterStart(text: string, start: number): number | null {
  const minEnd = start + MIN_BODY;
  for (const end of findAllMatches(text, /item\s*6\s*[.:\-–—]?\s*directors/gi)) {
    if (end >= minEnd) return end;
  }
  return null;
}

function endForWindowed20F(text: string, start: number): number {
  const endAnchor = findEndItem6AfterStart(text, start);
  const cap = start + MAX_SECTION_LENGTH;
  if (endAnchor !== null) return Math.min(cap, endAnchor, text.length);
  return Math.min(cap, text.length);
}

/**
 * 10-K Item 1 (Business) through end anchors — windowed start selection avoids exhibit tails.
 */
export function extractItem1ThroughItem2(text: string): SectionExtractResult {
  const item1Matches = filterItem1Matches(text, findAllMatches(text, ITEM1_BUSINESS_RE));
  const tailThreshold = documentTailThreshold(text);
  const survivors = item1Matches.filter((m) => m < tailThreshold);

  const lastWithEnd = pickLastStartWithEnd(text, survivors);
  if (lastWithEnd !== null) {
    const end = findEndAfterStart10K(text, lastWithEnd)!;
    return slice10KSection(text, lastWithEnd, end, "item_span_last");
  }

  const windowedStart = pickWindowedStart(text, item1Matches);
  if (windowedStart !== null) {
    const end = endForWindowed(text, windowedStart);
    return slice10KSection(text, windowedStart, end, "anchor_windowed");
  }

  const flsMatches = findAllMatches(text, FLS_RE);
  if (flsMatches.length > 0) {
    const start = flsMatches[0]!;
    const end = findEndAfterStart10K(text, start);
    if (end !== null) {
      return slice10KSection(text, start, end, "anchor_fls");
    }
    const endCap = Math.min(start + MAX_SECTION_LENGTH, text.length);
    return slice10KSection(text, start, endCap, "anchor_fls");
  }

  console.warn("[step1] 10-K section start not found; using first 60% of document");
  const cutoff = Math.floor(text.length * 0.6);
  return slice10KSection(text, 0, cutoff, "fallback_60pct");
}

/**
 * Cut 20-F Item 3 (Key Information) through Item 5, ending before Item 6 (Directors).
 */
export function extractItem3Through5For20F(text: string): SectionExtractResult {
  const item3Matches = findAllMatches(
    text,
    /item\s*3\s*[.:\-–—]?\s*key\s+information/gi,
  );
  const tailThreshold = documentTailThreshold(text);
  const survivors = item3Matches.filter((m) => m < tailThreshold);

  const lastWithEnd = pickLastStartWithEnd(text, survivors, findEndItem6AfterStart);
  if (lastWithEnd !== null) {
    const end = findEndItem6AfterStart(text, lastWithEnd)!;
    const sliced = applyCompetSanity(text, lastWithEnd, end);
    return { text: sliced.text, sectionMethod: "item_span_last", contentSuspect: sliced.contentSuspect };
  }

  const windowedStart = pickWindowedStart(text, item3Matches);
  if (windowedStart !== null) {
    const end = endForWindowed20F(text, windowedStart);
    const sliced = applyCompetSanity(text, windowedStart, end);
    return { text: sliced.text, sectionMethod: "anchor_windowed", contentSuspect: sliced.contentSuspect };
  }

  console.warn("[step1] 20-F Item 3–6 span not found; using first 60% of document");
  const cutoff = Math.floor(text.length * 0.6);
  return { text: text.slice(0, cutoff).trim(), sectionMethod: "fallback_60pct", contentSuspect: false };
}

/**
 * 20-F fallback when Item 3–5 span is exhibit-heavy: Item 4 (Company info) through Item 8/10.
 */
export function extractItem4Through8For20F(text: string): SectionExtractResult {
  const starts = findAllMatches(
    text,
    /item\s*4\s*[.:\-–—]?\s*information\s+on\s+the\s+company/gi,
  );
  if (starts.length === 0) {
    console.warn("[step1] 20-F Item 4 start not found for retry");
    return extractItem3Through5For20F(text);
  }

  const start = starts[0]!;
  const minEnd = start + MIN_BODY;
  const endCandidates = findAllMatches(text, /item\s*(?:8|10)\b/gi).filter((e) => e >= minEnd);
  if (endCandidates.length > 0) {
    const end = Math.min(...endCandidates);
    const sliced = applyCompetSanity(text, start, end);
    return {
      text: sliced.text,
      sectionMethod: "item4_span_20f",
      contentSuspect: sliced.contentSuspect,
    };
  }

  const endCap = Math.min(start + MAX_SECTION_LENGTH, text.length);
  const sliced = applyCompetSanity(text, start, endCap);
  return {
    text: sliced.text,
    sectionMethod: "item4_span_20f",
    contentSuspect: sliced.contentSuspect,
  };
}

export function extractFilingSection(text: string, form: AnnualFilingForm): SectionExtractResult {
  if (form === "20-F") {
    const primary = extractItem3Through5For20F(text);
    if (isTocLikeSection(primary.text) || fractionAllCapsLines(primary.text) > 0.3) {
      const alt = extractItem4Through8For20F(text);
      if (alt.sectionMethod === "item4_span_20f" && alt.text.length >= MIN_BODY) {
        return alt;
      }
    }
    return primary;
  }
  return extractItem1ThroughItem2(text);
}

export function locatedAtForForm(
  form: AnnualFilingForm,
  sectionMethod?: SectionMethod,
): EvidenceLocatedAt {
  if (form === "20-F") {
    return sectionMethod === "item4_span_20f" ? "20-F Item 4-8" : "20-F Item 3-5";
  }
  return "10-K Item 1/1A";
}

export type FilingMetadata = {
  ticker: string;
  companyName: string;
  cik10: string;
  cikNoPad: string;
  form: AnnualFilingForm;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
  sourceUrl: string;
};

export type FilingBundle = FilingMetadata & {
  plainText: string;
  itemSpan: string;
  sectionMethod: SectionMethod;
  contentSuspect: boolean;
};

type FilingsArrays = {
  form?: string[];
  filingDate?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
};

type AnnualFilingHit = {
  form: AnnualFilingForm;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
};

type SubmissionsPayload = {
  name?: string;
  tickers?: string[];
  filings?: {
    recent?: FilingsArrays;
    files?: Array<{ name?: string; filingFrom?: string; filingTo?: string }>;
  };
};

function cikNoPadFromCik10(cik10: string): string {
  return String(Number.parseInt(cik10, 10));
}

/** Latest exact 10-K / 20-F in a filings arrays block (not 10-K/A). */
export function findLatestAnnualInFilings(block: FilingsArrays | undefined | null): AnnualFilingHit | null {
  if (!block?.form?.length) return null;
  let best: AnnualFilingHit | null = null;
  for (let i = 0; i < block.form.length; i++) {
    const form = block.form[i];
    if (!form || !ANNUAL_FORMS.has(form as AnnualFilingForm)) continue;
    const filingDate = block.filingDate?.[i] ?? "";
    const accessionNumber = block.accessionNumber?.[i];
    const primaryDocument = block.primaryDocument?.[i];
    if (!accessionNumber || !primaryDocument) continue;
    if (!best || filingDate > best.filingDate) {
      best = {
        form: form as AnnualFilingForm,
        filingDate,
        accessionNumber,
        primaryDocument,
      };
    }
  }
  return best;
}

async function fetchSubmissions(cik10: string): Promise<SubmissionsPayload> {
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cik10}.json`;
  const res = await secFetch(submissionsUrl);
  if (!res.ok) {
    throw new Error(`SEC submissions failed: HTTP ${res.status} (${submissionsUrl})`);
  }
  return (await res.json()) as SubmissionsPayload;
}

/**
 * Search filings.recent, then paginated filings.files archives, for the latest 10-K/20-F.
 */
export async function findLatestAnnualForCik(cik10: string): Promise<AnnualFilingHit | null> {
  const data = await fetchSubmissions(cik10);
  let best = findLatestAnnualInFilings(data.filings?.recent);

  const files = data.filings?.files ?? [];
  for (const file of files) {
    const name = file.name?.trim();
    if (!name) continue;
    const pageUrl = `https://data.sec.gov/submissions/${name}`;
    const pageRes = await secFetch(pageUrl);
    if (!pageRes.ok) {
      console.warn(`[step1] submissions archive page failed: HTTP ${pageRes.status} ${pageUrl}`);
      continue;
    }
    const page = (await pageRes.json()) as FilingsArrays;
    const hit = findLatestAnnualInFilings(page);
    if (hit && (!best || hit.filingDate > best.filingDate)) {
      best = hit;
    }
  }

  return best;
}

/**
 * When company_tickers.json maps a ticker to a shell/holding CIK with no annual report,
 * EDGAR company browse for form 10-K/20-F returns the operating filer (e.g. XOM → 0000034088).
 */
export async function resolveAnnualFilerViaEdgarBrowse(
  ticker: string,
): Promise<{ cik10: string; companyName: string } | null> {
  const upper = ticker.trim().toUpperCase();
  for (const form of ["10-K", "20-F"] as const) {
    const url =
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany` +
      `&CIK=${encodeURIComponent(upper)}&type=${form}&dateb=&owner=include&count=5&output=atom`;
    const res = await secFetch(url, "application/atom+xml, application/xml, text/xml, */*");
    if (!res.ok) {
      console.warn(`[step1] EDGAR browse ${form} for ${upper}: HTTP ${res.status}`);
      continue;
    }
    const xml = await res.text();
    const cikMatch = xml.match(/<cik>\s*(\d+)\s*<\/cik>/i);
    if (!cikMatch?.[1]) continue;
    const cik10 = cikMatch[1].padStart(10, "0");
    const nameMatch = xml.match(/<conformed-name>\s*([^<]+?)\s*<\/conformed-name>/i);
    const companyName = nameMatch?.[1]?.trim() || upper;
    console.info(
      `[step1] EDGAR browse ${form} resolved ${upper} → CIK${cik10} (${companyName})`,
    );
    return { cik10, companyName };
  }
  return null;
}

export async function resolveLatestAnnualFiling(ticker: string): Promise<FilingMetadata> {
  const resolved = await resolveTickerToCik(ticker);
  console.info(
    `[step1] company_tickers.json ${resolved.ticker} → CIK${resolved.cik10} (${resolved.companyName})`,
  );

  let cik10 = resolved.cik10;
  let cikNoPad = resolved.cikNoPad;
  let companyName = resolved.companyName;
  let hit = await findLatestAnnualForCik(cik10);

  if (!hit) {
    console.warn(
      `[step1] no 10-K/20-F on CIK${cik10} (${companyName}) for ${resolved.ticker}; ` +
        `trying EDGAR browse fallback (holding-company remaps)`,
    );
    const alt = await resolveAnnualFilerViaEdgarBrowse(resolved.ticker);
    if (alt && alt.cik10 !== cik10) {
      const altHit = await findLatestAnnualForCik(alt.cik10);
      if (altHit) {
        hit = altHit;
        cik10 = alt.cik10;
        cikNoPad = cikNoPadFromCik10(alt.cik10);
        companyName = alt.companyName;
      }
    }
  }

  if (!hit) {
    throw new Error(`No 10-K or 20-F filing found for ${resolved.ticker}`);
  }

  const accessionNoDashes = hit.accessionNumber.replace(/-/g, "");
  const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accessionNoDashes}/${hit.primaryDocument}`;

  console.info(
    `[step1] annual filing ${resolved.ticker}: ${hit.form} ${hit.filingDate} CIK${cik10} ${hit.accessionNumber}`,
  );

  return {
    ticker: resolved.ticker,
    companyName,
    cik10,
    cikNoPad,
    form: hit.form,
    filingDate: hit.filingDate,
    accessionNumber: hit.accessionNumber,
    primaryDocument: hit.primaryDocument,
    sourceUrl,
  };
}

export function buildFilingBundle(meta: FilingMetadata, plainText: string): FilingBundle {
  const { text: itemSpan, sectionMethod, contentSuspect } = extractFilingSection(plainText, meta.form);
  return {
    ...meta,
    plainText,
    itemSpan,
    sectionMethod,
    contentSuspect,
  };
}

export async function fetchFilingDocument(meta: FilingMetadata): Promise<string> {
  const docRes = await secFetch(meta.sourceUrl, "text/html,application/xhtml+xml,*/*");
  if (!docRes.ok) {
    throw new Error(`Failed to fetch ${meta.form} document: HTTP ${docRes.status}`);
  }
  const html = await docRes.text();
  return htmlToPlainText(html);
}

export async function fetchLatest10K(ticker: string): Promise<FilingBundle> {
  const meta = await resolveLatestAnnualFiling(ticker);
  const plainText = await fetchFilingDocument(meta);
  return buildFilingBundle(meta, plainText);
}

export function chunkText(text: string, size = 24_000, overlap = 1_000): string[] {
  if (!text) return [];
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}
