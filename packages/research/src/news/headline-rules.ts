/**
 * The rules a headline Falcon shows has to follow, as functions.
 *
 * A story's row title is written by Falcon, not by the publisher: who did
 * what, with the key figure when the article has one, and nothing that pulls
 * at the reader. This file is what makes that hold whatever wrote the line
 * (the model, the classifier's event label, a press-release wire): it cleans
 * the typography, then lists every rule the line still breaks. An empty list
 * means the line can be shown.
 *
 * The house copy rules live in the desktop app
 * (apps/desktop/src/shared/copy-rules.ts) and research cannot import from an
 * app, so the parts a headline needs are mirrored here: `plainDashes`, the
 * advice and forward-looking word lists, the brand words and the
 * whole-word matcher. A desktop test holds the two copies equal
 * (news-headline-rules-parity.test.ts). The figure check mirrors the agents
 * engine's grounding (apps/desktop/src/main/agents/grounding.ts).
 *
 * English only: the word lists are English, so a headline is written and
 * checked in English.
 */

export const HEADLINE_MAX_LENGTH = 90;
/** Shorter than this is a label, not a headline ("Nvidia news"). */
export const HEADLINE_MIN_LENGTH = 12;

export const EM_DASH = "—";
export const EN_DASH = "–";

/** Mirrors copy-rules.ts `plainDashes`: ranges read "2 to 3", a clause dash is a comma, any other dash a hyphen. */
export function plainDashes(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[—―]\s*/g, ", ")
    .replace(/[‒–―−]/g, "-")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.?;:])/g, "$1")
    .replace(/^,\s*/gm, "");
}

/** Mirrors copy-rules.ts ADVICE_WORDS. */
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

/** Mirrors copy-rules.ts RISK_SENTENCE_WORDS (the forward-looking list). */
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

/** Mirrors copy-rules.ts MARKET_AI_NOUNS. */
export const MARKET_AI_NOUNS: readonly string[] = [
  "semiconductor",
  "semiconductors",
  "revenue",
  "revenues",
  "infrastructure",
  "server",
  "servers",
  "accelerator",
  "accelerators",
  "chip",
  "chips",
  "demand",
  "capex",
  "spending",
  "spend",
  "datacenter",
  "datacenters",
  "networking",
  "segment",
  "sales",
  "compute",
  "workloads",
];

const UNINFLECTED = new Set(["should", "will", "likely", "may"]);

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
    .replace(/'/g, "['’]");
}

/** Mirrors copy-rules.ts `bannedWordHits`: whole words, any case, plain inflections. */
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

const AI_ACRONYM = /(^|[^\p{L}\p{N}_'’])(?:A[Ii]|aI|A\.I\.?)(?=$|[^\p{L}\p{N}_])/gu;

/** Mirrors copy-rules.ts `brandWordHits`: "edge", and "AI" unless it names a line of business. */
export function brandWordHits(text: string): string[] {
  const hits: string[] = [];
  if (bannedWordHits(text, ["edge"]).length > 0) hits.push("edge");
  for (const m of text.matchAll(AI_ACRONYM)) {
    const after = text.slice((m.index ?? 0) + m[0].length);
    const next = /^\s+([\p{L}]+)/u.exec(after)?.[1]?.toLowerCase();
    if (next && MARKET_AI_NOUNS.includes(next)) continue;
    hits.push("AI");
    break;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Figures (mirrors apps/desktop/src/main/agents/grounding.ts)
// ---------------------------------------------------------------------------

type FoundNumber = { value: number; decimals: number; raw: string };

const LABELS = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b[QH][1-4]\b|\bFY\s?\d{2,4}\b|\b\d{1,2}:\d{2}\b/gi;

function numbersIn(text: string): FoundNumber[] {
  const out: FoundNumber[] = [];
  const stripped = text.replace(LABELS, " ");
  for (const m of stripped.matchAll(/(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])\d+(?:\.\d+)?/g)) {
    const raw = m[0];
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const decimals = raw.includes(".") ? raw.split(".")[1]!.length : 0;
    out.push({ value, decimals, raw });
  }
  return out;
}

function isCheckable(n: FoundNumber): boolean {
  if (n.decimals === 0 && n.value < 10) return false;
  if (n.decimals === 0 && n.value >= 1900 && n.value <= 2100) return false;
  return true;
}

const SCALES = [1, 1e3, 1e-3, 1e6, 1e-6, 1e9, 1e-9];

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function isGrounded(n: FoundNumber, corpus: readonly number[]): boolean {
  if (!isCheckable(n)) return true;
  for (const c of corpus) {
    for (const s of SCALES) {
      const scaled = c * s;
      if (roundTo(scaled, n.decimals) === n.value) return true;
      if (n.decimals > 0 && Math.abs(scaled - n.value) <= 0.5 * 10 ** -n.decimals + 1e-9) return true;
    }
  }
  return false;
}

/** The figures in `text` that `source` does not contain (in any unit, at the shown precision). */
export function ungroundedFigures(text: string, source: string): string[] {
  const corpus = [...new Set(numbersIn(source).map((n) => n.value))];
  return numbersIn(text)
    .filter((n) => !isGrounded(n, corpus))
    .map((n) => n.raw);
}

// ---------------------------------------------------------------------------
// Headline-specific rules
// ---------------------------------------------------------------------------

/**
 * Words that sell the move instead of stating it. A headline says "falls 12%",
 * not "plunges 12%"; "stunning" and "massive" carry no information at all.
 * Words that are also company names ("Rocket", "Monster", "Epic") or plain
 * economics ("shock" in "supply shock") are left off on purpose.
 */
export const HYPE_WORDS: readonly string[] = [
  "soar",
  "skyrocket",
  "plunge",
  "plummet",
  "crater",
  "explode",
  "crush",
  "slam",
  "smash",
  "obliterate",
  "stun",
  "stunning",
  "shocking",
  "massive",
  "huge",
  "blockbuster",
  "jaw-dropping",
  "insane",
  "incredible",
  "unbelievable",
  "game-changer",
  "game changer",
  "bombshell",
  "mind-blowing",
  "spectacular",
  "staggering",
  "astonishing",
  "meteoric",
  "frenzy",
  "mania",
  "bloodbath",
  "carnage",
  "meltdown",
  "must-see",
  "breaking",
];

/** Shapes that are a hook, a list or a recap rather than a report. */
const CLICKBAIT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:here'?s|here is|this is) (?:why|how|what)\b/i, "clickbait phrase"],
  [/\bwhat (?:you need to|to) know\b/i, "clickbait phrase"],
  [/\b(?:you|your|you're|you'll|you've)\b/i, "addresses the reader"],
  [/\bstocks? to watch\b/i, "stocks to watch"],
  [/\b(?:top|these|the)\s+\d+\s+(?:stocks|reasons|things|ways|picks|names|charts)\b/i, "listicle"],
  [/^\d+\s+(?:stocks|reasons|things|ways|picks|names|charts)\b/i, "listicle"],
  [/\bwhy\b.*\b(?:stock|shares)\b.*\b(?:is|are|was|were)\s+(?:up|down|climbing|falling|rising|sliding|jumping|dropping|moving|trading|gaining)\b/i, "price recap"],
  [/\b(?:is it time|is now the time|should investors)\b/i, "advice question"],
  [/\b(?:secret|revealed|you won'?t believe|find out|don'?t miss)\b/i, "clickbait phrase"],
];

/**
 * Speculation the house lists do not cover: a headline reports what happened
 * or what was said, not what could. ("Will" and "may" are on the
 * forward-looking list already.)
 */
const SPECULATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:could|might|would)\b/i, "speculation"],
  [/\b(?:poised to|set to|on track to|is about to|are about to|on the verge of)\b/i, "speculation"],
];

/** Everything that makes the reader the subject, or the line a question. */
function punctuationIssues(text: string): string[] {
  const issues: string[] = [];
  if (text.includes(EM_DASH)) issues.push("em dash");
  if (text.includes(EN_DASH)) issues.push("en dash");
  if (text.includes("?")) issues.push("question");
  if (text.includes("!")) issues.push("exclamation mark");
  if (/\p{Extended_Pictographic}/u.test(text)) issues.push("emoji");
  if (/https?:\/\/|\bwww\./i.test(text)) issues.push("link");
  return issues;
}

const PICTOGRAPH = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/**
 * Word swaps that keep the meaning and drop a listed word, the same ones the
 * agents engine uses (apps/desktop/src/main/agents/copy.ts `softenCopy`),
 * limited to what a headline plausibly carries. "Sells" and "buys" are not
 * swapped: in a headline they are as often "sells out" or "sells 10 million
 * phones" as a trade, so the model is told to avoid them and a line that still
 * uses them goes back to it.
 */
const SOFTENERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bprice targets\b/gi, "price estimates"],
  [/\bprice target\b/gi, "price estimate"],
  [/\bexpects\b/gi, "anticipates"],
  [/\bexpected\b/gi, "anticipated"],
  [/\bforecasts\b/gi, "projections"],
  [/\bforecast\b/gi, "projection"],
  [/\breduced\b/gi, "lowered"],
  [/\breduces\b/gi, "lowers"],
  [/\breducing\b/gi, "lowering"],
  [/\bsignals\b/gi, "indicates"],
  [/\bsignaled\b/gi, "indicated"],
  [/\bsignalled\b/gi, "indicated"],
];

function keepCase(match: string, replacement: string): string {
  return /^[A-Z]/.test(match) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

/** "AI" that is not a line of business is spelled out, so the brand rule holds without losing the fact. */
function spellOutAi(text: string): string {
  return text.replace(AI_ACRONYM, (match, lead: string, offset: number, whole: string) => {
    const after = whole.slice(offset + match.length);
    const next = /^\s+([\p{L}]+)/u.exec(after)?.[1]?.toLowerCase();
    if (next && MARKET_AI_NOUNS.includes(next)) return match;
    return `${lead}artificial intelligence`;
  });
}

/**
 * Typography and swaps, never a change of fact: whitespace collapsed, dashes
 * made plain, emoji and exclamation marks dropped, softeners applied, wrapping
 * quotes and a trailing full stop removed.
 */
export function cleanHeadline(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
  text = plainDashes(text);
  text = text.replace(PICTOGRAPH, "").replace(/!+/g, "");
  for (const [re, replacement] of SOFTENERS) text = text.replace(re, (m) => keepCase(m, replacement));
  text = spellOutAi(text);
  text = text.replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
  // Wrapping quotes and a closing full stop, in whatever order they ended up.
  text = text.replace(/^["'“‘\s]+/, "").replace(/[\s.;:,"”’]+$/, "");
  return text.trim();
}

/**
 * Every rule `headline` breaks, one line each; empty means it can be shown.
 * `source` is the article text the line was written from (publisher headline
 * and summary): every figure in the headline has to appear in it. Pass null
 * to skip the figure check (a line built from fixed parts carries no figure
 * of its own).
 */
export function headlineIssues(headline: string, source: string | null): string[] {
  const issues: string[] = [];
  const text = headline.trim();
  if (!text) return ["empty"];
  if (text.length > HEADLINE_MAX_LENGTH) issues.push(`longer than ${HEADLINE_MAX_LENGTH} characters`);
  if (text.length < HEADLINE_MIN_LENGTH || text.split(/\s+/).length < 3) issues.push("too short to say who did what");
  issues.push(...punctuationIssues(text));
  for (const hit of bannedWordHits(text, ADVICE_WORDS)) issues.push(`advice word "${hit}"`);
  for (const hit of bannedWordHits(text, RISK_SENTENCE_WORDS)) issues.push(`forward-looking word "${hit}"`);
  for (const hit of brandWordHits(text)) issues.push(`banned word "${hit}"`);
  for (const hit of bannedWordHits(text, HYPE_WORDS)) issues.push(`hype word "${hit}"`);
  for (const [re, label] of CLICKBAIT) if (re.test(text)) issues.push(label);
  for (const [re, label] of SPECULATION) if (re.test(text)) issues.push(label);
  if (/\b(?:falcon|chatgpt|claude|language model)\b/i.test(text)) issues.push("names the writer");
  if (/^[^a-z]*$/.test(text) && /[A-Z]{3,}\s+[A-Z]{3,}\s+[A-Z]{3,}/.test(text)) issues.push("all capitals");
  if (source !== null) {
    for (const figure of ungroundedFigures(text, source)) issues.push(`figure ${figure} is not in the article`);
  }
  return [...new Set(issues)];
}

/** Clean, then check: the line to show, or the reasons it cannot be shown. */
export function vetHeadline(
  raw: unknown,
  source: string | null,
): { ok: true; headline: string } | { ok: false; headline: string; issues: string[] } {
  const headline = cleanHeadline(raw);
  const issues = headlineIssues(headline, source);
  return issues.length === 0 ? { ok: true, headline } : { ok: false, headline, issues };
}
