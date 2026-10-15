/**
 * Reading an SEC filing's HTML mechanically: no model, nothing inferred.
 *
 *   readDocument      the document as a list of blocks (paragraphs, table
 *                     rows), each with how much of its text is set in bold,
 *                     italic or underline, its font size, the nearest anchor
 *                     id and the in-document links it holds, plus where each
 *                     element id sits (htmlBlocks: the blocks alone)
 *   findSection       an item of the filing (Item 1A, Item 9A, a 20-F's
 *                     Item 3.D): through the table of contents' links when
 *                     it has them, else by the item's own heading
 *   riskHeadings      the emphasised sub-headings inside Item 1A: the risk
 *                     factors as the company titles them, verbatim
 *   riskReadability   whether a located section and its headings look like
 *                     risk factors at all (an integrated annual report can
 *                     defeat both readers: the guard keeps its tables and
 *                     exhibit titles from reaching the reader)
 *   red-flag readers  going concern language, material weakness language,
 *                     the auditor's name, customer concentration sentences,
 *                     sole or single source sentences
 *
 * Every reader returns text exactly as the filing prints it (entities decoded,
 * whitespace collapsed), so what Falcon shows can be found in the filing.
 * Pure: no fs, no network.
 */

import { LARGEST_CUSTOMER } from "../../shared/filing-changes";

export type Block = {
  /** The block's text, whitespace collapsed. */
  text: string;
  /** Share of the block's non-space characters set in bold, italic or underline, 0 to 1. */
  emph: number;
  /** The emphasised run the block opens with ("Heading." followed by body text), or null. */
  lead: string | null;
  /** The nearest element id (or `<a name>`) at or before the block: the link target for its section. */
  anchor: string | null;
  /** The smallest font size (pt) the block's text is set in, when inline styles size all of it. */
  size: number | null;
  /** The table row the block sits in (a running count), null outside a table. */
  row: number | null;
  /** In-document link targets (`<a href="#id">`) inside the block, null when none. */
  links: string[] | null;
};

/** The blocks, and the block each element id (or `<a name>`) opens at: where a table of contents link lands. */
export type Doc = { blocks: Block[]; ids: ReadonlyMap<string, number> };

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

type Frame = { tag: string; bold: boolean | null; italic: boolean | null; underline: boolean | null; hidden: boolean; size: number | null };

function styleOf(tag: string, attrs: string): Omit<Frame, "tag"> {
  let bold: boolean | null = tag === "b" || tag === "strong" || /^h[1-6]$/.test(tag) ? true : null;
  let italic: boolean | null = tag === "i" || tag === "em" ? true : null;
  let underline: boolean | null = tag === "u" ? true : null;
  let hidden = false;
  let size: number | null = null;
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
    // Absolute sizes only: a relative one (em, %) is left to what it inherits.
    const fs = /font-size\s*:\s*([\d.]+)\s*(pt|px)\b/.exec(css);
    if (fs) {
      const n = Number(fs[1]);
      if (Number.isFinite(n) && n > 0) size = fs[2] === "px" ? Math.round(n * 0.75 * 10) / 10 : n;
    }
  }
  return { bold, italic, underline, hidden, size };
}

/**
 * The document as blocks. A hand-rolled tokenizer rather than a DOM: a 10-K
 * runs to ten megabytes of inline XBRL, its tags are often unbalanced, and all
 * that is needed is each text run with the emphasis it inherits. The hidden
 * inline XBRL header (`ix:header`) is skipped; the `ix:` tags around visible
 * facts are read through.
 */
export function readDocument(html: string): Doc {
  const blocks: Block[] = [];
  const ids = new Map<string, number>();
  const stack: Frame[] = [];
  let parts: { text: string; emph: boolean; size: number | null }[] = [];
  let links: string[] | null = null;
  let lastAnchor: string | null = null;
  let blockAnchor: string | null = null;
  let skipUntil: string | null = null;
  // Open table rows, and how many were open when each open table began (an unclosed row ends with its table).
  const rows: number[] = [];
  const tables: number[] = [];
  let rowCount = 0;

  const flush = () => {
    // A link opened before the block's first text (`<a href><div>37</div></a>`) waits for that text.
    if (parts.length === 0) return;
    const raw = parts.map((p) => p.text).join("");
    const text = raw.replace(/\s+/g, " ").trim();
    if (text) {
      let total = 0;
      let emph = 0;
      let size: number | null = Infinity;
      for (const p of parts) {
        const n = p.text.replace(/\s+/g, "").length;
        total += n;
        if (p.emph) emph += n;
        if (n > 0) size = p.size === null || size === null ? null : Math.min(size, p.size);
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
      blocks.push({
        text,
        emph: total === 0 ? 0 : emph / total,
        lead,
        anchor: blockAnchor ?? lastAnchor,
        size: size === Infinity ? null : size,
        row: rows.length > 0 ? rows[rows.length - 1]! : null,
        links,
      });
      links = null;
    }
    parts = [];
    blockAnchor = null;
  };

  const effective = (): { emph: boolean; hidden: boolean; size: number | null } => {
    let bold: boolean | null = null;
    let italic: boolean | null = null;
    let underline: boolean | null = null;
    let size: number | null = null;
    let hidden = false;
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]!;
      if (f.hidden) hidden = true;
      if (bold === null && f.bold !== null) bold = f.bold;
      if (italic === null && f.italic !== null) italic = f.italic;
      if (underline === null && f.underline !== null) underline = f.underline;
      if (size === null && f.size !== null) size = f.size;
    }
    return { emph: bold === true || italic === true || underline === true, hidden, size };
  };

  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!?[a-zA-Z/][^>]*>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const token = m[0];
    if (token[0] !== "<" || token === "<") {
      if (skipUntil) continue;
      const { emph, hidden, size } = effective();
      if (hidden) continue;
      const text = decodeEntities(token);
      if (text) parts.push({ text, emph, size });
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
        // The block this id opens or sits inside is the next one pushed.
        if (lastAnchor !== null && !ids.has(lastAnchor)) ids.set(lastAnchor, blocks.length);
      }
    }

    if (tag === "br") {
      flush();
      continue;
    }
    if (BLOCK_TAGS.has(tag)) flush();
    if (CELL_TAGS.has(tag) && closing) parts.push({ text: " ", emph: false, size: null });

    if (tag === "table") {
      if (!closing) tables.push(rows.length);
      else if (tables.length > 0) rows.length = Math.min(rows.length, tables.pop()!);
    } else if (tag === "tr") {
      if (!closing) rows.push(++rowCount);
      else rows.pop();
    } else if (tag === "a" && !closing) {
      const href = /\bhref\s*=\s*(?:"#([^"]*)"|'#([^']*)')/i.exec(attrs);
      const target = href ? decodeEntities(href[1] ?? href[2] ?? "") : "";
      if (target) (links ??= []).push(target);
    }

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
  return { blocks, ids };
}

/** The document's blocks alone (readDocument). */
export function htmlBlocks(html: string): Block[] {
  return readDocument(html).blocks;
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
  /** How it was found: a table of contents link, or the item's own heading. */
  via: "toc" | "heading";
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

function charsOf(blocks: readonly Block[], start: number, end: number): number {
  let chars = 0;
  for (let i = start; i < end; i++) chars += blocks[i]!.text.length;
  return chars;
}

/** Index of the first item heading at or after `start`, or the document's end. */
function nextItem(blocks: readonly Block[], start: number, kind: SectionKind): number {
  let end = start;
  while (end < blocks.length && !isItemBoundary(blocks[end]!, kind)) end++;
  return end;
}

/**
 * The section whose heading opens the longest run of text before the next
 * item heading. The table of contents names the same item, but the next
 * item follows it at once, so the longest run is the body.
 */
function headingSection(blocks: readonly Block[], kind: SectionKind): Section | null {
  let best: Section | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const span = headingAt(blocks, i, kind);
    if (span === 0) continue;
    const start = i + span;
    const end = nextItem(blocks, start, kind);
    const chars = charsOf(blocks, start, end);
    if (!best || chars > best.chars) best = { start, end, anchor: blocks[i]!.anchor, chars, via: "heading" };
  }
  return best && best.chars > 0 ? best : null;
}

/** One link of a table of contents (or a cross-reference index): the entry's words, and the block it lands on. */
type TocEntry = { at: number; id: string; target: number; key: string };

/** Entries of one table of contents sit at most this many blocks apart. */
const TOC_GAP = 40;
/** A row's cells are read from at most this many blocks either side. */
const ROW_SPAN = 12;
/** A table of contents lists its parts in order: at least this share of its steps go forward. */
const TOC_ORDERED = 0.7;

/** What an entry says, its page numbers dropped: "Item 1A. | Risk Factors | 12" gives "item 1a risk factors". */
function tocKey(text: string): string {
  return headingKey(text)
    .replace(/^(?:(?:pages?|\d{1,3})\s+)+(?=[a-z])/, "")
    .replace(/(?:\s+(?:pages?|\d{1,3}))+$/, "")
    .trim();
}

const TOC_LABEL: Readonly<Record<SectionKind, RegExp>> = {
  // "Item 1A. Risk Factors", "Risk Factors", a 20-F's "Item 3.D. Risk Factors" or "D. Risk Factors",
  // and a cross-reference row that adds where the item sits ("D. Risk Factors | Risk – Risk factors").
  risk: /^(?:part [iv]+ )?(?:item (?:1a|3 ?d|3) )?(?:key information )?(?:3 ?d |d )?risk factors(?: [a-z ]{0,60}\brisk factors)?$/,
  controls: /^(?:part [iv]+ )?(?:item (?:9a|4|15) )?controls and procedures(?: [a-z ]{0,60}\bcontrols and procedures)?$/,
};

/** An entry inside the section (a risk factor group the contents list), not the next part. */
function isSubEntry(key: string, kind: SectionKind): boolean {
  return kind === "risk" && /^(?:summary of )?(?:risks?|risk factors?)\b/.test(key);
}

/** The one in-document target a block links to that lands somewhere, or null (none, or several: navigation). */
function linkOf(b: Block, ids: ReadonlyMap<string, number>): string | null {
  if (!b.links) return null;
  const distinct = [...new Set(b.links)].filter((id) => ids.has(id));
  return distinct.length === 1 ? distinct[0]! : null;
}

/**
 * Every in-document link, with the words of its entry: the block's own text,
 * or in a table the row's cells that belong to it. A row with one link is all
 * its entry ("Item 1A." linked, "Risk Factors" and the page beside it); a row
 * of two columns (title, page, title, page) gives each link the cells from
 * the one before it.
 */
function tocEntries(doc: Doc): TocEntry[] {
  const { blocks, ids } = doc;
  const out: TocEntry[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const id = linkOf(b, ids);
    if (id === null) continue;
    let label = b.text;
    if (b.row !== null) {
      let lo = i;
      let hi = i;
      while (lo > 0 && i - lo < ROW_SPAN && blocks[lo - 1]!.row === b.row) lo--;
      while (hi < blocks.length - 1 && hi - i < ROW_SPAN && blocks[hi + 1]!.row === b.row) hi++;
      const linked = [];
      for (let k = lo; k <= hi; k++) if (linkOf(blocks[k]!, ids) !== null) linked.push(k);
      if (linked.length > 1) {
        const n = linked.indexOf(i);
        // Its cells run from after the link before it; the last link also takes the cells after it.
        lo = n === 0 ? lo : linked[n - 1]! + 1;
        hi = n === linked.length - 1 ? hi : i;
      }
      label = blocks
        .slice(lo, hi + 1)
        .map((x) => x.text)
        .join(" ");
    }
    if (label.length > 200) continue;
    out.push({ at: i, id, target: ids.get(id)!, key: tocKey(label) });
  }
  return out;
}

/** Runs of entries no more than TOC_GAP blocks apart: one table each. */
function tocTables(entries: readonly TocEntry[]): { from: number; to: number; ordered: boolean }[] {
  const out: { from: number; to: number; ordered: boolean }[] = [];
  let from = 0;
  for (let n = 1; n <= entries.length; n++) {
    if (n < entries.length && entries[n]!.at - entries[n - 1]!.at <= TOC_GAP) continue;
    let steps = 0;
    let forward = 0;
    let last = -1;
    for (let k = from; k < n; k++) {
      const t = entries[k]!.target;
      if (t === last) continue;
      if (last >= 0) {
        steps++;
        if (t > last) forward++;
      }
      last = t;
    }
    out.push({ from, to: n, ordered: steps >= 1 && forward / steps >= TOC_ORDERED });
    from = n;
  }
  return out;
}

/**
 * The section as the table of contents links it: from the block its entry's
 * link lands on to the first block another entry lands on after it. An
 * integrated annual report (Intel's 10-K, ASML's 20-F) orders its chapters
 * its own way and prints no "Item" headings where the section ends; its
 * contents' links still say where the section starts and where the next part
 * begins. A cross-reference index (a 20-F's "Item 3.D. Risk Factors, see
 * page 66") also links the start, but its other rows point anywhere, into the
 * section too: an entry from a table out of order is ended by the entries of
 * the ordered tables printed before the section.
 */
function tocSection(doc: Doc, kind: SectionKind, total: number): Section | null {
  const { blocks } = doc;
  const entries = tocEntries(doc);
  const tables = tocTables(entries);
  const label = TOC_LABEL[kind];
  const ends = (from: number, to: number) => {
    const out: number[] = [];
    for (let k = from; k < to; k++) {
      const x = entries[k]!;
      if (!label.test(x.key) && !isSubEntry(x.key, kind)) out.push(x.target);
    }
    return out;
  };
  const ordered = tables.filter((t) => t.ordered);
  let best: { section: Section; ordered: boolean } | null = null;
  for (const table of tables) {
    for (let n = table.from; n < table.to; n++) {
      const e = entries[n]!;
      if (!label.test(e.key) || e.target >= blocks.length) continue;
      let start = e.target;
      // The link lands on the section's own heading, or just before it.
      for (let k = start; k < Math.min(start + 3, blocks.length); k++) {
        const span = headingAt(blocks, k, kind);
        if (span > 0) {
          start = k + span;
          break;
        }
      }
      let end = Infinity;
      // An index's entry is ended by the ordered tables printed before the section
      // (the contents, a page header's chapter list), not by links inside it.
      const stops = table.ordered ? ends(table.from, table.to) : ordered.filter((t) => entries[t.from]!.at < start).flatMap((t) => ends(t.from, t.to));
      for (const t of stops) if (t > start && t < end) end = t;
      // The last entry of its table: the section runs to the next item heading.
      if (end === Infinity) end = nextItem(blocks, start, kind);
      const chars = charsOf(blocks, start, end);
      // A reading that swallows most of the document is no reading.
      if (chars === 0 || chars > total * 0.8) continue;
      const section: Section = { start, end, anchor: e.id, chars, via: "toc" };
      // An ordered table's reading wins over an index's; between two alike, the longer.
      if (!best || (table.ordered && !best.ordered) || (table.ordered === best.ordered && chars > best.section.chars)) best = { section, ordered: table.ordered };
    }
  }
  return best?.section ?? null;
}

/**
 * An item of the filing: through the table of contents' links when the
 * document has them (`readDocument`), else the item's own heading
 * (`headingSection`). Blocks alone have no ids to land on, so only the
 * heading is searched.
 */
export function findSection(source: Doc | readonly Block[], kind: SectionKind): Section | null {
  const doc: Doc = isDoc(source) ? source : { blocks: source as Block[], ids: new Map() };
  const total = charsOf(doc.blocks, 0, doc.blocks.length);
  return (doc.ids.size > 0 ? tocSection(doc, kind, total) : null) ?? headingSection(doc.blocks, kind);
}

function isDoc(source: Doc | readonly Block[]): source is Doc {
  return !Array.isArray(source);
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
  // "Tab le of Contents": a running header split by the converter.
  if (k.replace(/ /g, "") === "tableofcontents") return true;
  if (/^(table of contents|index|back to contents|return to table of contents|page \d+|part [iv]+|risk factors( continued)?)$/.test(k)) return true;
  // A cross-reference line ("Read more in Strategic report – Risk").
  if (/^(?:read more|see also)\b/.test(k)) return true;
  return false;
}

/** A line that stops mid-phrase: on a comma, a dash, or a word that needs the next one. */
const DANGLING_RE = /(?:[,–—-]|\b(?:a|an|and|as|at|by|for|from|in|into|of|on|or|our|the|their|to|with|its|that|which|than|such|including)) *$/i;

/** "Supply chain disruption, Supplier strategy and performance": a row of category labels, not a statement. */
function isLabelList(text: string): boolean {
  if (/[.?!:;]["”)]?$/.test(text)) return false;
  const parts = text.split(/\s*,\s*/);
  return parts.length >= 2 && parts.every((p) => wordCount(p) <= 5) && !readsAsRisk(text);
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

/** A list bullet a heading may open with ("•Pharmaceutical research ..."): not part of its words. */
const BULLET_RE = /^[•▪▫◦·●■◆►‣⁃➢–—]\s*/;

/**
 * The font size most of the section's text is set in (by characters), when
 * inline styles size it: a block set larger than this is a heading even in
 * roman type (Intel prints its risk factors in a larger, coloured face).
 */
function bodySize(blocks: readonly Block[], section: Section): number | null {
  const bySize = new Map<number, number>();
  for (let i = section.start; i < section.end; i++) {
    const b = blocks[i]!;
    if (b.size !== null) bySize.set(b.size, (bySize.get(b.size) ?? 0) + b.text.length);
  }
  let best: number | null = null;
  let most = 0;
  for (const [size, chars] of bySize) {
    if (chars > most) {
      best = size;
      most = chars;
    }
  }
  return best;
}

/**
 * The risk factor headings inside Item 1A: blocks set wholly in bold, italic
 * or underline, or larger than the section's body text (or opening with an
 * emphasised run that ends a sentence), long enough to be a sentence. Shorter
 * emphasised lines are the group headings and are kept as each heading's
 * `group`. A bullet the heading opens with is left out of its text.
 */
export function riskHeadings(blocks: readonly Block[], section: Section): RiskHeading[] {
  const out: RiskHeading[] = [];
  const seen = new Set<string>();
  const body = bodySize(blocks, section);
  const strong = (b: Block) => b.emph >= 0.85 || (body !== null && b.size !== null && b.size >= body + 1);
  let group: string | null = null;
  for (let i = section.start; i < section.end; i++) {
    const b = blocks[i]!;
    if (isPageArtifact(b.text)) continue;
    let candidate: string | null = null;
    if (strong(b) && b.text.length <= MAX_HEADING_CHARS) {
      candidate = b.text.replace(BULLET_RE, "");
      // A filing set one printed line per block (converted from print) splits a
      // heading over several blocks: join emphasised lines until one ends a sentence.
      while (i + 1 < section.end) {
        const next = blocks[i + 1]!;
        if (!strong(next) || isPageArtifact(next.text) || candidate.length + next.text.length > MAX_HEADING_CHARS) break;
        // A bulleted line is a heading of its own.
        if (BULLET_RE.test(next.text) && !/^[a-z]/.test(next.text)) break;
        // A line that opens in lower case continues the one above, even after "R.O.C.".
        if (!/^[a-z]/.test(next.text)) {
          if (/[.?!:]["”)]?$/.test(candidate)) break;
          if (/^[A-Z]/.test(next.text) && isGroupHeading(candidate)) break;
          // Headings printed without a full stop, one after another (ASML's 20-F): a
          // capitalised line opens the next heading unless this one breaks off mid-phrase.
          if (/^[A-Z]/.test(next.text) && !DANGLING_RE.test(candidate)) break;
        }
        candidate = `${candidate} ${next.text}`;
        i++;
      }
      // A run-in lead set in the same face (a bulleted sub-point) is not a heading.
    } else if (b.lead && b.lead.length >= 30 && b.lead.length <= MAX_HEADING_CHARS && /[.?!:]["”]?$/.test(b.lead)) candidate = b.lead;
    // A heading opens a sentence; a run that starts in lower case is the tail of a body line.
    if (!candidate || !/^["“(]?[A-Z0-9]/.test(candidate)) continue;
    if (isLabelList(candidate)) continue;
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

/** Above this many headings, what was read is not a risk factors section (the longest seen run to about seventy). */
export const RISK_MAX_HEADINGS = 120;
/**
 * The most of a document's text its risk factors section may hold. A 10-K's
 * Item 1A runs to a third of it at most (Apple, AMD and Nvidia sit near 34%);
 * a 10-Q that repeats every risk factor runs to about two thirds (AMD 63%).
 */
export const RISK_MAX_SHARE = { annual: 0.5, quarter: 0.8 } as const;
/** Of the headings, at most this share may look like table rows or footnotes. */
const RISK_MAX_JUNK = 0.15;
/** Of the headings, at least this share must read as risk statements. */
const RISK_MIN_SENTENCES = 0.7;

/**
 * A financial table's row or a footnote, not a risk factor: mostly figures
 * ("Net revenue $ 13,577 $ 12,667"), dollar amounts, or a note number
 * opening the line ("1 Employee headcount includes ...").
 */
export function looksLikeTableRow(text: string): boolean {
  const digits = (text.match(/\d/g) ?? []).length;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (digits > 0.15 * (letters + digits)) return true;
  if ((text.match(/\$\s?\(?\d/g) ?? []).length >= 2) return true;
  if (/^\(?\d{1,2}\)?\s+[A-Z]/.test(text) && !/^\d{1,2}\s+(?:percent|%)/i.test(text)) return true;
  return false;
}

/** A risk factor states a risk: it ends a sentence, or says what may or could happen. */
function readsAsRisk(text: string): boolean {
  if (/[.?!:;]["”)]?$/.test(text)) return true;
  return /\b(?:may|could|might|would|can|cannot|will|depends?|dependent|subject|risks?|adverse\w*|fail\w*|unable|uncertain\w*|volatil\w*|harm\w*|exposed?)\b/i.test(text);
}

export type RiskReadability = { readable: true } | { readable: false; reason: "share" | "count" | "table_rows" | "not_sentences" };

/**
 * Whether a located risk factors section, and the headings read from it,
 * are risk factors at all. An integrated report can send both readers astray
 * (a "Risk Factors" running header opening a run to the exhibit index, a
 * performance table's rows read as headings); when the section holds too
 * much of the document, or has implausibly many headings, or its headings
 * read as table rows or titles rather than statements, nothing from it is
 * shown.
 */
export function riskReadability(section: Section, headings: readonly RiskHeading[], totalChars: number, annual: boolean): RiskReadability {
  const share = totalChars > 0 ? section.chars / totalChars : 1;
  if (share > (annual ? RISK_MAX_SHARE.annual : RISK_MAX_SHARE.quarter)) return { readable: false, reason: "share" };
  if (headings.length > RISK_MAX_HEADINGS) return { readable: false, reason: "count" };
  if (headings.length >= 4) {
    const junk = headings.filter((h) => looksLikeTableRow(h.text)).length;
    if (junk / headings.length > RISK_MAX_JUNK) return { readable: false, reason: "table_rows" };
    const risks = headings.filter((h) => readsAsRisk(h.text)).length;
    if (risks / headings.length < RISK_MIN_SENTENCES) return { readable: false, reason: "not_sentences" };
  }
  return { readable: true };
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
  /\b(?:there (?:have|has) been no material changes?|no material changes? (?:to|in|from) (?:any of )?(?:the|our|its) risk factors|(?:have|has) not (?:materially )?changed materially|risk factors (?:have|has) not materially changed)/i;

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
  /** Who: a name ("Apple"), the filing's own words ("One customer", "Customer A"), or LARGEST_CUSTOMER. */
  label: string;
  /** The share for the latest year the filing gives it. */
  pct: number;
  /** What the share is of. */
  basis: "revenue" | "receivables";
  /** The sentence, or the table row, verbatim. */
  quote: string;
};

/**
 * The label for the largest of several unnamed customers' shares: "three
 * customers accounted for 23.0%, 17.1% and 12.5%" holds no name for any of
 * them, and unnamed customers are compared across years by size, never by
 * label (a filing's "Customer A" this year need not be last year's).
 */
export { LARGEST_CUSTOMER };

const COUNT_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten";
const COUNT_OF: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const GENERIC_LABEL_RE = new RegExp(
  `^(?:${COUNT_WORDS}|a single|a|our largest|our (?:${COUNT_WORDS}) largest|our top|the largest|no single|no one|no other|any single|each of (?:${COUNT_WORDS}))?\\s*(?:customers?|distributors?|resellers?|clients?|end customers?|customer [a-z0-9])$`,
  "i",
);

const GENERIC_TAIL_RE = new RegExp(
  `((?:${COUNT_WORDS}|a single|our largest|our (?:${COUNT_WORDS}) largest|the largest|no single)\\s+(?:end\\s+)?(?:customers?|distributors?|resellers?|clients?)|customer\\s+[A-Z0-9])$`,
  "i",
);

/** A label that names no one and stands for one customer: "One customer", "Customer A", "our largest customer". */
const ANONYMOUS_ONE_RE = /^(?:(?:one|a single|a|our largest|the largest|largest)\s+(?:end\s+)?(?:customer|distributor|reseller|client)|(?:customer|distributor|reseller|client)\s+[A-Z0-9]{1,2})$/i;

/** Whether a concentration label stands for one unnamed customer (compared across years by size, not by label). */
export function anonymousShare(label: string): boolean {
  return label === LARGEST_CUSTOMER || ANONYMOUS_ONE_RE.test(label.trim());
}

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
    if (/^[A-Z0-9][\w.&'’-]*$/.test(w) && /[A-Za-z]/.test(w)) kept.unshift(w);
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

/** How many customers a plural label counts: "Three customers" 3, "our two largest customers" 2. */
function countOf(label: string): number | null {
  const m = new RegExp(`\\b(${COUNT_WORDS})\\b`, "i").exec(label);
  return m ? COUNT_OF[m[1]!.toLowerCase()]! : null;
}

/** A share read before the latest year's is kept: the year it is for, when the filing says. */
type Candidate = ConcentrationFact & { year: number | null };

const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
/** "fiscal 2026", "the fiscal year ended June 30, 2026", "as of December 31, 2025", "in 2025". */
const PERIOD_RE = /(?:fiscal(?:\s+years?)?|(?:years?|quarters?|periods?)\s+ended|as\s+of|\bin|\bduring|\bfor)\s+(?:(?:the\s+)?(?:fiscal\s+)?(?:years?\s+)?(?:ended\s+)?)?(?:[A-Z][a-z]+\.?\s+\d{1,2},\s+)?((?:19|20)\d{2})\b/gi;

function yearsIn(text: string): number[] {
  return [...text.matchAll(YEAR_RE)].map((m) => Number(m[0]));
}

/**
 * The period a claim is for: the years the words after it give ("of net
 * sales in fiscal 2026 and 2025"), else the last period the words before it
 * give ("For the fiscal year ended June 30, 2026, sales to ..."). Empty when
 * the sentence names none.
 */
function claimYears(lead: string, tail: string): number[] {
  const after = tail.replace(/[.;].*$/, "");
  if (new RegExp(PERIOD_RE.source, "i").test(after)) {
    const at = after.search(new RegExp(PERIOD_RE.source, "i"));
    return yearsIn(after.slice(at));
  }
  const before = [...lead.matchAll(PERIOD_RE)];
  // "In 2025, 2024 and 2023 one customer accounted for ...": every year from the last period on.
  return before.length > 0 ? yearsIn(lead.slice(before[before.length - 1]!.index)) : [];
}

/**
 * Customer concentration sentences: "Sales to Apple accounted for 18% of net
 * revenue", "One customer represented approximately 12% of revenue", and the
 * "A and B accounted for 29.8% and 11.1% of our net sales, respectively"
 * shape. "Three customers accounted for 23.0%, 17.1% and 12.5%" gives the
 * largest of the three (LARGEST_CUSTOMER). Shares under 10% are left out
 * (the disclosure threshold).
 */
function sentenceCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const PCT_RE = /(\d{1,2}(?:\.\d{1,2})?)\s?%/g;
  // No quantified name group: the subject is read backwards from the verb, so nothing here can backtrack.
  const claim =
    /(?<![A-Za-z])(?:accounted for|represented|comprised|made up|constituted|were|was)\s+(?:approximately |about |roughly |an aggregate of |a total of |more than |over )?(\d{1,2}(?:\.\d{1,2})?\s?%(?:,?\s{0,3}(?:and\s+)?\d{1,2}(?:\.\d{1,2})?\s?%){0,4})\s+of\s+(?:our |the company['’]s |its |the group['’]s |total |net |consolidated |gross ){0,4}(net revenues?|revenues?|net sales|sales|total revenues?|accounts receivable|receivables|trade receivables)/gi;
  for (const s of sentences(text, 700)) {
    if (!/%/.test(s) || !/(revenue|sales|receivable)/i.test(s)) continue;
    claim.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = claim.exec(s)) !== null) {
      const basis: ConcentrationFact["basis"] = /receivable/i.test(m[2]!) ? "receivables" : "revenue";
      const pcts = [...m[1]!.matchAll(PCT_RE)].map((x) => Number(x[1]));
      const subject = s.slice(Math.max(0, m.index - 160), m.index).replace(/^.*[;:(]\s*/, "");
      // "No sales to an individual customer or country other than the United States accounted for more than 10%".
      if (/\b(?:no|none|neither|nor)\b/i.test(subject)) continue;
      const tail = s.slice(m.index + m[0].length);
      const years = claimYears(s.slice(0, m.index), tail);
      const respectively = /respectively/i.test(tail);
      if (pcts.length >= 2 && respectively) {
        const names = splitNames(subject);
        if (names.length === pcts.length) {
          const year = years.length === 1 ? years[0]! : null;
          names.forEach((n, i) => out.push({ label: n, pct: pcts[i]!, basis, quote: s, year }));
          continue;
        }
      }
      const label = tailLabel(subject);
      const plural = /(?:customers|distributors|resellers|clients)$/i.test(label);
      if (pcts.length >= 2) {
        // A share for each year ("Apple accounted for 18% and 15% of revenue in fiscal 2026 and 2025, respectively"): the latest year's.
        if (respectively && years.length === pcts.length && new Set(years).size === years.length) {
          const latest = years.indexOf(Math.max(...years));
          out.push({ label, pct: pcts[latest]!, basis, quote: s, year: years[latest]! });
          continue;
        }
        // "Three customers accounted for 23.0%, 17.1% and 12.5%": a share each, none named; the largest is comparable.
        if (plural && !respectively && countOf(label) === pcts.length) {
          out.push({ label: LARGEST_CUSTOMER, pct: Math.max(...pcts), basis, quote: s, year: years.length === 1 ? years[0]! : null });
          continue;
        }
        // Several shares, no one name or year to give each.
        if (plural) continue;
      }
      out.push({ label, pct: pcts[0]!, basis, quote: s, year: years.length === 1 ? years[0]! : years.length > 1 ? Math.max(...years) : null });
    }
  }
  return out;
}

/** A table's value cell: "20.9%", "20.9", "*" (below 10%), "—". */
const CELL_VALUE_RE = /^(?:\d{1,3}(?:\.\d{1,2})?%?|\*{1,3}|[—–-]{1,2}%?|n\/a)$/i;
/** A row label that is a customer by letter or number: "Customer A", "Distributor 2". */
const LETTERED_RE = /^(?:customer|distributor|reseller|client)\s+[A-Z0-9]{1,2}$/i;
/** Row labels that are no customer: totals, headers, places, products. */
const NOT_CUSTOMER_RE =
  /^(?:total|totals|other|others|all other|percentage|percent|%|net sales|revenues?|sales|accounts receivable|receivables|customers?|united states|u\.s\.|americas|asia|europe|emea|apac|china|japan|taiwan|rest of world|international|domestic|fiscal|years?|segment)\b/i;

/** The row's label and value cells: "Customer A 20.9% 20.0% *" is "Customer A" and three cells. */
function rowCells(text: string): { label: string; values: string[] } | null {
  const tokens = text.replace(/\s+%/g, "%").replace(/\$\s*/g, "").split(/\s+/).filter(Boolean);
  const values: string[] = [];
  while (tokens.length > 0 && CELL_VALUE_RE.test(tokens[tokens.length - 1]!)) values.unshift(tokens.pop()!);
  // A footnote mark on the label ("Customer A (1)", "Customer B*").
  const label = tokens
    .join(" ")
    .replace(/\s*(?:\(\w\)|\*+)$/, "")
    .trim();
  if (!label || values.length === 0 || !/[A-Za-z]/.test(label)) return null;
  return { label, values };
}

const REVENUE_WORDS_RE = /\b(?:net sales|revenues?|sales)\b/i;
const RECEIVABLE_WORDS_RE = /receivable/i;

/** What a table's shares are of, from the first text that says: null when none says, or one says both. */
function basisOf(texts: readonly string[]): ConcentrationFact["basis"] | null {
  for (const t of texts) {
    const rev = REVENUE_WORDS_RE.test(t);
    const rec = RECEIVABLE_WORDS_RE.test(t);
    if (rev && rec) return null;
    if (rec) return "receivables";
    if (rev) return "revenue";
  }
  return null;
}

/**
 * Customer concentration tables: a table whose header or caption says what
 * the shares are of (net sales or revenue; accounts receivable, kept as
 * receivables and never as revenue) and whose rows are customers by letter
 * ("Customer A | 20.9% | 20.0% | *") or, when the table speaks of customers,
 * by name. The latest year's column is read: the column under the latest
 * year the header gives, or the only column. A "*" (below 10%) or a dash
 * gives nothing. A table that names both bases, or whose columns cannot be
 * told apart, is left out.
 */
function tableCandidates(blocks: readonly Block[]): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i]!.row === null) {
      i++;
      continue;
    }
    const start = i;
    // The table's rows, a row's cells (blocks) joined.
    const rows: string[] = [];
    let last: number | null = null;
    while (i < blocks.length && blocks[i]!.row !== null) {
      const b = blocks[i]!;
      if (b.row === last) rows[rows.length - 1] = `${rows[rows.length - 1]} ${b.text}`.trim();
      else rows.push(b.text);
      last = b.row;
      i++;
    }
    // The caption: the two blocks before the table, nearest first.
    const caption: string[] = [];
    for (let j = start - 1; j >= 0 && j >= start - 2 && blocks[j]!.row === null; j--) caption.push(blocks[j]!.text.slice(-600));
    const parsed = rows.map((r) => ({ text: r, cells: rowCells(r) }));
    const first = parsed.findIndex((r) => r.cells !== null && LETTERED_RE.test(r.cells.label));
    const firstAny = first >= 0 ? first : parsed.findIndex((r) => r.cells !== null && !NOT_CUSTOMER_RE.test(r.cells.label) && /[%]/.test(r.text));
    if (firstAny < 0) continue;
    const header = rows.slice(0, firstAny);
    const context = [...header, ...caption].join(" ");
    const lettered = first >= 0;
    // Named rows only where the table speaks of customers, and never in a table of places or products.
    if (!lettered && (!/\bcustomers?\b|\bclients?\b/i.test(context) || /geograph|region|countr|product|segment/i.test(context))) continue;
    const basis = basisOf([header.join(" "), ...caption]);
    if (!basis) continue;
    const percent = /%|percent/i.test(context) || rows.slice(firstAny).some((r) => /%/.test(r));
    if (!percent) continue;
    let years = yearsIn(header.join(" "));
    if (years.length === 0) years = yearsIn(caption[0] ?? "");
    for (const r of parsed.slice(firstAny)) {
      if (!r.cells) continue;
      const { label, values } = r.cells;
      if (lettered ? !LETTERED_RE.test(label) : NOT_CUSTOMER_RE.test(label) || wordCount(label) > 6 || !/^[A-Z0-9]/.test(label)) continue;
      let at: number;
      let year: number | null = null;
      if (years.length > 0 && years.length === values.length) {
        const max = Math.max(...years);
        if (years.filter((y) => y === max).length > 1) continue;
        at = years.indexOf(max);
        year = max;
      } else if (values.length === 1 && years.length <= 1) {
        at = 0;
        year = years[0] ?? null;
      } else continue;
      const cell = values[at]!.replace(/%$/, "");
      if (!/^\d/.test(cell)) continue;
      const name = LETTERED_RE.test(label) ? label.replace(/^(\w+)\s+(\w+)$/, (_m, a: string, b: string) => `${a.charAt(0).toUpperCase()}${a.slice(1).toLowerCase()} ${b.toUpperCase()}`) : label;
      out.push({ label: name, pct: Number(cell), basis, quote: r.text, year });
    }
  }
  return out;
}

/**
 * Customer concentration, from the filing's sentences and, with `blocks`,
 * its tables. Only the latest year's shares are kept: a share the filing
 * gives for an earlier year than another share of the same basis ("For the
 * fiscal year ended June 30, 2025, sales to four customers ...") is the
 * comparison's business, not this year's fact. Shares under 10% are left out.
 */
export function concentrationFacts(text: string, blocks?: readonly Block[]): ConcentrationFact[] {
  const candidates = [...sentenceCandidates(text), ...(blocks ? tableCandidates(blocks) : [])];
  const latestYear = new Map<string, number>();
  for (const c of candidates) if (c.year !== null && c.year > (latestYear.get(c.basis) ?? 0)) latestYear.set(c.basis, c.year);
  const out: ConcentrationFact[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (c.year !== null && c.year < latestYear.get(c.basis)!) continue;
    if (!Number.isFinite(c.pct) || c.pct < 10 || c.pct > 100) continue;
    const clean = c.label === LARGEST_CUSTOMER ? c.label : tailLabel(c.label) || (LETTERED_RE.test(c.label) ? c.label : "");
    if (!clean || clean.length > 60 || wordCount(clean) > 6) continue;
    if (!GENERIC_LABEL_RE.test(clean) && !/^[A-Z0-9]/.test(clean)) continue;
    if (/^(?:no single|no one|no other|any single)/i.test(clean)) continue;
    const key = `${labelKey(clean)}|${c.basis}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: clean, pct: c.pct, basis: c.basis, quote: c.quote });
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
