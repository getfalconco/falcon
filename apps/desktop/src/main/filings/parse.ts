/**
 * Reading an SEC filing's HTML mechanically: no model, nothing inferred.
 *
 *   htmlBlocks        the document as a list of blocks (paragraphs, table
 *                     rows), each with how much of its text is set in bold,
 *                     italic or underline, and the nearest anchor id
 *   findSection       an item of the filing (Item 1A, Item 9A) by its own
 *                     heading, the table of contents skipped
 *   riskHeadings      the emphasised sub-headings inside Item 1A: the risk
 *                     factors as the company titles them, verbatim
 *   red-flag readers  going concern language, material weakness language,
 *                     the auditor's name, customer concentration sentences,
 *                     sole or single source sentences
 *
 * Every reader returns text exactly as the filing prints it (entities decoded,
 * whitespace collapsed), so what Falcon shows can be found in the filing.
 * Pure: no fs, no network.
 */

export type Block = {
  /** The block's text, whitespace collapsed. */
  text: string;
  /** Share of the block's non-space characters set in bold, italic or underline, 0 to 1. */
  emph: number;
  /** The emphasised run the block opens with ("Heading." followed by body text), or null. */
  lead: string | null;
  /** The nearest element id (or `<a name>`) at or before the block: the link target for its section. */
  anchor: string | null;
};

const BLOCK_TAGS = new Set(["p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tbody", "thead", "ul", "ol", "section", "article", "blockquote", "center", "pre", "dd", "dt", "body", "html", "page"]);
const VOID_TAGS = new Set(["br", "img", "hr", "meta", "input", "link", "col", "area", "base", "wbr", "source", "param", "embed"]);
const SKIP_TAGS = new Set(["script", "style", "head", "title", "ix:header", "xbrli:context", "noscript"]);
const CELL_TAGS = new Set(["td", "th"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  bull: "\u2022",
  middot: "\u00b7",
  reg: "\u00ae",
  trade: "\u2122",
  copy: "\u00a9",
  sect: "\u00a7",
  eacute: "\u00e9",
  egrave: "\u00e8",
  uuml: "\u00fc",
  ouml: "\u00f6",
  auml: "\u00e4",
  ccedil: "\u00e7",
  shy: "",
  zwsp: "",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return " ";
      if (code === 160 || code === 8194 || code === 8195 || code === 8201) return " ";
      if (code === 173 || code === 8203) return "";
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? m;
  });
}

type Frame = { tag: string; bold: boolean | null; italic: boolean | null; underline: boolean | null; hidden: boolean };

function styleOf(tag: string, attrs: string): Omit<Frame, "tag"> {
  let bold: boolean | null = tag === "b" || tag === "strong" || /^h[1-6]$/.test(tag) ? true : null;
  let italic: boolean | null = tag === "i" || tag === "em" ? true : null;
  let underline: boolean | null = tag === "u" ? true : null;
  let hidden = false;
  const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const css = (style?.[1] ?? style?.[2] ?? "").toLowerCase();
  if (css) {
    const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(css)?.[1];
    if (weight) bold = weight === "bold" || weight === "bolder" || (/^\d+$/.test(weight) && Number(weight) >= 600);
    const fontStyle = /font-style\s*:\s*([a-z]+)/.exec(css)?.[1];
    if (fontStyle) italic = fontStyle === "italic" || fontStyle === "oblique";
    const deco = /text-decoration(?:-line)?\s*:\s*([a-z -]+)/.exec(css)?.[1];
    if (deco) underline = /underline/.test(deco);
    if (/display\s*:\s*none/.test(css)) hidden = true;
  }
  return { bold, italic, underline, hidden };
}

/**
 * The document as blocks. A hand-rolled tokenizer rather than a DOM: a 10-K
 * runs to ten megabytes of inline XBRL, its tags are often unbalanced, and all
 * that is needed is each text run with the emphasis it inherits.
 */
export function htmlBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const stack: Frame[] = [];
  let parts: { text: string; emph: boolean }[] = [];
  let lastAnchor: string | null = null;
  let blockAnchor: string | null = null;
  let skipUntil: string | null = null;

  const flush = () => {
    if (parts.length === 0) return;
    const raw = parts.map((p) => p.text).join("");
    const text = raw.replace(/\s+/g, " ").trim();
    if (text) {
      let total = 0;
      let emph = 0;
      for (const p of parts) {
        const n = p.text.replace(/\s+/g, "").length;
        total += n;
        if (p.emph) emph += n;
      }
      let lead: string | null = null;
      if (parts[0] && (parts[0].emph || parts[0].text.trim() === "")) {
        let run = "";
        for (const p of parts) {
          if (p.emph || p.text.trim() === "") run += p.text;
          else break;
        }
        const leadText = run.replace(/\s+/g, " ").trim();
        if (leadText && leadText.length < text.length) lead = leadText;
      }
      blocks.push({ text, emph: total === 0 ? 0 : emph / total, lead, anchor: blockAnchor ?? lastAnchor });
    }
    parts = [];
    blockAnchor = null;
  };

  const effective = (): { emph: boolean; hidden: boolean } => {
    let bold: boolean | null = null;
    let italic: boolean | null = null;
    let underline: boolean | null = null;
    let hidden = false;
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]!;
      if (f.hidden) hidden = true;
      if (bold === null && f.bold !== null) bold = f.bold;
      if (italic === null && f.italic !== null) italic = f.italic;
      if (underline === null && f.underline !== null) underline = f.underline;
    }
    return { emph: bold === true || italic === true || underline === true, hidden };
  };

  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!?[a-zA-Z/][^>]*>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const token = m[0];
    if (token[0] !== "<" || token === "<") {
      if (skipUntil) continue;
      const { emph, hidden } = effective();
      if (hidden) continue;
      const text = decodeEntities(token);
      if (text) parts.push({ text, emph });
      continue;
    }
    if (token.startsWith("<!")) continue;
    const tm = /^<(\/?)([a-zA-Z][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!tm) continue;
    const closing = tm[1] === "/";
    const tag = tm[2]!.toLowerCase();
    const attrs = tm[3] ?? "";
    const selfClosing = tm[4] === "/";

    if (skipUntil) {
      if (closing && tag === skipUntil) skipUntil = null;
      continue;
    }
    if (!closing && SKIP_TAGS.has(tag) && !selfClosing) {
      skipUntil = tag;
      continue;
    }

    if (!closing) {
      const id = /\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
      if (id && (tag !== "meta" && tag !== "input")) {
        lastAnchor = id[1] ?? id[2] ?? lastAnchor;
        if (parts.length === 0) blockAnchor = lastAnchor;
      }
    }

    if (tag === "br") {
      flush();
      continue;
    }
    if (BLOCK_TAGS.has(tag)) flush();
    if (CELL_TAGS.has(tag) && closing) parts.push({ text: " ", emph: false });

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (VOID_TAGS.has(tag) || selfClosing) continue;
    stack.push({ tag, ...styleOf(tag, attrs) });
    // A runaway stack (an unclosed tag repeated thousands of times) is trimmed from the bottom.
    if (stack.length > 400) stack.splice(0, stack.length - 400);
  }
  flush();
  return blocks;
}

/** Lower case, letters and digits only, a trailing page number dropped: for matching item headings. */
export function headingKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    // A trailing page number goes; the number of "Item 4" stays.
    .replace(/^(?!(?:part [iv]+ )?item \d{1,2}[a-d]?$)(.*\S)\s+\d{1,3}$/, "$1")
    .trim();
}

export type SectionKind = "risk" | "controls";

export type Section = {
  /** Index of the first block after the section's own heading. */
  start: number;
  /** Index one past the section's last block. */
  end: number;
  anchor: string | null;
  /** Characters of text between the heading and the next item. */
  chars: number;
};

const ITEM_RE = /^(?:part [iv]+ )?item \d{1,2}[a-d]?\b/;

/** How many blocks the section's heading spans at `i` (0 when it is not that heading). */
function headingAt(blocks: readonly Block[], i: number, kind: SectionKind): number {
  const text = blocks[i]!.text;
  if (text.length > 120) return 0;
  const k = headingKey(text);
  if (kind === "risk") {
    if (/^(?:part [iv]+ )?item 1a risk factors$/.test(k)) return 1;
    if (/^(?:item 3 )?(?:key information )?d risk factors$/.test(k)) return 1;
    if (/^item 3d risk factors$/.test(k)) return 1;
    if (/^(?:part [iv]+ )?item 1a$/.test(k) && blocks[i + 1] && /^risk factors$/.test(headingKey(blocks[i + 1]!.text))) return 2;
    if (/^d$/.test(k) && blocks[i + 1] && /^risk factors$/.test(headingKey(blocks[i + 1]!.text))) return 2;
    // A 20-F often titles the sub-item "Risk Factors" alone, under "Item 3. Key Information".
    if (k === "risk factors") return 1;
    return 0;
  }
  if (/^(?:part [iv]+ )?item (?:9a|4|15) controls and procedures$/.test(k)) return 1;
  if (k === "controls and procedures") return 1;
  if (/^(?:part [iv]+ )?item (?:9a|4|15)$/.test(k) && blocks[i + 1] && /^controls and procedures$/.test(headingKey(blocks[i + 1]!.text))) return 2;
  return 0;
}

function isItemBoundary(block: Block, kind: SectionKind): boolean {
  if (block.text.length > 140) return false;
  const k = headingKey(block.text);
  if (!ITEM_RE.test(k)) return false;
  if (kind === "risk" && /^(?:part [iv]+ )?item 1a\b/.test(k)) return false;
  if (kind === "controls" && /^(?:part [iv]+ )?item (?:9a|4|15)\b(?! [a-z]*\s*mine)/.test(k) && /controls/.test(k)) return false;
  return true;
}

/**
 * The section whose heading opens the longest run of text before the next
 * item heading. The table of contents names the same item, but the next
 * item follows it at once, so the longest run is the body.
 */
export function findSection(blocks: readonly Block[], kind: SectionKind): Section | null {
  let best: Section | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const span = headingAt(blocks, i, kind);
    if (span === 0) continue;
    const start = i + span;
    let end = start;
    let chars = 0;
    while (end < blocks.length && !isItemBoundary(blocks[end]!, kind)) {
      chars += blocks[end]!.text.length;
      end++;
    }
    if (!best || chars > best.chars) best = { start, end, anchor: blocks[i]!.anchor, chars };
  }
  return best && best.chars > 0 ? best : null;
}

export type RiskHeading = {
  /** The heading as the filing prints it. */
  text: string;
  /** The group heading above it ("Risks Related to Our Business"), when the filing has one. */
  group: string | null;
};

const MIN_RISK_WORDS = 6;
const MAX_HEADING_CHARS = 900;

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

/** Running headers, page numbers and navigation the converter left in the body. */
function isPageArtifact(text: string): boolean {
  const k = headingKey(text);
  if (k === "" || /^\d+$/.test(k)) return true;
  if (/^(table of contents|index|back to contents|return to table of contents|page \d+|part [iv]+|risk factors( continued)?)$/.test(k)) return true;
  return false;
}

/** A group heading ("Risks Related to Our Business", "General Risks"), not a risk factor. */
export function isGroupHeading(text: string): boolean {
  if (/[.?!]["\u201d]?$/.test(text)) return false;
  const words = wordCount(text);
  if (words < MIN_RISK_WORDS) return true;
  return (
    words <= 16 &&
    (/(?:^|\s)risks?$/i.test(text) ||
      /^(?:summary of )?(?:risks?|risk factors) (?:related|relating|associated|regarding|concerning|specific|pertaining|in connection|that relate)\b/i.test(text))
  );
}

/**
 * The risk factor headings inside Item 1A: blocks set wholly in bold, italic
 * or underline (or opening with such a run that ends a sentence), long enough
 * to be a sentence. Shorter emphasised lines are the group headings and are
 * kept as each heading's `group`.
 */
export function riskHeadings(blocks: readonly Block[], section: Section): RiskHeading[] {
  const out: RiskHeading[] = [];
  const seen = new Set<string>();
  let group: string | null = null;
  for (let i = section.start; i < section.end; i++) {
    const b = blocks[i]!;
    if (isPageArtifact(b.text)) continue;
    let candidate: string | null = null;
    if (b.emph >= 0.85 && b.text.length <= MAX_HEADING_CHARS) {
      candidate = b.text;
      // A filing set one printed line per block (converted from print) splits a
      // heading over several blocks: join emphasised lines until one ends a sentence.
      while (i + 1 < section.end) {
        const next = blocks[i + 1]!;
        if (next.emph < 0.85 || isPageArtifact(next.text) || candidate.length + next.text.length > MAX_HEADING_CHARS) break;
        // A line that opens in lower case continues the one above, even after "R.O.C.".
        if (!/^[a-z]/.test(next.text)) {
          if (/[.?!:]["\u201d)]?$/.test(candidate)) break;
          if (/^[A-Z]/.test(next.text) && isGroupHeading(candidate)) break;
        }
        candidate = `${candidate} ${next.text}`;
        i++;
      }
    } else if (b.lead && b.lead.length >= 30 && b.lead.length <= MAX_HEADING_CHARS && /[.?!:]["\u201d]?$/.test(b.lead)) candidate = b.lead;
    // A heading opens a sentence; a run that starts in lower case is the tail of a body line.
    if (!candidate || !/^["\u201c(]?[A-Z0-9]/.test(candidate)) continue;
    if (isGroupHeading(candidate)) {
      if (candidate.length <= 160) group = candidate;
      continue;
    }
    const key = normalizeHeading(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: candidate, group });
  }
  return out;
}

/**
 * A heading reduced to what its words say: lower case, quotes and punctuation
 * dropped, years and numbers made alike (a heading that only moves "fiscal
 * 2025" to "fiscal 2026" says the same thing).
 */
export function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d'"]/g, "")
    .replace(/[\u00ae\u2122\u00a9]/g, "")
    .replace(/\b(?:19|20)\d{2}\b/g, "#")
    .replace(/\d+(?:[.,]\d+)*/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .trim();
}

/** The text of blocks [start, end) as one string, one block per line. */
export function sectionText(blocks: readonly Block[], section: Section | null): string {
  if (!section) return "";
  return blocks
    .slice(section.start, section.end)
    .map((b) => b.text)
    .join("\n");
}

/** Sentences of `text`, at most `max` characters each. */
export function sentences(text: string, max = 1200): string[] {
  return text
    // A filing set one printed line per block: a line that runs on into lower case is one sentence.
    .replace(/([^.!?:;\n])\n+(?=[a-z(])/g, "$1 ")
    .split(/\n+|(?<=[.!?])["\u201d]?\s+(?=["\u201c(]?[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= max);
}

const NO_MATERIAL_CHANGES_RE =
  /\b(?:there (?:have|has) been no material changes?|no material changes? (?:to|in|from) (?:the|our|its) risk factors|(?:have|has) not (?:materially )?changed materially|risk factors (?:have|has) not materially changed)/i;

/** Whether a 10-Q's Item 1A says the annual report's risk factors stand. */
export function saysNoMaterialChanges(text: string): boolean {
  return NO_MATERIAL_CHANGES_RE.test(text);
}

const CONDITIONAL_RE = /\b(?:whether|if|could|would|might|may|in the event|evaluat\w*|assess\w*|unless|absent)\b/i;

/**
 * A sentence stating substantial doubt about the company's ability to continue
 * as a going concern, or the auditor's "prepared assuming ... going concern"
 * paragraph. Policy text ("management evaluates whether conditions raise
 * substantial doubt") is conditional and does not count.
 */
export function goingConcernSentence(text: string): string | null {
  for (const s of sentences(text, 900)) {
    if (!/going concern/i.test(s)) continue;
    const doubt = /substantial doubt (?:about|regarding|as to|on|concerning)[^.]{0,80}abilit(?:y|ies) to continue as a going concern/i.test(s);
    const assumed = /(?:have|has) been prepared assuming that the (?:company|entity|group|partnership|trust)[^.]{0,40} (?:will )?continue as a going concern/i.test(s);
    if (!doubt && !assumed) continue;
    if (/\b(?:no|not|alleviat\w*)\b[^.]{0,40}substantial doubt|substantial doubt[^.]{0,80}\b(?:alleviated|does not exist|did not exist)\b/i.test(s)) continue;
    if (doubt && CONDITIONAL_RE.test(s)) continue;
    return s;
  }
  return null;
}

/**
 * A sentence in the controls item stating a material weakness exists or
 * controls were not effective. Conditional or negated sentences ("did not
 * identify any material weakness", "a material weakness could") do not count.
 */
export function materialWeaknessSentence(controlsText: string): string | null {
  for (const s of sentences(controlsText, 900)) {
    const notEffective = /(?:internal control over financial reporting|disclosure controls and procedures)[^.]{0,80}\b(?:was|were) not effective/i.test(s);
    const weakness = /material weakness(?:es)?/i.test(s) && /\b(?:identified|existed|exists|exist|resulted in|constitutes?|constituted|represents?|represented|was|were|is|are|due to|because of)\b/i.test(s);
    if (!notEffective && !weakness) continue;
    if (/\b(?:no material weakness|not identif\w+|did not identify|have not identified|were no material|was not a material|absence of|remediated)\b/i.test(s) && !notEffective) continue;
    if (/\b(?:not|no)\b[^.]{0,30}\bmaterial weakness/i.test(s) && !notEffective) continue;
    if (CONDITIONAL_RE.test(s) && !notEffective) continue;
    return s;
  }
  return null;
}

const FIRM_SUFFIX = "(?:LLP|L\\.L\\.P\\.|LLC|P\\.C\\.|PLLC|Ltd\\.?|Limited|AG|GmbH|S\\.A\\.|N\\.V\\.|plc|Inc\\.|& Co\\.|Accountants)";

/**
 * The auditor as the filing names it: the cover's tagged AuditorName (every
 * 10-K since 2021 carries it), else the signature under the auditor's report.
 */
export function auditorName(html: string, text: string): string | null {
  const tagged = /<ix:nonnumeric[^>]*name\s*=\s*"dei:AuditorName"[^>]*>([\s\S]*?)<\/ix:nonnumeric>/i.exec(html);
  if (tagged) {
    // Inline runs join as they read ("<span>Pric</span><span>ewaterhouse...", a
    // 20-F laid out from a PDF); only a block or a line break parts words.
    const inner = tagged[1]!.replace(/<(?:br|\/?(?:div|p|td|th|tr|li|table))\b[^>]*>/gi, " ").replace(/<[^>]+>/g, "");
    const name = decodeEntities(inner).replace(/\s+/g, " ").trim();
    if (name) return name;
  }
  const at = text.search(/report of independent registered public accounting firm/i);
  const tail = at >= 0 ? text.slice(at) : text;
  const sig = new RegExp(`/s/\\s*([A-Z][A-Za-z&.,' -]{1,80}?${FIRM_SUFFIX})`).exec(tail);
  return sig ? sig[1]!.replace(/\s+/g, " ").trim() : null;
}

/** "PricewaterhouseCoopers LLP" and "PricewaterhouseCoopers, LLP" are one firm. */
export function sameAuditor(a: string, b: string): boolean {
  const key = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(?:llp|l l p|llc|pc|p c|pllc|ltd|limited|ag|gmbh|sa|nv|plc|inc|co)\b/g, " ")
      .replace(/[^a-z]+/g, "");
  return key(a) === key(b);
}

export type ConcentrationFact = {
  /** Who: a name ("Apple") or the filing's own words ("One customer", "Customer A"). */
  label: string;
  /** The first percentage the sentence gives for that label: the latest year in the usual layout. */
  pct: number;
  /** What the share is of. */
  basis: "revenue" | "receivables";
  /** The sentence, verbatim. */
  quote: string;
};

const GENERIC_LABEL_RE =
  /^(?:one|two|three|a single|a|our largest|our two largest|our three largest|our top|the largest|no single|no one|no other|any single|each of two|each of three)?\s*(?:customers?|distributors?|resellers?|clients?|end customers?|customer [a-z0-9])$/i;

const GENERIC_TAIL_RE =
  /((?:one|two|three|a single|our largest|our two largest|our three largest|the largest|no single)\s+(?:end\s+)?(?:customers?|distributors?|resellers?|clients?)|customer\s+[A-Z0-9])$/i;

/**
 * The name at the end of a matched run: "In fiscal 2025 sales to Apple"
 * gives "Apple", "of which one customer" gives "one customer". A name is the
 * last run of capitalised words ("&" and "of" may join them).
 */
export function tailLabel(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim().replace(/[,;:]+$/, "");
  // "Customers A" (the first of "Customers A, B and C") is "Customer A".
  const lettered = /customers?\s+([A-Z0-9])$/i.exec(text);
  if (lettered) return `Customer ${lettered[1]!.toUpperCase()}`;
  const generic = GENERIC_TAIL_RE.exec(text);
  if (generic) return generic[1]!.charAt(0).toUpperCase() + generic[1]!.slice(1);
  const words = text.split(" ");
  const kept: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]!;
    if (/^[A-Z0-9][\w.&'\u2019-]*$/.test(w) && /[A-Za-z]/.test(w)) kept.unshift(w);
    else if ((w === "&" || w === "of") && kept.length > 0) kept.unshift(w);
    else break;
  }
  while (kept.length > 0 && (kept[0] === "&" || kept[0] === "of")) kept.shift();
  // "customers in the United States" is a place, not a customer.
  const before = words.slice(0, words.length - kept.length).filter((w) => !/^the$/i.test(w));
  if (before.slice(-2).some((w) => /^(?:in|within|outside|across|throughout|located)$/i.test(w))) return "";
  // A sentence opener ("Sales", "Revenue", "In") is not a name.
  while (kept.length > 0 && /^(?:sales|revenues?|net|direct|in|during|for|fiscal|the|our|we|customers?)$/i.test(kept[0]!)) kept.shift();
  return kept.join(" ");
}

function splitNames(group: string): string[] {
  const names = group
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((s) => tailLabel(s))
    .filter(Boolean);
  // "Customers A, B and C": the letters after the first are customers too.
  if (/^Customer [A-Z0-9]$/.test(names[0] ?? "")) return names.map((n) => (/^[A-Z0-9]$/.test(n) ? `Customer ${n}` : n));
  return names;
}

/**
 * Customer concentration sentences: "Sales to Apple accounted for 18% of net
 * revenue", "One customer represented approximately 12% of revenue", and the
 * "A and B accounted for 29.8% and 11.1% of our net sales, respectively"
 * shape. Shares under 10% are left out (the disclosure threshold).
 */
export function concentrationFacts(text: string): ConcentrationFact[] {
  const out: ConcentrationFact[] = [];
  const seen = new Set<string>();
  const add = (label: string, pct: number, basis: ConcentrationFact["basis"], quote: string) => {
    if (!Number.isFinite(pct) || pct < 10 || pct > 100) return;
    const clean = tailLabel(label);
    if (!clean || clean.length > 60 || wordCount(clean) > 6) return;
    if (!GENERIC_LABEL_RE.test(clean) && !/^[A-Z0-9]/.test(clean)) return;
    if (/^(?:no single|no one|no other|any single)/i.test(clean)) return;
    const key = `${labelKey(clean)}|${basis}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: clean, pct, basis, quote });
  };
  const PCT_RE = /(\d{1,2}(?:\.\d{1,2})?)\s?%/g;
  // No quantified name group: the subject is read backwards from the verb, so nothing here can backtrack.
  const claim =
    /(?<![A-Za-z])(?:accounted for|represented|comprised|made up|constituted|were|was)\s+(?:approximately |about |roughly |an aggregate of |a total of |more than |over )?(\d{1,2}(?:\.\d{1,2})?\s?%(?:,?\s{0,3}(?:and\s+)?\d{1,2}(?:\.\d{1,2})?\s?%){0,4})\s+of\s+(?:our |the company['\u2019]s |its |the group['\u2019]s |total |net |consolidated |gross ){0,4}(net revenues?|revenues?|net sales|sales|total revenues?|accounts receivable|receivables|trade receivables)/gi;
  for (const s of sentences(text, 700)) {
    if (!/%/.test(s) || !/(revenue|sales|receivable)/i.test(s)) continue;
    claim.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = claim.exec(s)) !== null) {
      const basis: ConcentrationFact["basis"] = /receivable/i.test(m[2]!) ? "receivables" : "revenue";
      const pcts = [...m[1]!.matchAll(PCT_RE)].map((x) => Number(x[1]));
      const subject = s.slice(Math.max(0, m.index - 160), m.index).replace(/^.*[;:(]\s*/, "");
      if (pcts.length >= 2 && /respectively/i.test(s.slice(m.index))) {
        const names = splitNames(subject);
        if (names.length === pcts.length) {
          names.forEach((n, i) => add(n, pcts[i]!, basis, s));
          continue;
        }
      }
      // "Our two largest customers accounted for 29.8% and 11.1%": two shares, no one name to give either.
      if (pcts.length >= 2 && /(?:customers|distributors|resellers|clients)$/i.test(tailLabel(subject))) continue;
      add(subject, pcts[0]!, basis, s);
    }
  }
  return out;
}

/** A label reduced for matching across years: "Customer A" and "customer a" are one. */
export function labelKey(label: string): string {
  return companyKey(label);
}

/**
 * A company name reduced to the words that identify it: "Apple Inc." and
 * "Apple" are one, "Taiwan Semiconductor Manufacturing Company Limited" and
 * "Taiwan Semiconductor Manufacturing" are one.
 */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9& ]+/g, " ")
    .replace(/\b(?:inc|incorporated|corp|corporation|co|company|companies|ltd|limited|llc|l l c|lp|l p|plc|nv|n v|sa|s a|ag|se|gmbh|bv|holdings?|group|the|opco)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences naming a sole or single source supplier, verbatim. */
export function soleSourceSentences(text: string, max = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sentences(text, 700)) {
    if (!/\b(?:sole|single)[- ]source(?:d)?\b|\bsole suppliers?\b|\bsingle suppliers?\b|\bonly (?:one|a single) suppliers?\b/i.test(s)) continue;
    const key = normalizeHeading(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
