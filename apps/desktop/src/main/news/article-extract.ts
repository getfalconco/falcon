/**
 * Readable text out of a publisher's article page, without a DOM.
 *
 * A light readability pass, written here rather than pulled in: the desktop
 * has no HTML parser among its dependencies, and the job is narrow. Three
 * steps, best source first:
 *
 *   1. Paid content. A page whose JSON-LD says `isAccessibleForFree: false`
 *      (the schema.org paywall marker) or that carries a subscribe wall is
 *      reported as a paywall, and none of its text is kept, even when the
 *      page ships the whole story in its markup for search engines.
 *   2. JSON-LD `articleBody`. Most news sites put the story there whole and
 *      clean; it is used when it is long enough to be the article.
 *   3. The largest block of paragraphs. The page is tokenised, everything that
 *      is never the story (scripts, styles, nav, header, footer, aside, forms,
 *      figures) is skipped, and each <p>/<blockquote>/<li> credits its text to
 *      the containers above it, halving per level. The best-scoring container
 *      is the article body, and its paragraphs are the text.
 *
 * Pure (no fs, no network) so a test can feed it fixture HTML.
 */

export type ExtractResult = {
  /** "paywall" wins over any text found; "text" needs at least MIN_ARTICLE_CHARS. */
  kind: "text" | "paywall" | "empty";
  paragraphs: string[];
  via: "jsonld" | "blocks" | "none";
};

/** Below this much text a page did not give us the article. */
export const MIN_ARTICLE_CHARS = 400;
/** A paragraph shorter than this is a caption, a byline or a button. */
const MIN_BLOCK_CHARS = 40;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "figure",
  "figcaption",
  "iframe",
  "canvas",
  "video",
  "audio",
  "picture",
  "dialog",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const BLOCK_TAGS = new Set(["p", "blockquote", "li"]);
const BREAK_TAGS = new Set(["p", "div", "li", "ul", "ol", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "dd", "dt", "section", "article"]);

/**
 * A class or id token that names page furniture rather than the story. The
 * word has to open the token ("related-stories", "sidebar", "share_bar"), so a
 * layout wrapper such as "content-sidebar-grid" that holds the article is not
 * mistaken for a sidebar.
 */
const FURNITURE_TOKEN = /^(comments?|related|recommend\w*|newsletter|subscribe|promo|share|social|sidebar|footer|header|nav|navbar|menu|breadcrumbs?|advert\w*|ads?|sponsor\w*|cookie\w*|consent|signup|sign-up|paywall|byline|caption|author-bio|most-popular|trending)(?:$|[-_])/i;
/** Furniture is judged on the containers nearest a paragraph, not on every wrapper above it. */
const FURNITURE_DEPTH = 3;

function isFurniture(attrs: string): boolean {
  return attrs
    .replace(/["']/g, " ")
    .split(/\s+/)
    .some((token) => FURNITURE_TOKEN.test(token));
}

/** Sentences that are the page talking about itself, not the story. */
const BOILERPLATE: readonly RegExp[] = [
  /\ball rights reserved\b/i,
  /\b(sign up|subscribe) (for|to) (our|the)\b/i,
  /\bnewsletter\b/i,
  /\bcookies?\b.*\b(accept|consent|policy)\b/i,
  /\bclick here\b/i,
  /\b(read|see) more:?\s*$/i,
  /\bfollow us on\b/i,
  /\breporting by\b.*\bediting by\b/i,
  /\bour standards:/i,
  /\bthis (article|story) (was|is) (produced|generated|written) (by|with)\b/i,
  /\bdownload the app\b/i,
  /^advertisement$/i,
  /^(image|photo|video) (source|credits?):/i,
];

/** Words a subscribe wall uses about itself. Two of these, or one with a short page, is a wall. */
const PAYWALL_PHRASES: readonly RegExp[] = [
  /\bsubscribe (now )?to (continue|keep) reading\b/i,
  /\bto (continue|keep) reading,? (please )?(subscribe|sign in|log in|register)\b/i,
  /\bthis (article|story|content) is (only )?(available|reserved) (to|for) (subscribers|members|premium)\b/i,
  /\balready a (subscriber|member)\?/i,
  /\bsubscribers only\b/i,
  /\bunlock (this|the full) (article|story)\b/i,
  /\byou have reached your (free )?(article|story) limit\b/i,
  /\bcreate a free account to (continue|read)\b/i,
];

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "...",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  middot: "·",
  bull: "•",
  shy: "",
  zwj: "",
  zwnj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** One paragraph's worth of text: entities decoded, whitespace folded. */
export function cleanText(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, " "))
    .replace(/[  -​  　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBoilerplate(text: string): boolean {
  return BOILERPLATE.some((re) => re.test(text));
}

/** Paragraphs that read as the story: long enough, not the page about itself, each once. */
export function tidyParagraphs(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    const text = cleanText(p);
    if (text.length < MIN_BLOCK_CHARS && !/[.!?:"”]$/.test(text)) continue;
    if (text.length < 20) continue;
    if (isBoilerplate(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function totalChars(paragraphs: readonly string[]): number {
  return paragraphs.reduce((sum, p) => sum + p.length, 0);
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

type JsonLdFinding = { paywalled: boolean; articleBody: string | null };

function walkJsonLd(node: unknown, found: JsonLdFinding): void {
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, found);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const free = record.isAccessibleForFree;
  if (free === false || (typeof free === "string" && free.trim().toLowerCase() === "false")) {
    found.paywalled = true;
  }
  if (typeof record.articleBody === "string") {
    const body = record.articleBody.trim();
    if (body.length > (found.articleBody?.length ?? 0)) found.articleBody = body;
  }
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "hasPart"]) {
    if (key in record) walkJsonLd(record[key], found);
  }
}

export function readJsonLd(html: string): JsonLdFinding {
  const found: JsonLdFinding = { paywalled: false, articleBody: null };
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const raw = match[1]!.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    try {
      walkJsonLd(JSON.parse(raw), found);
    } catch {
      /* a malformed block is skipped; the page may have others */
    }
  }
  return found;
}

/** JSON-LD bodies come as one string; paragraphs are on blank lines or single newlines. */
function splitBody(body: string): string[] {
  const text = decodeEntities(body.replace(/<[^>]*>/g, " ")).replace(/\r\n?/g, "\n");
  const parts = /\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split(/\n/);
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Block scoring
// ---------------------------------------------------------------------------

type Container = { id: number; tag: string; parent: number | null; furniture: boolean };
type Block = { text: string; containers: number[] };

function attrsOf(tagSource: string): string {
  const m = /\b(?:class|id|role|aria-label|data-testid)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  return [...tagSource.matchAll(m)].map((x) => x[1]).join(" ");
}

/** Paragraph blocks with the chain of containers each sits in, innermost first. */
export function collectBlocks(html: string): Block[] {
  // Raw-text elements go first, cut at their closing tag: a script's body is
  // not markup, and a "<script" string inside one would throw the count off.
  const stripped = html.replace(/<(script|style|noscript|textarea|xmp|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(stripped)?.[1] ?? stripped;
  const tokens = body.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>|[^<]+|</g);

  const containers: Container[] = [];
  /** Open elements: tag and, for containers, their id. */
  const stack: Array<{ tag: string; container: number | null }> = [];
  let skipping: { tag: string; depth: number } | null = null;
  let block: { tag: string; parts: string[]; containers: number[] } | null = null;
  const blocks: Block[] = [];

  const chain = (): number[] => {
    const out: number[] = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i]!.container;
      if (c !== null) out.push(c);
    }
    return out;
  };

  const closeBlock = () => {
    if (!block) return;
    // Text nodes carry their own spaces; inline tags (a, strong, span) add none.
    const text = cleanText(block.parts.join(""));
    if (text) blocks.push({ text, containers: block.containers });
    block = null;
  };

  for (const m of tokens) {
    const whole = m[0];
    if (whole.startsWith("<!--") || whole.startsWith("<![CDATA[")) continue;
    const name = m[2]?.toLowerCase();

    if (skipping) {
      if (name === skipping.tag) {
        const selfClosing = /\/\s*$/.test(m[3] ?? "");
        if (m[1] === "/") skipping.depth -= 1;
        else if (!selfClosing) skipping.depth += 1;
        if (skipping.depth <= 0) skipping = null;
      }
      continue;
    }

    if (!name) {
      if (block) block.parts.push(whole);
      continue;
    }

    const closing = m[1] === "/";
    const selfClosing = /\/\s*$/.test(m[3] ?? "");
    // A block-level tag inside a block still separates words.
    if (block && BREAK_TAGS.has(name)) (block as { parts: string[] }).parts.push(" ");

    if (!closing && SKIP_TAGS.has(name)) {
      if (!selfClosing) skipping = { tag: name, depth: 1 };
      continue;
    }
    if (VOID_TAGS.has(name)) {
      if (name === "br" && block) block.parts.push(" ");
      continue;
    }

    if (!closing) {
      if (BLOCK_TAGS.has(name)) {
        // A paragraph never nests; an unclosed one ends where the next begins.
        if ((block as { tag: string } | null)?.tag === "p") closeBlock();
        if (!block) block = { tag: name, parts: [], containers: chain() };
      }
      let container: number | null = null;
      if (name === "div" || name === "section" || name === "article" || name === "main" || name === "td") {
        const parentChain = chain();
        container = containers.length;
        containers.push({
          id: container,
          tag: name,
          parent: parentChain[0] ?? null,
          furniture: isFurniture(attrsOf(m[3] ?? "")),
        });
      }
      if (!selfClosing) stack.push({ tag: name, container });
      continue;
    }

    // Closing tag: a block ends on its own tag, or when the container it
    // started in closes around it (an unclosed <p> before </div>).
    const open = block as { tag: string; containers: number[] } | null;
    if (open && name === open.tag) closeBlock();
    const at = stack.map((s) => s.tag).lastIndexOf(name);
    if (at === -1) continue;
    const startedIn = open?.containers[0];
    if (block && startedIn !== undefined && stack.slice(at).some((s) => s.container === startedIn)) closeBlock();
    stack.length = at;
  }
  closeBlock();

  // A block inside page furniture is never the story.
  const furnitureIds = new Set(containers.filter((c) => c.furniture).map((c) => c.id));
  return blocks.filter((b) => !b.containers.slice(0, FURNITURE_DEPTH).some((id) => furnitureIds.has(id)));
}

/** The paragraphs of the best-scoring container, in page order. */
export function largestTextBlock(html: string): string[] {
  const blocks = collectBlocks(html).filter((b) => b.text.length >= MIN_BLOCK_CHARS && !isBoilerplate(b.text));
  if (blocks.length === 0) return [];
  const score = new Map<number, number>();
  for (const b of blocks) {
    b.containers.forEach((id, level) => {
      score.set(id, (score.get(id) ?? 0) + b.text.length / 2 ** level);
    });
  }
  let best: number | null = null;
  let bestScore = -1;
  for (const [id, s] of score) {
    if (s > bestScore) {
      best = id;
      bestScore = s;
    }
  }
  // Blocks with no container at all (bare <p> under <body>) form their own group.
  const loose = blocks.filter((b) => b.containers.length === 0);
  const looseChars = loose.reduce((sum, b) => sum + b.text.length, 0);
  if (best === null || looseChars > bestScore) return loose.map((b) => b.text);
  return blocks.filter((b) => b.containers.includes(best!)).map((b) => b.text);
}

function paywallPhrases(html: string): number {
  const visible = cleanText(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " "));
  return PAYWALL_PHRASES.filter((re) => re.test(visible)).length;
}

export function extractArticle(html: string): ExtractResult {
  const jsonLd = readJsonLd(html);
  if (jsonLd.paywalled) return { kind: "paywall", paragraphs: [], via: "none" };

  let paragraphs: string[] = [];
  let via: ExtractResult["via"] = "none";
  if (jsonLd.articleBody) {
    const fromLd = tidyParagraphs(splitBody(jsonLd.articleBody));
    if (totalChars(fromLd) >= MIN_ARTICLE_CHARS) {
      paragraphs = fromLd;
      via = "jsonld";
    }
  }
  if (via === "none") {
    paragraphs = tidyParagraphs(largestTextBlock(html));
    if (paragraphs.length > 0) via = "blocks";
  }

  const walls = paywallPhrases(html);
  const chars = totalChars(paragraphs);
  if (walls >= 2 || (walls >= 1 && chars < 1500)) return { kind: "paywall", paragraphs: [], via: "none" };
  if (chars < MIN_ARTICLE_CHARS) return { kind: "empty", paragraphs: [], via: "none" };
  return { kind: "text", paragraphs, via };
}

/**
 * Holds the cache's size cap: paragraphs are kept whole, in order, until the
 * next would pass `maxChars`. Reports whether anything was left out.
 */
export function capParagraphs(
  paragraphs: readonly string[],
  maxChars: number,
  maxParagraphs: number,
): { paragraphs: string[]; truncated: boolean } {
  const out: string[] = [];
  let used = 0;
  for (const p of paragraphs) {
    if (out.length >= maxParagraphs || used + p.length > maxChars) {
      if (out.length === 0) out.push(p.slice(0, maxChars).replace(/\s+\S*$/, "") + "...");
      return { paragraphs: out, truncated: true };
    }
    out.push(p);
    used += p.length;
  }
  return { paragraphs: out, truncated: false };
}
