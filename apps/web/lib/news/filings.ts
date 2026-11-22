import type pg from "pg";

/**
 * SEC EDGAR filings in Falcon's news flow, kept in Postgres
 * (public.news_filings, migration supabase/migrations/20261127_news_filings.sql).
 *
 * Forms: 8-K, 8-K/A, 6-K, 6-K/A (material events and press releases),
 * Schedule 13D and amendments (activist and large stakes), S-1, S-3, F-1, F-3
 * and amendments (registrations, including PIPE resale shelves), 424B1, 424B3,
 * 424B4, 424B5, 424B7 prospectuses (priced offerings, takedowns, resales; not
 * 424B2, which is banks' structured notes), 425 (merger communications),
 * SC TO-T and SC 14D9 (tender offers and the target's answer).
 *
 * Each sweeper batch:
 * 1. takes the lease in public.filing_sweep_state (one sweeper calls EDGAR at a time),
 * 2. prunes filings older than KEEP_FILING_DAYS,
 * 3. refreshes the CIK -> ticker map once a day (SEC company_tickers_exchange.json,
 *    cut to the news universe in public.news_sweep_state),
 * 4. polls EDGAR's latest-filings Atom feed (8-K, 6-K, Schedule 13D and 424B5
 *    every batch, the rarer forms in rotation) and inserts a row per new filing
 *    whose filer maps to a ticker,
 * 5. reads EDGAR daily form indexes it has not read yet (the last
 *    KEEP_FILING_DAYS days, newest first), which backfills and heals gaps,
 * 6. enriches pending rows newest first: the filing header (acceptance time,
 *    8-K items, parties, documents), then the press release (EX-99.x) or main
 *    document for the headline and summary.
 *
 * EDGAR fair access: every request carries SEC_USER_AGENT (Falcon's generic
 * app address, never a member's) and requests are spaced at least `gapMs`
 * apart, one at a time (4 a second in production, well under SEC's 10). A 403
 * or 429 ends the batch.
 *
 * Used by netlify/functions/filings-sweep.mts, scripts/filings-sweep.ts (run
 * by Node directly, so this file sticks to type-only TypeScript syntax),
 * lib/news/store.ts and lib/desk/tools/news.ts. The parsing helpers are pure.
 */

export const SEC_USER_AGENT = process.env.SEC_EDGAR_USER_AGENT?.trim() || "Falcon Website research@getfalcon.co";
/** Filing row ids are FILING_ID_BASE + the accession's digits; Finnhub article ids stay far below. */
export const FILING_ID_BASE = 1_000_000_000_000_000;
export const KEEP_FILING_DAYS = 90;
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data/";
const CIK_MAX_AGE_MS = 24 * 3600_000;
const MAX_TRIES = 5;
/** Bytes read from a document for its headline and summary (the front of a long prospectus is enough). */
const SUMMARY_DOC_BYTES = 1_500_000;
const SUMMARY_CHARS = 700;

export const FILING_FORMS = new Set([
  "8-K", "8-K/A", "6-K", "6-K/A",
  "SCHEDULE 13D", "SCHEDULE 13D/A", "SC 13D", "SC 13D/A",
  "S-1", "S-1/A", "S-3", "S-3/A", "S-3ASR", "F-1", "F-1/A", "F-3", "F-3/A", "F-3ASR",
  "424B1", "424B3", "424B4", "424B5", "424B7",
  "425", "SC TO-T", "SC TO-T/A", "SC 14D9", "SC 14D9/A",
]);

/** Feeds polled every batch, then the rarer ones in rotation (EDGAR's `type` is a prefix match; rows are cut to FILING_FORMS). */
const FEEDS_ALWAYS = ["8-K", "6-K", "SCHEDULE 13D", "424B5"];
const FEEDS_ROTATING = ["424B1", "424B3", "424B4", "424B7", "S-1", "S-3", "F-1", "F-3", "425", "SC TO-T", "SC 14D9"];

const is13D = (form: string) => /^(SC 13D|SCHEDULE 13D)/.test(form);

/* ------------------------------------------------------------------ words */

/** 8-K items in plain words, for headlines. */
export const ITEM_WORDS: Record<string, string> = {
  "1.01": "Entry into a Material Agreement",
  "1.02": "Termination of a Material Agreement",
  "1.03": "Bankruptcy or Receivership",
  "1.04": "Mine Safety Violations",
  "1.05": "Material Cybersecurity Incident",
  "2.01": "Completion of an Acquisition or Disposition",
  "2.02": "Results of Operations",
  "2.03": "New Debt or Financial Obligation",
  "2.04": "Acceleration of a Financial Obligation",
  "2.05": "Exit or Restructuring Costs",
  "2.06": "Material Impairment",
  "3.01": "Delisting or Listing Rule Notice",
  "3.02": "Unregistered Sale of Equity Securities",
  "3.03": "Change to Shareholder Rights",
  "4.01": "Change of Auditor",
  "4.02": "Prior Financial Statements No Longer Reliable",
  "5.01": "Change in Control",
  "5.02": "Director or Officer Change",
  "5.03": "Charter or Bylaw Amendment",
  "5.04": "Benefit Plan Trading Suspension",
  "5.05": "Code of Ethics Change",
  "5.06": "Change in Shell Company Status",
  "5.07": "Shareholder Vote Results",
  "5.08": "Shareholder Director Nominations",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

/** EDGAR header item titles ("ITEM INFORMATION: Unregistered Sales of Equity Securities") to item numbers. */
const ITEM_TITLES: [RegExp, string][] = [
  [/^entry into a material definitive/i, "1.01"],
  [/^termination of a material definitive/i, "1.02"],
  [/^bankruptcy or receivership/i, "1.03"],
  [/^mine safety/i, "1.04"],
  [/^material cybersecurity/i, "1.05"],
  [/^completion of acquisition/i, "2.01"],
  [/^results of operations/i, "2.02"],
  [/^creation of a direct financial/i, "2.03"],
  [/^triggering events/i, "2.04"],
  [/^costs associated with exit/i, "2.05"],
  [/^material impairments?/i, "2.06"],
  [/^notice of delisting/i, "3.01"],
  [/^unregistered sales? of equity/i, "3.02"],
  [/^material modifications? (to|of) rights/i, "3.03"],
  [/^changes? in registrant.s certifying/i, "4.01"],
  [/^non-reliance/i, "4.02"],
  [/^changes? in control/i, "5.01"],
  [/^departure of directors/i, "5.02"],
  [/^amendments? to articles/i, "5.03"],
  [/^temporary suspension of trading/i, "5.04"],
  [/^amendments? to (the )?registrant.s code of ethics/i, "5.05"],
  [/^change in shell company/i, "5.06"],
  [/^submission of matters/i, "5.07"],
  [/^shareholder (director )?nominations/i, "5.08"],
  [/^regulation fd/i, "7.01"],
  [/^other events/i, "8.01"],
  [/^financial statements and exhibits/i, "9.01"],
];

export function itemNumber(title: string): string | null {
  const t = title.trim();
  const direct = /^(?:item\s*)?(\d\.\d{2})\b/i.exec(t);
  if (direct) return direct[1]!;
  for (const [re, n] of ITEM_TITLES) if (re.test(t)) return n;
  return null;
}

/** "SCHEDULE 13D/A" -> "13D/A" for headlines; other forms as filed. */
export function shortForm(form: string): string {
  return form.replace(/^(SCHEDULE|SC) 13D/, "13D");
}

/** What a non-8-K form is, in words. */
export function formWords(form: string): string {
  const amended = form.endsWith("/A");
  const base = form.replace(/\/A$/, "");
  switch (base) {
    case "8-K":
      return amended ? "Amended Current Report" : "Current Report";
    case "6-K":
      return amended ? "Amended Report of a Foreign Issuer" : "Report of a Foreign Issuer";
    case "SCHEDULE 13D":
    case "SC 13D":
      return amended ? "Amended Stake Filing (5% or More)" : "Stake of 5% or More";
    case "S-1":
    case "F-1":
      return amended ? "Amended Registration Statement for an Offering" : "Registration Statement for an Offering";
    case "S-3":
    case "F-3":
      return amended ? "Amended Shelf Registration" : "Shelf Registration";
    case "S-3ASR":
    case "F-3ASR":
      return "Automatic Shelf Registration";
    case "424B1":
    case "424B4":
      return "Final Prospectus for an Offering";
    case "424B5":
      return "Prospectus Supplement for an Offering";
    case "424B3":
      return "Prospectus Supplement";
    case "424B7":
      return "Prospectus for a Resale by Selling Holders";
    case "425":
      return "Merger or Deal Communication";
    case "SC TO-T":
      return amended ? "Amended Tender Offer" : "Tender Offer";
    case "SC 14D9":
      return amended ? "Amended Response to a Tender Offer" : "Company Response to a Tender Offer";
    default:
      return form;
  }
}

/** Item words for a headline: 9.01 left out, and 7.01 too when other items carry the news. */
export function headlineItems(items: string[]): string[] {
  const known = [...new Set(items)].filter((i) => ITEM_WORDS[i]).sort();
  let keep = known.filter((i) => i !== "9.01");
  if (keep.some((i) => i !== "7.01" && i !== "8.01")) keep = keep.filter((i) => i !== "7.01");
  return (keep.length ? keep : known).map((i) => ITEM_WORDS[i]!);
}

/** No em or en dashes and no runs of whitespace in stored headlines and summaries. */
export function plain(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, " - ")
    .replace(/[ \s]+/g, " ")
    .trim();
}

export type HeadlineInput = {
  ticker: string;
  company: string;
  form: string;
  items: string[];
  /** The press release title (8-K, 6-K, 425). */
  title?: string | null;
  /** Schedule 13D: who reports the stake, and the largest percent of class. */
  holder?: string | null;
  percent?: number | null;
};

/**
 * "ABEO 8-K: Entry into a Material Agreement; Unregistered Sale of Equity
 * Securities. Abeona Therapeutics Acquires ..." Pure.
 */
export function buildHeadline(h: HeadlineInput): string {
  const head = `${h.ticker} ${shortForm(h.form)}`;
  let what: string;
  if (/^8-K/.test(h.form) && h.items.length) what = headlineItems(h.items).join("; ");
  else if (is13D(h.form) && h.holder) {
    const pct = h.percent !== null && h.percent !== undefined && Number.isFinite(h.percent) ? ` (${h.percent}%)` : "";
    what = h.form.endsWith("/A") ? `${h.holder} amends its stake filing${pct}` : `${h.holder} reports a stake of 5% or more${pct}`;
  } else what = formWords(h.form);
  const title = h.title ? plain(h.title).replace(/[.\s]+$/, "") : "";
  const tail = title ? `. ${title}` : h.company && !(is13D(h.form) && h.holder) ? ` (${h.company})` : "";
  const out = plain(`${head}: ${what}${tail}`);
  return out.length > 320 ? `${out.slice(0, 317).replace(/\s+\S*$/, "")}...` : out;
}

/* ------------------------------------------------------------------ accession numbers and times */

/** "0001493152-26-050606" -> 1149315226050606, or null for a malformed accession. */
export function filingId(accession: string): number | null {
  const m = /^(\d{10})-(\d{2})-(\d{6})$/.exec(accession.trim());
  if (!m) return null;
  const n = BigInt(FILING_ID_BASE) + BigInt(`${m[1]}${m[2]}${m[3]}`);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}

export const isFilingId = (id: number) => id >= FILING_ID_BASE;

export function filingFolder(cik: string, accession: string): string {
  return `${ARCHIVES}${Number(cik)}/${accession.replace(/-/g, "")}/`;
}

export function filingIndexUrl(cik: string, accession: string): string {
  return `${filingFolder(cik, accession)}${accession}-index.htm`;
}

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function nyOffsetMs(ms: number): number {
  const p: Record<string, number> = {};
  for (const part of nyParts.formatToParts(ms)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - ms;
}

/** A New York wall-clock time as a UTC Date. */
export function nyTime(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - nyOffsetMs(wall);
  t = wall - nyOffsetMs(t);
  return new Date(t);
}

/** "20261109063034" (EDGAR acceptance time, New York) -> Date. */
export function parseAcceptance(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s.trim());
  return m ? nyTime(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

/** Today's date in New York, "YYYY-MM-DD". */
export function nyToday(ms = Date.now()): string {
  return new Date(ms + nyOffsetMs(ms)).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ text */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", cent: "¢", deg: "°", middot: "·", bull: "•",
  thinsp: " ", ensp: " ", emsp: " ", zwnj: "", zwj: "", shy: "",
  times: "×", sect: "§", para: "¶", frac12: "½", frac14: "¼", frac34: "¾", eacute: "é", egrave: "è", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", ntilde: "ñ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** An EDGAR HTML or iXBRL document as text blocks (paragraphs, table rows, headings), in order. Pure. */
export function htmlBlocks(html: string): string[] {
  let s = html;
  // An exhibit read from a full submission starts with its SGML wrapper.
  const text = /<TEXT>/i.exec(s.slice(0, 2000));
  if (text) s = s.slice(text.index + text[0].length);
  s = s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<ix:header\b[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6]|table|ul|ol|center|blockquote|section|article|pre|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<\/?(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \s]+/g, " ").trim())
    .filter((l) => l && !/^(\d{1,3}|-\s*\d{1,3}\s*-|page \d+( of \d+)?|table of contents|\*+|_+)$/i.test(l));
}

const SENTENCE_END = /[.!?]["”’)]?$|[.!?]["”’)]?\s/;
const SKIP_LEAD = /^(forward[- ]looking|safe harbor|cautionary|about\b|the information in this|this (press release|communication|current report|report on form)|in connection with the proposed|important (additional )?information|additional information|no offer or solicitation|participants in the solicitation|investor (relations|contact)|media contact)/i;
const SKIP_TITLE = /^(exhibit\b|ex-\d|(press|news) release\b|for (immediate )?release|contacts?\b|investors?\b|media\b|source\b|\(?(nasdaq|nyse)\b|form \d|united states|securities and exchange commission|washington,? d\.?c|page \d)/i;

/** Contact blocks, 425 legends and similar lines that sit above a press release title. */
const NOT_TITLE =
  /(vice president|investor relations|public relations|@|\(\d{3}\)\s*\d{3}|\d{3}[-.]\d{3}[-.]\d{4}|^filed by\b|pursuant to rule|^subject company|commission file|^\(?registrant|^[^,]{2,60},? (inc|corp|corporation|ltd|limited|plc|llc|co|holdings|n\.v|s\.a)\.?$|\b(suite|drive|street|avenue|road|blvd|boulevard|parkway)\b.*\d|\b\d{5}(-\d{4})?$)/i;

/** Words whose period does not end a sentence ("LiveOne, Inc. (the Company)", "the U.S. Securities"). */
const ABBREVIATION = /(?:^|[\s(])(inc|corp|co|ltd|llc|plc|mr|mrs|ms|dr|st|no|nos|vs|jr|sr|approx|fig|ex|u\.s|l\.p|n\.v|s\.a|e\.g|i\.e|[a-z])\.$/i;

/**
 * The index just past the last sentence end within the first `limit`
 * characters of `text`, or -1: a . ! or ? (and any closing quote) followed by
 * whitespace and a capital, digit or opening quote, or by the end of the text,
 * and not an abbreviation's period. Pure.
 */
export function lastSentenceEnd(text: string, limit = text.length): number {
  const cut = text.slice(0, limit);
  let end = -1;
  for (const m of cut.matchAll(/[.!?]["”’)]?(?=\s+["“‘(]?[A-Z0-9$]|\s*$)/g)) {
    const at = m.index! + m[0].length;
    if (at === cut.length && limit < text.length && !/^\s/.test(text.slice(at))) continue;
    if (m[0][0] === "." && ABBREVIATION.test(cut.slice(Math.max(0, m.index! - 8), m.index! + 1))) continue;
    end = at;
  }
  return end;
}

/** Clip at a sentence end at or before `max` characters; never mid-sentence. */
export function sentenceClip(s: string, max: number): { text: string; clipped: boolean } {
  const t = s.trim();
  if (t.length <= max) return { text: t, clipped: false };
  const end = lastSentenceEnd(t, max + 1);
  if (end > 40) return { text: t.slice(0, end), clipped: true };
  return { text: `${t.slice(0, max).replace(/\s+\S*$/, "")}...`, clipped: true };
}

/** A press release's title and first meaningful paragraph. Pure. */
export function pressRelease(blocks: string[]): { title: string | null; lead: string | null } {
  const leadAt = blocks.findIndex((b, i) => i < 400 && b.length >= 140 && SENTENCE_END.test(b) && !SKIP_LEAD.test(b));
  let title: string | null = null;
  const end = Math.min(leadAt === -1 ? Math.min(blocks.length, 25) : leadAt, 40);
  const titleLike = (b: string) =>
    !SKIP_TITLE.test(b) && !NOT_TITLE.test(b) && !/^[-–—•·*]/.test(b) && !/^[A-Z][a-z]+\.? \d{1,2}, \d{4}$/.test(b) && b.replace(/[^A-Za-z]/g, "").length >= b.length * 0.5;
  for (let i = 0; i < end; i++) {
    const b = blocks[i]!;
    if (b.length < 20 || b.length > 300 || !titleLike(b)) continue;
    title = b;
    // A title broken over two or three lines: join while it dangles ("... in the Third" + "Quarter of 2026").
    for (let j = i + 1; j < end && j <= i + 2; j++) {
      const next = blocks[j]!;
      const dangling =
        /\b(the|of|and|in|for|to|with|a|an|on|at|by|its|from|as|&|first|second|third|fourth|fiscal|utilizing|using|including|following|featuring|following)$/i.test(title) ||
        /^[a-z]/.test(next) ||
        /^(quarter|year|half|of|and|for|to|in|with|at|on|by)\b/i.test(next);
      if (!dangling || /[.!?:]$/.test(title) || next.length > 200 || !titleLike(next) || title.length + next.length > 300) break;
      title = `${title} ${next}`;
    }
    break;
  }
  const lead = leadAt === -1 ? null : sentenceClip(blocks[leadAt]!, SUMMARY_CHARS).text;
  return { title, lead };
}

const ITEM_HEAD = /^item\s*(\d\.\d{2})\b/i;

/** The first paragraph under an 8-K's first item other than 9.01. Pure. */
export function itemLead(blocks: string[]): string | null {
  let inItem = false;
  for (const b of blocks) {
    const head = ITEM_HEAD.exec(b);
    if (head) {
      inItem = head[1] !== "9.01";
      // Some filers put the item heading and its text in one block.
      const rest = b.replace(/^item\s*\d\.\d{2}\.?\s*[^.]{0,140}?\.\s*/i, "");
      if (inItem && rest.length >= 120 && rest !== b) return sentenceClip(rest, SUMMARY_CHARS).text;
      continue;
    }
    if (inItem && b.length >= 80 && !SKIP_LEAD.test(b)) return sentenceClip(b, SUMMARY_CHARS).text;
  }
  return null;
}

const COVER = /^(indicate by check mark|if the only securities|if this form|if an emerging growth|the registrant hereby amends|subject to completion|as filed with the securities|approximate date of commencement|if any of the securities being registered|if this form is|the registrant hereby amends|the information in this (preliminary )?prospectus|neither the securities and exchange commission|calculation of (the )?registration fee|pursuant to rule|check the appropriate box|large accelerated filer|if an emerging growth|securities act of 1933|copies to|\(?(exact name|address|telephone|name, address))/i;
const OFFERING = /\b(we are offering|are offering|is offering|this prospectus relates|selling (stock|share|security)holders?|resale|offer(ing)? (of )?up to|shares of (our )?(common|ordinary|class)|public offering|private placement|pre-funded|warrants?|tender offer|merger|business combination|acquisition)\b/i;

/** The first paragraph that says what a registration, prospectus or other filing is about. Pure. */
export function genericLead(blocks: string[]): string | null {
  const body = blocks.slice(0, 600).filter((b) => b.length >= 140 && SENTENCE_END.test(b) && !COVER.test(b) && !SKIP_LEAD.test(b));
  const pick = body.find((b) => OFFERING.test(b)) ?? body[0];
  return pick ? sentenceClip(pick, SUMMARY_CHARS).text : null;
}

const xmlText = (s: string) => decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g"))) out.push(xmlText(m[1]!));
  return out;
}

export type Schedule13D = { holders: string[]; percent: number | null; purpose: string | null; text: string };

/** A Schedule 13D's structured XML (EDGAR's 2024 format): reporting persons, the largest percent, Item 4 and a readable text. Pure. */
export function schedule13d(xml: string): Schedule13D {
  const holders = [...new Set(xmlAll(xml, "reportingPersonName").filter(Boolean))];
  const pcts = xmlAll(xml, "percentOfClass").map(Number).filter(Number.isFinite);
  const percent = pcts.length ? Math.max(...pcts) : null;
  const purpose = xmlAll(xml, "transactionPurpose")[0] || null;
  const section = (label: string, tags: string[]) => {
    const parts = tags.flatMap((t) => xmlAll(xml, t)).filter((p) => p.length > 0);
    return parts.length ? `${label}\n${parts.join("\n\n")}` : "";
  };
  const persons = xmlAll(xml, "reportingPersonInfo").length
    ? [...xml.matchAll(/<reportingPersonInfo\b[^>]*>([\s\S]*?)<\/reportingPersonInfo>/g)].map((m) => {
        const name = xmlAll(m[1]!, "reportingPersonName")[0] ?? "";
        const owned = xmlAll(m[1]!, "aggregateAmountOwned")[0] ?? "";
        const pct = xmlAll(m[1]!, "percentOfClass")[0] ?? "";
        return `${name}: ${owned ? `${Number(owned).toLocaleString("en-US")} shares` : "shares not given"}${pct ? `, ${pct}% of the class` : ""}`;
      })
    : [];
  const text = [
    `Issuer: ${xmlAll(xml, "issuerName")[0] ?? ""}. Class: ${xmlAll(xml, "securitiesClassTitle")[0] ?? ""}. Date of event: ${xmlAll(xml, "dateOfEvent")[0] ?? ""}.`,
    persons.length ? `Reporting persons\n${persons.join("\n")}` : "",
    section("Item 3. Source and amount of funds", ["fundsSource"]),
    section("Item 4. Purpose of transaction", ["transactionPurpose"]),
    section("Item 5. Interest in securities of the issuer", ["percentageOfClassSecurities", "numberOfShares", "transactionDesc"]),
    section("Item 6. Contracts, arrangements or understandings", ["contractDescription"]),
    section("Item 7. Exhibits", ["filedExhibits"]),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { holders, percent, purpose: purpose ? sentenceClip(purpose, SUMMARY_CHARS).text : null, text };
}

/**
 * A filing document as readable text for Falcon AI: iXBRL and HTML stripped,
 * an 8-K's cover page skipped (the text starts at its first Item), a Schedule
 * 13D's XML laid out by item. Paragraphs are separated by blank lines. Pure.
 */
export function filingDocumentText(raw: string, opts: { form: string; primary: boolean }): string {
  const head = raw.slice(0, 500);
  if (!/<html\b/i.test(head) && (/^\s*<\?xml/i.test(head) || /<edgarSubmission\b/i.test(head))) {
    if (/schedule13D/i.test(head) || is13D(opts.form)) return schedule13d(raw).text;
    const leaves = [...raw.matchAll(/<(\w+)[^>]*>([^<]{40,})<\/\1>/g)].map((m) => decodeEntities(m[2]!).replace(/\s+/g, " ").trim());
    return leaves.join("\n\n");
  }
  let blocks = htmlBlocks(raw);
  if (opts.primary && /^8-K/.test(opts.form)) {
    const at = blocks.findIndex((b) => ITEM_HEAD.test(b));
    if (at > 0) blocks = blocks.slice(at);
    const sig = blocks.findIndex((b) => /^signatures?$/i.test(b));
    if (sig > 0) blocks = blocks.slice(0, sig);
  } else if (opts.primary) {
    // Registrations and prospectuses: start a few lines above the paragraph that says what is offered, past the cover's check boxes.
    const body = (b: string) => b.length >= 140 && SENTENCE_END.test(b) && !COVER.test(b) && !SKIP_LEAD.test(b);
    let at = blocks.findIndex((b, i) => i < 600 && body(b) && OFFERING.test(b));
    if (at === -1) at = blocks.findIndex(body);
    if (at > 0) blocks = blocks.slice(Math.max(0, at - 6));
  }
  return blocks.join("\n\n");
}

/* ------------------------------------------------------------------ EDGAR parsing */

export type FeedEntry = { accession: string; form: string; cik: string; company: string; role: string; acceptedAt: Date | null; items: string[] };

/** EDGAR getcurrent Atom feed entries. Pure. */
export function parseAtom(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    const title = decodeEntities(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? "").trim();
    const t = /^(.+?) - (.+) \((\d{10})\) \(([^)]+)\)$/.exec(title);
    const accession = /accession-number=(\d{10}-\d{2}-\d{6})/.exec(e)?.[1];
    const form = decodeEntities(/<category[^>]*term="([^"]+)"/.exec(e)?.[1] ?? t?.[1] ?? "").trim();
    if (!t || !accession || !form) continue;
    const summary = decodeEntities(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(e)?.[1] ?? "");
    const items = [...summary.matchAll(/Item (\d\.\d{2})/g)].map((x) => x[1]!);
    const updated = /<updated>([^<]+)<\/updated>/.exec(e)?.[1];
    const at = updated ? new Date(updated) : null;
    out.push({ accession, form, cik: String(Number(t[3])), company: t[2]!.trim(), role: t[4]!.trim(), acceptedAt: at && !Number.isNaN(at.getTime()) ? at : null, items: [...new Set(items)] });
  }
  return out;
}

export type IndexEntry = { accession: string; form: string; cik: string; company: string; date: string };

/** EDGAR daily form index (form.YYYYMMDD.idx) lines for FILING_FORMS. Pure. */
export function parseFormIndex(text: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+(?: \S+)*?)\s{2,}(.*?)\s{2,}(\d{1,10})\s+(\d{8})\s+edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt\s*$/.exec(line);
    if (!m || !FILING_FORMS.has(m[1]!)) continue;
    const d = m[4]!;
    out.push({ form: m[1]!, company: m[2]!.trim(), cik: String(Number(m[3])), date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, accession: m[5]! });
  }
  return out;
}

export type FilingDoc = { type: string; filename: string; description: string };
export type FilingHeader = {
  form: string | null;
  acceptedAt: Date | null;
  items: string[];
  parties: { role: string; name: string; cik: string }[];
  documents: FilingDoc[];
};

/** EDGAR's -index-headers.html (the SGML header and document list). Pure. */
export function parseHeader(html: string): FilingHeader {
  const text = decodeEntities(html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, ""));
  const acc = /<ACCEPTANCE-DATETIME>\s*(\d{14})/.exec(text)?.[1];
  const form = /CONFORMED SUBMISSION TYPE:\s*(.+)/.exec(text)?.[1]?.trim() ?? null;
  const items = [...text.matchAll(/ITEM INFORMATION:\s*(.+)/g)].map((m) => itemNumber(m[1]!)).filter((n): n is string => !!n);
  const parties: FilingHeader["parties"] = [];
  const sections = text.split(/\n\s*(FILER|SUBJECT COMPANY|FILED BY|REPORTING-OWNER|ISSUER):\s*\n/);
  for (let i = 1; i < sections.length; i += 2) {
    const body = sections[i + 1] ?? "";
    const name = /COMPANY CONFORMED NAME:\s*(.+)/.exec(body)?.[1]?.trim();
    const cik = /CENTRAL INDEX KEY:\s*(\d+)/.exec(body)?.[1];
    if (name && cik) parties.push({ role: sections[i]!, name, cik: String(Number(cik)) });
  }
  const documents: FilingDoc[] = [];
  for (const m of text.matchAll(/<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/g)) {
    const d = m[1]!;
    const type = /<TYPE>([^\n<]+)/.exec(d)?.[1]?.trim();
    const filename = /<FILENAME>([^\n<]+)/.exec(d)?.[1]?.trim();
    if (type && filename) documents.push({ type, filename, description: /<DESCRIPTION>([^\n<]+)/.exec(d)?.[1]?.trim() ?? "" });
  }
  return { form, acceptedAt: acc ? parseAcceptance(acc) : null, items: [...new Set(items)], parties, documents };
}

/** CIKs whose tickers a filing is tagged with: a 13D's subject company only (not the investor filing it), else every party. */
export function taggedCiks(form: string, parties: { role: string; cik: string }[]): string[] {
  const pick = is13D(form) ? parties.filter((p) => /subject/i.test(p.role)) : parties;
  return [...new Set(pick.map((p) => p.cik))];
}

export type StoredDoc = { type: string; description: string; url: string };

/** The main document and up to four EX-99 exhibits (press releases, letters), as stored URLs. */
export function pickDocuments(form: string, folder: string, docs: FilingDoc[]): StoredDoc[] {
  const readable = (d: FilingDoc) => /\.(htm|html|txt|xml)$/i.test(d.filename) && !/\//.test(d.filename.replace(/^xsl[^/]+\//, ""));
  const primary = docs.find((d) => d.type === form && readable(d)) ?? docs.find(readable);
  const exhibits = docs.filter((d) => /^EX-99/i.test(d.type) && readable(d) && d !== primary).slice(0, 4);
  return [primary, ...exhibits].filter((d): d is FilingDoc => !!d).map((d) => ({ type: d.type, description: d.description, url: `${folder}${d.filename}` }));
}

/** True for a URL a stored filing may point at: an https page in EDGAR's archive. */
export function isEdgarArchiveUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "www.sec.gov" && !u.port && !u.username && u.pathname.startsWith("/Archives/edgar/data/");
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ EDGAR client */

export class EdgarLimited extends Error {}

export type EdgarResponse = { status: number; text: string };

/** Requests start at least `gapMs` apart (callers may overlap), with SEC_USER_AGENT. A rate-limit 403 or a 429 throws EdgarLimited. */
export class EdgarClient {
  gapMs: number;
  signal: AbortSignal | undefined;
  calls = 0;
  private next = 0;

  constructor(gapMs: number, signal?: AbortSignal) {
    this.gapMs = gapMs;
    this.signal = signal;
  }

  async get(url: string, maxBytes = 4_000_000, timeoutMs = 15_000): Promise<EdgarResponse> {
    // Each request reserves the next start slot, so concurrent callers still start gapMs apart.
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await sleep(at - now, this.signal);
    if (this.signal?.aborted) throw new Error("aborted");
    this.calls++;
    const signals = [AbortSignal.timeout(timeoutMs), ...(this.signal ? [this.signal] : [])];
    const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT, Accept: "*/*" }, redirect: "follow", signal: AbortSignal.any(signals) });
    if (res.status === 403 || res.status === 429) {
      // A missing archive file (a holiday's daily index) is an S3 AccessDenied 403, not SEC's rate-limit page.
      const body = new TextDecoder().decode(await readCapped(res, 4096));
      if (res.status === 403 && /<Code>(AccessDenied|NoSuchKey)<\/Code>/.test(body)) return { status: 404, text: "" };
      throw new EdgarLimited(`EDGAR HTTP ${res.status} on ${url}`);
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      return { status: res.status, text: "" };
    }
    const bytes = await readCapped(res, maxBytes);
    return { status: res.status, text: new TextDecoder(/charset=["']?iso-8859-1|latin1|windows-1252/i.test(res.headers.get("content-type") ?? "") ? "latin1" : "utf-8").decode(bytes) };
  }
}

/** At most `max` bytes of a response body. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, max);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    const take = p.subarray(0, out.length - at);
    out.set(take, at);
    at += take.byteLength;
  }
  return out;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/* ------------------------------------------------------------------ CIK map */

/** cik -> [company name, tickers in the news universe]. */
export type CikMap = Record<string, [string, string[]]>;

/** SEC tickers ("BRK-B") in Finnhub's dotted form ("BRK.B"). */
const dotted = (t: string) => t.toUpperCase().replace(/-/g, ".");

/** company_tickers_exchange.json cut to `universe` (or to NYSE, Nasdaq and Cboe listings when the universe is empty). Pure. */
export function buildCikMap(raw: { fields?: string[]; data?: unknown[][] }, universe: Set<string>): CikMap {
  const f = raw.fields ?? ["cik", "name", "ticker", "exchange"];
  const at = (k: string) => f.indexOf(k);
  const map: CikMap = {};
  for (const row of raw.data ?? []) {
    const cik = String(Number(row[at("cik")]));
    const ticker = dotted(String(row[at("ticker")] ?? ""));
    const exchange = String(row[at("exchange")] ?? "");
    if (!ticker || cik === "NaN") continue;
    if (universe.size ? !universe.has(ticker) : !/^(NYSE|Nasdaq|CBOE)$/i.test(exchange)) continue;
    const entry = (map[cik] ??= [String(row[at("name")] ?? ""), []]);
    if (!entry[1].includes(ticker)) entry[1].push(ticker);
  }
  return map;
}

/** ticker -> company name from a CikMap (for tagging Finnhub articles). */
export function tickerNames(map: CikMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, tickers] of Object.values(map)) for (const t of tickers) if (!out.has(t)) out.set(t, name);
  return out;
}

/* ------------------------------------------------------------------ reading */

export type FilingRow = {
  id: number;
  accession: string;
  symbols: string[];
  company: string;
  form: string;
  items: string[];
  headline: string;
  summary: string;
  url: string;
  documents: StoredDoc[];
  publishedAt: string;
};

/* ------------------------------------------------------------------ sweeping */

export type FilingSweepOptions = {
  /** Who holds the lease, e.g. "netlify:ab12" or "local:host:123". */
  owner: string;
  /** How long the lease lasts past each step; a crashed sweeper frees it after this. */
  leaseMs: number;
  /** Stop starting requests once this much time has passed. */
  budgetMs: number;
  /** Least time between two EDGAR requests. */
  gapMs: number;
  /** Poll the latest-filings feeds this batch. */
  live: boolean;
  /** Poll every rotating feed this batch, not just this batch's share. */
  allFeeds?: boolean;
  /** Most daily form indexes read this batch. */
  indexDays: number;
  /** Filings enriched at once (default 1). */
  workers?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
};

export type FilingSweepResult = {
  heldBy?: { owner: string; until: string };
  calls: number;
  feeds: number;
  inserted: number;
  enriched: number;
  dropped: number;
  failed: number;
  pending: number;
  indexDays: string[];
  pruned: number;
  ciks: number;
  stoppedBy: "done" | "budget" | "limit" | "signal" | "lease" | "held";
};

type State = { ciks: CikMap; ciks_at: Date | null; feed_cursor: number; index_days: string[] };

async function acquire(pool: pg.Pool, owner: string, leaseMs: number): Promise<{ ok: true; state: State } | { ok: false; owner: string; until: Date }> {
  await pool.query(`insert into public.filing_sweep_state (id) values (1) on conflict (id) do nothing`);
  const { rows } = await pool.query<State>(
    `update public.filing_sweep_state
        set lease_owner = $1, lease_until = now() + make_interval(secs => $2::double precision / 1000), updated_at = now()
      where id = 1 and (lease_until is null or lease_until < now() or lease_owner = $1)
      returning ciks, ciks_at, feed_cursor, index_days`,
    [owner, leaseMs],
  );
  if (rows[0]) return { ok: true, state: rows[0] };
  const held = await pool.query<{ lease_owner: string; lease_until: Date }>(`select lease_owner, lease_until from public.filing_sweep_state where id = 1`);
  return { ok: false, owner: held.rows[0]?.lease_owner ?? "unknown", until: held.rows[0]?.lease_until ?? new Date() };
}

/** Frees the filings lease if `owner` still holds it. */
export async function releaseFilingLease(pool: pg.Pool, owner: string): Promise<void> {
  await pool.query(`update public.filing_sweep_state set lease_until = now(), updated_at = now() where id = 1 and lease_owner = $1`, [owner]);
}

async function renew(pool: pg.Pool, opts: FilingSweepOptions): Promise<boolean> {
  const r = await pool.query(
    `update public.filing_sweep_state set lease_until = now() + make_interval(secs => $1::double precision / 1000), updated_at = now() where id = 1 and lease_owner = $2`,
    [opts.leaseMs, opts.owner],
  );
  return (r.rowCount ?? 0) > 0;
}

type Candidate = { accession: string; form: string; ciks: string[]; acceptedAt: Date; items: string[] };

/** Inserts filings not stored yet as pending rows (headline from the form and items). Returns how many were new. */
async function insertPending(pool: pg.Pool, map: CikMap, list: Candidate[]): Promise<number> {
  const rows: { id: number; accession: string; cik: string; company: string; symbols: string[]; form: string; items: string[]; headline: string; url: string; at: Date }[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (seen.has(c.accession)) continue;
    const id = filingId(c.accession);
    const mapped = c.ciks.filter((k) => map[k]);
    if (!id || !mapped.length) continue;
    seen.add(c.accession);
    const cik = mapped[0]!;
    const [company, tickers] = map[cik]!;
    const symbols = [...new Set(mapped.flatMap((k) => map[k]![1]))];
    rows.push({
      id,
      accession: c.accession,
      cik,
      company,
      symbols,
      form: c.form,
      items: c.items,
      headline: buildHeadline({ ticker: tickers[0]!, company, form: c.form, items: c.items }),
      url: filingIndexUrl(cik, c.accession),
      at: c.acceptedAt,
    });
  }
  if (!rows.length) return 0;
  const res = await pool.query(
    `insert into public.news_filings (id, accession, cik, company, symbols, form, items, headline, url, published_at)
     select t.id, t.accession, t.cik, t.company, string_to_array(t.symbols, ','), t.form, coalesce(string_to_array(nullif(t.items, ''), ','), '{}'), t.headline, t.url, t.at
       from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::timestamptz[])
         as t(id, accession, cik, company, symbols, form, items, headline, url, at)
     on conflict (accession) do nothing`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.accession),
      rows.map((r) => r.cik),
      rows.map((r) => r.company),
      rows.map((r) => r.symbols.join(",")),
      rows.map((r) => r.form),
      rows.map((r) => r.items.join(",")),
      rows.map((r) => r.headline),
      rows.map((r) => r.url),
      rows.map((r) => r.at.toISOString()),
    ],
  );
  return res.rowCount ?? 0;
}

type Pending = { id: string; accession: string; cik: string; company: string; symbols: string[]; form: string; items: string[]; published_at: Date; enrich_tries: number };

/** Reads one pending filing's header and summary document and completes its row. Returns what happened. */
async function enrich(pool: pg.Pool, edgar: EdgarClient, map: CikMap, row: Pending): Promise<"enriched" | "dropped" | "failed"> {
  await pool.query(`update public.news_filings set enrich_tries = enrich_tries + 1 where id = $1`, [row.id]);
  const folder = filingFolder(row.cik, row.accession);
  const headerRes = await edgar.get(`${folder}${row.accession}-index-headers.html`, 2_000_000);
  if (headerRes.status !== 200) return "failed";
  const header = parseHeader(headerRes.text);
  const form = header.form && FILING_FORMS.has(header.form) ? header.form : row.form;
  const ciks = header.parties.length ? taggedCiks(form, header.parties).filter((k) => map[k]) : [row.cik];
  if (!ciks.length) {
    // Only the investor behind a 13D maps to a ticker, or the filer left the universe.
    await pool.query(`delete from public.news_filings where id = $1`, [row.id]);
    return "dropped";
  }
  const symbols = [...new Set(ciks.flatMap((k) => map[k]?.[1] ?? []))];
  const cik = ciks[0]!;
  const company = map[cik]?.[0] ?? row.company;
  const items = header.items.length ? header.items : row.items;
  const documents = pickDocuments(form, folder, header.documents);

  let title: string | null = null;
  let summary: string | null = null;
  let holder: string | null = null;
  let percent: number | null = null;
  const primary = documents[0];
  const exhibit = documents.slice(1).find((d) => /^EX-99\.?0?1\b/i.test(d.type)) ?? documents[1];
  const wantsRelease = /^(8-K|6-K|425)/.test(form);
  const source = wantsRelease && exhibit && !is13D(form) ? exhibit : primary;
  if (source) {
    const doc = await edgar.get(source.url, SUMMARY_DOC_BYTES);
    if (doc.status === 200 && doc.text) {
      if (is13D(form) && /\.xml$/i.test(source.url)) {
        const d = schedule13d(doc.text);
        holder = d.holders[0] ?? null;
        percent = d.percent;
        summary = d.purpose;
      } else {
        const blocks = htmlBlocks(doc.text);
        if (wantsRelease && source !== primary) {
          const pr = pressRelease(blocks);
          title = pr.title;
          summary = pr.lead;
        } else if (/^8-K/.test(form)) summary = itemLead(blocks) ?? genericLead(blocks);
        else if (/^(6-K|425)/.test(form)) {
          const pr = pressRelease(blocks);
          title = pr.title;
          summary = pr.lead ?? genericLead(blocks);
        } else summary = genericLead(blocks);
      }
    }
    // An 8-K whose press release had no usable paragraph: take the item text from the main document.
    if (!summary && /^8-K/.test(form) && primary && source !== primary) {
      const doc2 = await edgar.get(primary.url, SUMMARY_DOC_BYTES);
      if (doc2.status === 200) summary = itemLead(htmlBlocks(doc2.text));
    }
  }
  const tickers = map[cik]?.[1] ?? symbols;
  const headline = buildHeadline({ ticker: tickers[0] ?? symbols[0] ?? "", company, form, items, title, holder, percent });
  await pool.query(
    `update public.news_filings
        set symbols = $2, company = $3, form = $4, items = $5, headline = $6, summary = $7, documents = $8::jsonb,
            published_at = coalesce($9::timestamptz, published_at), enriched_at = now(), fetched_at = now()
      where id = $1`,
    [row.id, symbols, company, form, items, headline, summary ? plain(summary) : "", JSON.stringify(documents), header.acceptedAt ? header.acceptedAt.toISOString() : null],
  );
  return "enriched";
}

function quarter(day: string): string {
  return `QTR${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;
}

/** Weekdays from yesterday back `days` days (New York dates), newest first. */
export function indexDaysToRead(today: string, days: number, done: Set<string>): string[] {
  const out: string[] = [];
  const base = Date.parse(`${today}T12:00:00Z`);
  for (let i = 1; i <= days; i++) {
    const d = new Date(base - i * 86_400_000);
    const wd = d.getUTCDay();
    const s = d.toISOString().slice(0, 10);
    if (wd !== 0 && wd !== 6 && !done.has(s)) out.push(s);
  }
  return out;
}

/**
 * One batch (see the file comment). Leaves the lease held; call
 * releaseFilingLease when done.
 */
export async function sweepFilings(pool: pg.Pool, opts: FilingSweepOptions): Promise<FilingSweepResult> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const result: FilingSweepResult = { calls: 0, feeds: 0, inserted: 0, enriched: 0, dropped: 0, failed: 0, pending: 0, indexDays: [], pruned: 0, ciks: 0, stoppedBy: "done" };
  const lease = await acquire(pool, opts.owner, opts.leaseMs);
  if (!lease.ok) return { ...result, heldBy: { owner: lease.owner, until: lease.until.toISOString() }, stoppedBy: "held" };
  const state = lease.state;
  const edgar = new EdgarClient(opts.gapMs, opts.signal);
  const timeLeft = () => opts.budgetMs - (Date.now() - started);
  const stop = (): boolean => {
    if (opts.signal?.aborted) result.stoppedBy = "signal";
    else if (timeLeft() <= 0) result.stoppedBy = "budget";
    else return false;
    return true;
  };

  try {
    const pruned = await pool.query(`delete from public.news_filings where published_at < now() - make_interval(days => $1)`, [KEEP_FILING_DAYS]);
    result.pruned = pruned.rowCount ?? 0;

    // CIK -> ticker map, cut to the news universe.
    let map = state.ciks ?? {};
    if (!Object.keys(map).length || !state.ciks_at || Date.now() - state.ciks_at.getTime() > CIK_MAX_AGE_MS) {
      const uni = await pool.query<{ universe: string[] }>(`select universe from public.news_sweep_state where id = 1`).catch(() => ({ rows: [] as { universe: string[] }[] }));
      const universe = new Set(uni.rows[0]?.universe ?? []);
      const res = await edgar.get("https://www.sec.gov/files/company_tickers_exchange.json", 8_000_000, 20_000);
      if (res.status === 200) {
        const fresh = buildCikMap(JSON.parse(res.text) as { fields?: string[]; data?: unknown[][] }, universe);
        if (Object.keys(fresh).length > 1000) {
          map = fresh;
          await pool.query(`update public.filing_sweep_state set ciks = $1::jsonb, ciks_at = now(), updated_at = now() where id = 1`, [JSON.stringify(map)]);
          log(`CIK map refreshed: ${Object.keys(map).length} companies`);
        }
      }
    }
    result.ciks = Object.keys(map).length;
    if (!result.ciks) return result;

    // Latest-filings feeds.
    if (opts.live && !stop()) {
      const per = 4;
      const rotating = opts.allFeeds ? FEEDS_ROTATING : Array.from({ length: per }, (_, i) => FEEDS_ROTATING[(state.feed_cursor + i) % FEEDS_ROTATING.length]!);
      const found: Candidate[] = [];
      for (const type of [...FEEDS_ALWAYS, ...rotating]) {
        if (stop()) break;
        const res = await edgar.get(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}&company=&dateb=&owner=include&start=0&count=100&output=atom`, 2_000_000);
        result.feeds++;
        if (res.status !== 200) continue;
        const byAcc = new Map<string, Candidate>();
        for (const e of parseAtom(res.text)) {
          if (!FILING_FORMS.has(e.form) || !e.acceptedAt) continue;
          if (is13D(e.form) && !/subject/i.test(e.role)) continue;
          const c = byAcc.get(e.accession) ?? { accession: e.accession, form: e.form, ciks: [], acceptedAt: e.acceptedAt, items: e.items };
          c.ciks.push(e.cik);
          byAcc.set(e.accession, c);
        }
        found.push(...byAcc.values());
      }
      if (!opts.allFeeds) {
        await pool.query(`update public.filing_sweep_state set feed_cursor = $1, updated_at = now() where id = 1`, [(state.feed_cursor + per) % FEEDS_ROTATING.length]);
      }
      result.inserted += await insertPending(pool, map, found);
    }

    // Daily form indexes: backfill and gap healing.
    const done = new Set(state.index_days ?? []);
    const today = nyToday();
    for (const day of indexDaysToRead(today, KEEP_FILING_DAYS, done).slice(0, opts.indexDays)) {
      if (stop()) break;
      const ymd = day.replace(/-/g, "");
      const res = await edgar.get(`https://www.sec.gov/Archives/edgar/daily-index/${day.slice(0, 4)}/${quarter(day)}/form.${ymd}.idx`, 8_000_000, 30_000);
      const age = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000;
      if (res.status === 200) {
        const entries = parseFormIndex(res.text);
        const byAcc = new Map<string, Candidate>();
        const oldest = indexDaysToRead(today, KEEP_FILING_DAYS, new Set()).at(-1)!;
        for (const e of entries) {
          // Late or re-disseminated filings carry an old filing date: skip those past retention.
          if (e.date < oldest) continue;
          const [y, m, d] = e.date.split("-").map(Number);
          const c = byAcc.get(e.accession) ?? { accession: e.accession, form: e.form, ciks: [], acceptedAt: nyTime(y!, m!, d!, 12), items: [] };
          c.ciks.push(e.cik);
          byAcc.set(e.accession, c);
        }
        const n = await insertPending(pool, map, [...byAcc.values()]);
        result.inserted += n;
        log(`Daily index ${day}: ${byAcc.size} filings of the covered forms, ${n} new`);
      } else if (!(res.status === 404 && age >= 3)) {
        // Not published yet (yesterday's index can come late): try again next batch.
        continue;
      }
      done.add(day);
      result.indexDays.push(day);
      const keep = [...done].filter((d) => d >= indexDaysToRead(today, KEEP_FILING_DAYS + 10, new Set()).at(-1)!).sort();
      await pool.query(`update public.filing_sweep_state set index_days = $1, updated_at = now() where id = 1`, [keep]);
    }

    // Enrich pending rows, newest first.
    while (!stop()) {
      const { rows } = await pool.query<Pending>(
        `select id, accession, cik, company, symbols, form, items, published_at, enrich_tries
           from public.news_filings
          where enriched_at is null and enrich_tries < $1
          order by published_at desc
          limit 40`,
        [MAX_TRIES],
      );
      if (!rows.length) break;
      // A few filings at once: EdgarClient still starts requests gapMs apart.
      let next = 0;
      let limited: EdgarLimited | null = null;
      const worker = async () => {
        while (next < rows.length && !limited && !stop()) {
          const row = rows[next++]!;
          try {
            const r = await enrich(pool, edgar, map, row);
            result[r]++;
          } catch (err) {
            if (err instanceof EdgarLimited) {
              limited = err;
              return;
            }
            result.failed++;
            log(`${row.accession}: ${err instanceof Error ? err.message : String(err)}`);
          }
          const handled = result.enriched + result.dropped + result.failed;
          if (handled % 200 === 0) log(`${handled} filings handled (${result.enriched} enriched, ${result.dropped} dropped, ${result.failed} failed), now at ${row.published_at.toISOString().slice(0, 10)}`);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, opts.workers ?? 1) }, worker));
      if (limited) throw limited;
      if (!(await renew(pool, opts))) {
        result.stoppedBy = "lease";
        log("Lease lost to another sweeper");
        return result;
      }
    }
  } catch (err) {
    if (err instanceof EdgarLimited) {
      result.stoppedBy = "limit";
      log(err.message);
    } else if (opts.signal?.aborted) result.stoppedBy = "signal";
    else throw err;
  } finally {
    result.calls = edgar.calls;
    const p = await pool
      .query<{ n: string }>(`select count(*) as n from public.news_filings where enriched_at is null and enrich_tries < $1`, [MAX_TRIES])
      .catch(() => ({ rows: [{ n: "0" }] }));
    result.pending = Number(p.rows[0]?.n ?? 0);
  }
  return result;
}
