/**
 * The keyword locator for graph extraction (design 4.2, step 2): cuts an
 * annual report to the paragraphs that can name a customer, supplier,
 * competitor or partner, so the extraction model reads about 15k tokens of
 * a 100k-token filing. Each passage keeps the Item it sits under, which the
 * edge records as its section. Pure.
 *
 * Priority (strong evidence first, so a cap drops the weak end):
 *   3  concentration: a customer at N% of revenue, sole / single source,
 *      major or largest customers, "accounted for N%";
 *   2  named relations: "customers include", "we compete with", supply,
 *      license, distribution, collaboration and joint venture agreements;
 *   1  any other paragraph of Items 1, 1A, 7 and 8 (20-F: 3, 4, 5, 18) that
 *      says customer, supplier, competitor or partner.
 * Items 10 to 15 (directors, pay, exhibits) and 20-F Items 6, 7 and 19 are
 * skipped: a director biography or an exhibit title names companies that are
 * not business links.
 */

export type Passage = {
  section: string;
  /** A short heading line just above ("Customers", "Competition"); a label, not part of `text`. */
  heading: string;
  text: string;
  priority: 1 | 2 | 3;
  line: number;
};

export type LocatorStats = { lines: number; candidates: number; kept: number; keptChars: number; byPriority: Record<1 | 2 | 3, number> };

const ITEM_HEADING = /^(?:part\s+[iv]+\s*[,.:\-–|]?\s*)?item\s*(\d{1,2})(?:([a-c])|\(([a-c])\))?(?=[\s.:\-–|]|$)/i;

/** The Item a heading line opens ("Item 1A. Risk Factors", "Item 1-Business", "Item 1(a)." -> "1A" / "1" / "1A"), or null. Pure. */
export function itemOf(line: string): string | null {
  if (line.length > 220) return null;
  const m = ITEM_HEADING.exec(line.trim());
  return m ? `${m[1]}${(m[2] ?? m[3] ?? "").toUpperCase()}` : null;
}

/** Items whose paragraphs can carry business links (10-K and 20-F numbering). */
const KEEP_10K = new Set(["1", "1A", "1C", "2", "3", "7", "7A", "8"]);
const KEEP_20F = new Set(["3", "4", "4A", "5", "8", "11", "18"]);

const STRONG = [
  /\b(?:\d{1,2}(?:\.\d+)?|ten|fifteen|twenty)\s?(?:%|percent)\b[^.]{0,160}\b(?:revenue|revenues|sales|net sales|receivables?|purchases)\b/i,
  /\b(?:revenue|revenues|sales|net sales|receivables?|purchases)\b[^.]{0,160}\b\d{1,2}(?:\.\d+)?\s?(?:%|percent)\b/i,
  /\baccounted for (?:approximately |about |more than |over |less than )?\d{1,2}(?:\.\d+)?\s?(?:%|percent)/i,
  /\b(?:sole|single)[- ](?:source|supplier|sourced|manufacturer|provider)/i,
  /\b(?:major|largest|significant|principal|key) customers?\b/i,
  /\bconcentration of (?:credit risk|customers?|revenue|sales)\b/i,
  /\blimited number of (?:suppliers|customers|manufacturers|vendors)\b/i,
];

const NAMED = [
  /\bcustomers? (?:include|included|including|such as|are)\b/i,
  /\b(?:suppliers?|vendors?|manufacturers?|foundries|partners?) (?:include|included|including|such as)\b/i,
  /\bcompet\w*\b[^.]{0,120}\b(?:with|against|from|include|includes|including|such as)\b/i,
  // A capitalized list after "such as" / "including": "manufacturers such as Boeing, Airbus".
  /\b(?:such as|including|include|includes|namely)\s+(?:the\s+)?[A-Z][A-Za-z0-9&.'-]+(?:,|\s+and\s+|\s+[A-Z(])/,
  /\b[A-Z][A-Za-z0-9&'-]+,? (?:Inc|Corp|Corporation|Ltd|LLC|N\.V|AG|plc|S\.A|Co)\b/,
  /\b(?:competitors|competition) (?:include|includes|including|such as|from)\b/i,
  /\b(?:primary|principal|main|major|key|significant) competitors?\b/i,
  /\b(?:supply|purchase|license|licensing|distribution|collaboration|co-promotion|joint development|manufacturing|offtake|charter|services) agreements?\b/i,
  /\bjoint ventures?\b/i,
  /\b(?:strategic )?(?:partnership|alliance|collaboration) with\b/i,
  /\b(?:sell|sells|sold) (?:to|through)\b/i,
  /\b(?:rely|relies|depend|depends|dependent) (?:on|upon)\b/i,
];

const MENTION = /\b(?:customers?|suppliers?|vendors?|compet\w*|partners?|distributors?|licens\w*|collaborat\w*|foundr(?:y|ies)|manufacturers?|OEMs?|wholesalers?|retailers?|airlines?|carriers?|contractors?)\b/i;

/** At least one capitalized name-like word that is not the first word of the sentence. */
const PROPER = /[a-z,;:)]\s+(?:[A-Z][A-Za-z0-9&.'-]+|[A-Z]{2,})/;

function priorityOf(text: string): 1 | 2 | 3 | 0 {
  if (!PROPER.test(text)) return STRONG.some((r) => r.test(text)) ? 3 : 0;
  if (STRONG.some((r) => r.test(text))) return 3;
  if (NAMED.some((r) => r.test(text))) return 2;
  return MENTION.test(text) ? 1 : 0;
}

/**
 * Paragraphs from lines: some filings (Halliburton's) print every visual
 * line as its own block, so a sentence runs over several lines. A line that
 * does not end a sentence, or is followed by one starting in lower case,
 * is joined with the next. Table rows and Item headings are never joined.
 * Joining only adds spaces, so quotes still match the filing. Pure.
 */
export function reflow(lines: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes(" | ") || itemOf(line)) {
      flush();
      out.push(line);
      continue;
    }
    if (buf && buf.length >= 60 && (!/[.!?:;"”)]$/.test(buf) || /^[a-z]/.test(line)) && buf.length < 6000) {
      buf = `${buf} ${line}`;
    } else {
      flush();
      buf = line;
    }
  }
  flush();
  return out;
}

/**
 * Passages of an annual report's text (one paragraph per line, as
 * `htmlToText` writes it) worth sending to the extraction model, in
 * document order, at most `maxChars` in all (highest priority kept first).
 * `form` picks the Item numbering (20-F differs from 10-K). A filing whose
 * Item headings cannot be found, or cover almost nothing, is read whole. Pure.
 */
export function locateLinkPassages(text: string, form: string, maxChars = 60_000): { passages: Passage[]; stats: LocatorStats } {
  const lines = reflow(text.split("\n"));
  const keep = /^20-F/i.test(form) ? KEEP_20F : KEEP_10K;
  const sections: string[] = [];
  let current = "";
  let headings = 0;
  for (const line of lines) {
    const item = itemOf(line);
    if (item) {
      current = item;
      headings++;
    }
    sections.push(current);
  }
  // Read whole when the Items cannot be trusted: too few headings, or the
  // business Items hold under a tenth of the text (ASML's 20-F puts the Item
  // index up front and its own chapters after it, all under "Item 19").
  let keptChars = 0;
  let allChars = 0;
  lines.forEach((l, i) => {
    allChars += l.length;
    if (sections[i] === "" || keep.has(sections[i]!)) keptChars += l.length;
  });
  const readAll = headings < 3 || keptChars < allChars * 0.1;
  const candidates: Passage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length < 60 || itemOf(line)) continue;
    const item = sections[i]!;
    // Text before the first Item heading is read too: some reports (Intel's) keep
    // the Item index at the back and their own headings in front.
    if (!readAll && item !== "" && !keep.has(item)) continue;
    const p = priorityOf(line);
    if (p === 0) continue;
    // A heading-like line just above ("Customers", "Competition") tells the model what the list is.
    const prev = lines[i - 1];
    const heading = prev && prev.length < 90 && !prev.includes("|") && !itemOf(prev) && !/[.;:]$/.test(prev.trim()) ? prev.trim() : "";
    candidates.push({ section: readAll || item === "" ? "unknown" : `Item ${item}`, heading, text: line.length > 4000 ? line.slice(0, 4000) : line, priority: p, line: i });
  }
  const order = [...candidates].sort((a, b) => b.priority - a.priority || a.line - b.line);
  const chosen = new Set<Passage>();
  let used = 0;
  for (const c of order) {
    if (used + c.text.length > maxChars) continue;
    chosen.add(c);
    used += c.text.length + 1;
  }
  const passages = candidates.filter((c) => chosen.has(c));
  const byPriority = { 1: 0, 2: 0, 3: 0 } as Record<1 | 2 | 3, number>;
  for (const p of passages) byPriority[p.priority]++;
  return { passages, stats: { lines: lines.length, candidates: candidates.length, kept: passages.length, keptChars: used, byPriority } };
}

/**
 * Passages split into model calls of at most `maxChars` each, every passage
 * prefixed with its section label. Pure.
 */
export function chunkPassages(passages: Passage[], maxChars = 15_000): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const p of passages) {
    const s = `[${p.section}${p.heading ? ` > ${p.heading}` : ""}] ${p.text}`;
    if (size + s.length > maxChars && buf.length) {
      out.push(buf.join("\n\n"));
      buf = [];
      size = 0;
    }
    buf.push(s);
    size += s.length + 2;
  }
  if (buf.length) out.push(buf.join("\n\n"));
  return out;
}
