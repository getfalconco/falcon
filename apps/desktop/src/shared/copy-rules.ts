/**
 * House copy rules, as functions a test can run over source text.
 *
 * Falcon describes; it never advises and never claims to know what comes
 * next. Two word lists carry that: the advice vocabulary no sentence uses, and
 * the forward-looking vocabulary kept out of anything that reads as a risk or
 * outlook sentence. A third rule is typographic: no em dash and no en dash in
 * anything a reader sees.
 *
 * The checks run over SOURCE rather than over rendered output because copy
 * rotates by day, by seed and by branch: a behavioural test sees one variant
 * per run, and the point is that every line obeys the rule, including the ones
 * added later. Pure on purpose (no fs): the caller reads the file, so the same
 * pipeline serves a node test, a script, or a string built in memory.
 */

/**
 * Written as escapes so this file, and any file that imports the constants
 * instead of typing the glyph, passes its own rule.
 */
export const EM_DASH = "\u2014";
export const EN_DASH = "\u2013";

/** Words that turn a description into an instruction to trade. */
export const ADVICE_WORDS: readonly string[] = [
  "buy",
  "sell",
  "enter",
  "exit",
  "long",
  "short",
  "add",
  "trim",
  "target",
  "stop",
  "take profit",
  "signal",
  "prediction",
  "recommend",
];

/**
 * Words that turn a measurement into a claim about the future or into a nudge.
 *
 * "may" collides with the month. Briefing copy never spells that month out in
 * a source literal: dates are written numerically ("2026-05-12"), or the view
 * layer formats them at run time through Intl, where the month name is never
 * a literal in the source. A literal "May 12" is therefore flagged on purpose;
 * loosening the rule for capitalised "May" would also wave through "May ease
 * later in the session", which is exactly the sentence the rule exists for.
 */
export const RISK_SENTENCE_WORDS: readonly string[] = [
  "reduce",
  "consider",
  "should",
  "will",
  "expect",
  "forecast",
  "predict",
  "likely",
  "may",
];

/**
 * Modals and adverbs have no inflections, and pretending they do produces
 * false hits on unrelated words: "willing" is not a form of "will".
 */
const UNINFLECTED = new Set(["should", "will", "likely", "may"]);

/**
 * Forms the suffix rules cannot reach. Kept short: each entry is a form a
 * writer would plausibly reach for after being told the base word is banned.
 */
const IRREGULAR_FORMS: Readonly<Record<string, readonly string[]>> = {
  buy: ["bought"],
  sell: ["sold"],
  "take profit": ["takes profit", "took profit", "taken profit", "taking profit"],
  recommend: ["recommendation", "recommendations"],
  likely: ["unlikely"],
  will: ["won't"],
};

function escapeForRegex(text: string): string {
  return text
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    // Copy is often typeset with a curly apostrophe; both spell the same word.
    .replace(/'/g, "['\u2019]");
}

/**
 * Which of `words` appear in `text`: whole words, case-insensitive, with their
 * plain inflections. "buying" trips "buy", "stopped" trips "stop" (doubled
 * consonant), "reducing" trips "reduce" (dropped e). "address" does not trip
 * "add", "longer" does not trip "long", and "target_open_at" does not trip
 * "target": an underscore is part of an identifier, not a word boundary.
 *
 * Ported from the Screen engine's guard (`screen/templates.ts`) so both sides
 * of the app mean the same thing by "uses the word".
 */
export function bannedWordHits(text: string, words: readonly string[]): string[] {
  const hits: string[] = [];
  for (const word of words) {
    const base = word.trim().toLowerCase();
    if (!base) continue;

    const forms: string[] = [];
    if (UNINFLECTED.has(base)) {
      forms.push(escapeForRegex(base));
    } else {
      const last = escapeForRegex(base.slice(-1));
      // The doubled consonant only ever precedes -ed / -ing ("trimmed"), so it
      // is tied to them; left optional on its own it would accept "stopp".
      forms.push(`${escapeForRegex(base)}(?:s|es|ed|ing|${last}ed|${last}ing)?`);
      if (base.endsWith("e")) forms.push(`${escapeForRegex(base.slice(0, -1))}(?:ed|ing)`);
      if (base.endsWith("y")) forms.push(`${escapeForRegex(base.slice(0, -1))}i(?:ed|es)`);
    }
    for (const irregular of IRREGULAR_FORMS[base] ?? []) forms.push(escapeForRegex(irregular));

    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(?:${forms.join("|")})(?=$|[^\\p{L}\\p{N}_])`, "iu");
    if (re.test(text)) hits.push(word);
  }
  return hits;
}

/**
 * Source with comments removed, so a note to a developer is never mistaken for
 * something a reader sees. A `//` only opens a comment at the start of a line
 * or after whitespace, which is what keeps "https://..." intact.
 */
export function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** Index of the quote that closes the one at `open`, or -1 when the line ends first. */
function closingQuote(src: string, open: number): number {
  const quote = src[open];
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\n") return -1;
    if (c === quote) return i;
  }
  return -1;
}

/**
 * Walks code from `from`, collecting literals. With `untilBrace` it stops at
 * the `}` that closes a template interpolation and returns the index after it.
 */
function scanCode(src: string, from: number, out: string[], untilBrace: boolean): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (untilBrace && c === "{") depth++;
    if (untilBrace && c === "}") {
      if (depth === 0) return i + 1;
      depth--;
    }
    if (c === '"' || c === "'") {
      const end = closingQuote(src, i);
      if (end !== -1) {
        out.push(src.slice(i + 1, end));
        i = end + 1;
        continue;
      }
      // No closing quote on the line: an apostrophe in JSX text ("Don't"),
      // not a string. Stepping over the one character keeps the scan in step.
    } else if (c === "`") {
      i = scanTemplate(src, i, out);
      continue;
    }
    i++;
  }
  return i;
}

function scanTemplate(src: string, open: number, out: string[]): number {
  const nested: string[] = [];
  let i = open + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      out.push(src.slice(open + 1, i), ...nested);
      return i + 1;
    }
    if (c === "$" && src[i + 1] === "{") {
      i = scanCode(src, i + 2, nested, true);
      continue;
    }
    i++;
  }
  return open + 1;
}

/**
 * Every "...", '...' and template literal body in the code, in source order.
 * A template's body is returned raw, `${...}` included, followed by the
 * literals found inside its interpolations.
 *
 * One pass with quote state rather than three independent regexes: run
 * separately, the single-quote pattern pairs the apostrophes of two different
 * double-quoted sentences on one line ("the book's" ... "today's") and reports
 * the code between them as a string.
 */
export function literals(src: string): string[] {
  const out: string[] = [];
  scanCode(src, 0, out, false);
  return out;
}

/**
 * Exact literals that are code, not copy, and collide with a banned word.
 *
 * Minimal on purpose: every entry is a blind spot, because a one-word label
 * spelled the same way passes too. Code values that collide with nothing
 * ("Escape", "numeric", "2-digit") need no entry, since no rule can fire on
 * them.
 */
export const NON_COPY_LITERALS: ReadonlySet<string> = new Set([
  // KeyboardEvent.key for the return key: `e.key === "Enter"`.
  "Enter",
  // Intl.DateTimeFormat option values (`weekday: "long"`, `month: "short"`),
  // and the two values of the briefing contract's position `side`.
  "long",
  "short",
  // Reducer action types and change-list verbs (`{ type: "add" }`).
  "add",
  // The SVG gradient element name, as passed to createElementNS.
  "stop",
]);

/**
 * Whether a literal reads as prose or as a label: it has a space, it ends in
 * sentence punctuation, or it is one capitalised word ("Overnight", "SELL").
 * A single lower-case token is a class name, a key or an enum value. The
 * capitalised case is included because the most direct breach of the advice
 * rule is a one-word button label, and it has no space to be caught by.
 */
export function looksLikeCopy(literal: string): boolean {
  const text = literal.trim();
  if (text === "") return false;
  if (/\s/.test(text)) return true;
  if (/[.!?:;,\u2026]$/.test(text)) return true;
  return /^\p{Lu}[\p{L}'\u2019]*$/u.test(text);
}

const CLASS_TOKEN = /^[a-z0-9:/[\].#%_()!,-]+$/;

/**
 * A Tailwind-looking class string: every token is lower-case utility
 * characters and at least one carries a "-" or ":". Such strings are full of
 * rule words that are not prose ("stop-0", "from-10%", "long-press:").
 *
 * A token ending in "." or "," disqualifies the whole string. No utility ends
 * that way, while an all-lower-case sentence fragment with a hyphenated word
 * ("no long-term data.") otherwise fits the pattern and would go unchecked.
 */
export function looksLikeClassList(literal: string): boolean {
  const tokens = literal
    .trim()
    // An arbitrary value keeps its own casing ("bg-[#E5E7EB]"); what sits
    // inside the brackets says nothing about whether the token is a utility.
    .replace(/\[[^\]\s]*\]/g, "[]")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (!tokens.every((t) => CLASS_TOKEN.test(t) && !/[.,]$/.test(t))) return false;
  return tokens.some((t) => t.includes("-") || t.includes(":"));
}

/**
 * Blanks out `${...}` so the code inside an interpolation is not read as
 * prose: `${event.target.value}` is not a sentence about a target. Repeated
 * until stable so an object literal inside an interpolation goes too.
 */
function withoutInterpolations(literal: string): string {
  let text = literal;
  for (;;) {
    const next = text.replace(/\$?\{[^{}]*\}/g, " ");
    if (next === text) return text;
    text = next;
  }
}

/** A dash typed as an escape is still a dash on screen. */
function withDashEscapesResolved(literal: string): string {
  return literal
    .replace(/\\u2014|\\u\{2014\}/gi, EM_DASH)
    .replace(/\\u2013|\\u\{2013\}/gi, EN_DASH);
}

export type CopyRuleOptions = {
  /** Also apply RISK_SENTENCE_WORDS. Off by default: most labels are not risk sentences. */
  riskWords?: boolean;
  /**
   * Also check the text between JSX tags, which is copy that never appears as
   * a literal. Opt-in because finding it is a heuristic (see `jsxText`).
   */
  jsxText?: boolean;
};

/**
 * The typographic rule, and it has no exception. A dash on its own used to be
 * waved through as the "no value" mark, which left the one guard there is
 * blind exactly where the rule was being broken: a table cell printing a bare
 * em dash is still an em dash on screen. A missing value is written with the
 * view's own `NOT_AVAILABLE` instead.
 */
function dashProblems(text: string): string[] {
  const resolved = withDashEscapesResolved(text);
  const problems: string[] = [];
  if (resolved.includes(EM_DASH)) problems.push(`em dash: ${text}`);
  if (resolved.includes(EN_DASH)) problems.push(`en dash: ${text}`);
  return problems;
}

/**
 * The rules applied to one string: a literal lifted from source, or a string
 * taken from built output (a demo report, a view model). Dashes are reported
 * in anything; banned words only in what `looksLikeCopy`.
 */
export function textProblems(text: string, opts: CopyRuleOptions = {}): string[] {
  if (NON_COPY_LITERALS.has(text)) return [];
  const prose = withoutInterpolations(text);
  if (looksLikeClassList(prose)) return [];

  const problems = dashProblems(text);
  if (looksLikeCopy(prose)) {
    const words = opts.riskWords ? [...ADVICE_WORDS, ...RISK_SENTENCE_WORDS] : ADVICE_WORDS;
    for (const hit of bannedWordHits(prose, words)) problems.push(`banned word "${hit}": ${text}`);
  }
  return problems;
}

/**
 * Text that sits between JSX tags. A heuristic, not a parser: a run between
 * ">" and "<" is kept only when nothing in it looks like code (brackets,
 * operators, quotes, member access), so `a > b && c < d` and `Map<K, V>()`
 * fall out. It errs toward missing prose rather than reporting code, because
 * a guard that cries wolf gets switched off.
 */
export function jsxText(src: string): string[] {
  const out: string[] = [];
  for (const match of src.matchAll(/>([^<>]+)</g)) {
    const text = withoutInterpolations(match[1]).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    if (/[(){};=&|"`\\]/.test(text) || /[\p{L}\p{N}_]\.[\p{L}_]/u.test(text)) continue;
    out.push(text);
  }
  return out;
}

/**
 * Every rule breach in one source text, one line per breach; empty means the
 * copy is clean. Comments are stripped first, so a developer note can use any
 * word it likes.
 */
export function copyProblems(src: string, opts: CopyRuleOptions = {}): string[] {
  const code = withoutComments(src);
  const problems: string[] = [];
  for (const literal of literals(code)) problems.push(...textProblems(literal, opts));

  if (opts.jsxText) {
    const words = opts.riskWords ? [...ADVICE_WORDS, ...RISK_SENTENCE_WORDS] : ADVICE_WORDS;
    for (const text of jsxText(code)) {
      problems.push(...dashProblems(text));
      // Text between tags is on screen whatever its shape, so one lower-case
      // word is checked too; `looksLikeCopy` is for telling literals apart.
      for (const hit of bannedWordHits(text, words)) problems.push(`banned word "${hit}": ${text}`);
    }
  }
  return problems;
}
