/**
 * Plain text from SEC HTML (filings and press-release exhibits), and the
 * sentence helpers the event and graph code share. Pure.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  reg: "®",
  trade: "™",
  copy: "©",
  bull: "•",
  middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n)) return m;
      if (n === 160) return " ";
      if (n === 8211 || n === 8212) return "-";
      return String.fromCodePoint(n);
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const BLOCK = /<\/?(p|div|br|tr|li|ul|ol|table|h[1-6]|section|article|header|footer|blockquote|center|hr)\b[^>]*>/gi;

/** Readable text from an HTML document: one paragraph per line. */
export function htmlToText(html: string): string {
  let s = html;
  // Inline XBRL keeps its hidden facts in an ix:header block; they are not prose.
  s = s.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ");
  s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Table cells on one line, separated, so a row reads as a row.
  s = s.replace(/<\/t[dh]>/gi, " | ");
  s = s.replace(BLOCK, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[   ]/g, " ");
  s = s.replace(/[‐-―]/g, "-");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((line) => line.length > 0 && !/^(\|\s*)+$/.test(line))
    .join("\n");
  return s;
}

/** Whitespace and quote marks folded, for matching a quote against a document. */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/®|™/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Table cell separators are layout, not words: dropped before matching. */
function matchText(s: string): string {
  return normalizeForMatch(s.replace(/\s\|\s?/g, " "));
}

/**
 * Whether `quote` appears in `doc` word for word (whitespace, quote marks and
 * table layout aside). A quote may skip text with " ... ": each part must
 * appear, in order, the next within 600 characters of the one before (a
 * table caption and the row under it).
 */
export function quoteInDocument(quote: string, doc: string): boolean {
  const parts = quote.split(/\s*\.\.\.\s*/).map(matchText).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.join(" ").length < 12) return false;
  const d = matchText(doc);
  const [first, ...rest] = parts;
  for (let start = d.indexOf(first!); start >= 0; start = d.indexOf(first!, start + 1)) {
    let from = start + first!.length;
    let ok = true;
    for (const part of rest) {
      const at = d.indexOf(part, from);
      if (at < 0 || at - from > 600) {
        ok = false;
        break;
      }
      from = at + part.length;
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Sentences of a text. Splits on ". " before a capital or a digit, but not
 * after common abbreviations (Inc., Corp., No., U.S.) or inside numbers.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const parts = para.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
    let buf = "";
    for (const part of parts) {
      buf = buf ? `${buf} ${part}` : part;
      if (/\b(Inc|Corp|Co|Ltd|No|Nos|U\.S|U\.K|Mr|Ms|Dr|vs|approx|e\.g|i\.e|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|N\.V|S\.A|L\.P|plc)\.$/i.test(buf)) continue;
      out.push(buf.trim());
      buf = "";
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter((s) => s.length > 0);
}

/** Cut a string to at most `max` characters at a word boundary, marking the cut. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 3);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "")}...`;
}
