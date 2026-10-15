import {
  ADVICE_WORDS,
  EM_DASH,
  EN_DASH,
  RISK_SENTENCE_WORDS,
  bannedWordHits,
  plainDashes,
} from "../../shared/copy-rules";

/**
 * House copy rules applied to what the model writes for an agent.
 *
 * The prompt states the rules; this file is what makes them hold when the
 * model forgets. Three steps, in order of how much they change the text:
 *
 *   cleanModelText   typography and tics: dashes, emoji, exclamation marks,
 *                    filler openers and sign-offs, "delve", month names that
 *                    collide with the forward-looking word list.
 *   softenCopy       word swaps that keep the meaning: "fell short of" to
 *                    "came in below", "sold" to "disposed of", "expects" to
 *                    "anticipates".
 *   dropOffending    the last resort: sentences that still break a rule go.
 *
 * `copyIssues` is the check the engine runs between them, and the list it
 * returns is what the model is shown when it is asked to write again.
 */

/** Both word lists: an agent's write-up is description and outlook at once. */
export const AGENT_BANNED_WORDS: readonly string[] = [...ADVICE_WORDS, ...RISK_SENTENCE_WORDS];

const PICTOGRAPH = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu;

/** Openers and sign-offs that announce a chatbot rather than say anything. */
const FILLER_SENTENCES: readonly RegExp[] = [
  /^(great|good|excellent|interesting) question\b/i,
  /^(certainly|sure|absolutely|of course|happy to help|glad you asked)\b/i,
  /^(as an ai|i am an ai|i'm an ai|i'm your ai|i am your ai)\b/i,
  /^i hope (this|that) helps\b/i,
  /^(let me know|feel free|don't hesitate)\b/i,
  /^(in summary|in conclusion|overall),?\s*$/i,
];

/**
 * Splits prose into sentences, keeping the terminator with each; paragraph
 * breaks come back as "\n\n" entries. A sentence ends at ".", "?" or "!"
 * followed by whitespace, so "$30.8" stays whole, and a single-letter
 * abbreviation ("U.S.") does not end one.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const merged: string[] = [];
    for (const part of para.split(/(?<=[.?!])\s+/)) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && /(^|[\s(])(?:[A-Za-z]\.){2,3}$/.test(prev)) {
        merged[merged.length - 1] = `${prev} ${part}`;
      } else {
        merged.push(part);
      }
    }
    out.push(...merged.map((s) => s.trim()).filter(Boolean));
    out.push("\n\n");
  }
  out.pop();
  return out;
}

function joinSentences(parts: string[]): string {
  return parts
    .join(" ")
    .replace(/ ?\n\n ?/g, "\n\n")
    .replace(/(\n\n){2,}/g, "\n\n")
    .trim();
}

/** Typography and chatbot tics, removed without changing what is said. */
export function cleanModelText(raw: string): string {
  let text = typeof raw === "string" ? raw : "";
  text = text.replace(/\r\n?/g, "\n");
  // Ranges first: "2025–2026" reads as "2025 to 2026", not "2025, 2026";
  // then a long dash between clauses is a comma, any other dash a hyphen.
  text = plainDashes(text);
  text = text.replace(PICTOGRAPH, "");
  text = text.replace(/!+/g, ".");
  text = text.replace(/\bdelve(s|d)? into\b/gi, (_m, s: string | undefined) => (s === "d" ? "looked at" : s ? "looks at" : "look at"));
  text = text.replace(/\bdelv(e|es|ed|ing)\b/gi, "look");
  // A month name that is also a forward-looking word: write the date numerically.
  text = text.replace(/\bMay (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?/g, (_m, d: string, y?: string) =>
    y ? `${y}-05-${d.padStart(2, "0")}` : `5/${d}`,
  );
  const kept = sentences(text).filter((s) => s === "\n\n" || !FILLER_SENTENCES.some((re) => re.test(s)));
  return joinSentences(kept)
    .replace(/\s+,/g, ",")
    .replace(/[ \t]+([.?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Every rule the text breaks, one line each; empty means clean. */
export function copyIssues(text: string): string[] {
  const issues: string[] = [];
  if (text.includes(EM_DASH)) issues.push("em dash");
  if (text.includes(EN_DASH)) issues.push("en dash");
  if (/!/.test(text)) issues.push("exclamation mark");
  if (/\p{Extended_Pictographic}/u.test(text)) issues.push("emoji");
  for (const hit of bannedWordHits(text, AGENT_BANNED_WORDS)) issues.push(`banned word "${hit}"`);
  return issues;
}

/** Swaps that keep the meaning and drop the banned word. Order matters: phrases first. */
const SOFTENERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:fell|falls|fall|came|comes|come) (?:up )?short of\b/gi, "came in below"],
  [/\bshort of\b/gi, "below"],
  [/\bsell-side\b/gi, "brokerage"],
  [/\bbuy-side\b/gi, "institutional"],
  [/\blong-term\b/gi, "multi-year"],
  [/\bshort-term\b/gi, "near-term"],
  [/\bprice targets\b/gi, "analyst price estimates"],
  [/\bprice target\b/gi, "analyst price estimate"],
  [/\btargets\b/gi, "goals"],
  [/\btargeted\b/gi, "aimed at"],
  [/\btargeting\b/gi, "aiming at"],
  [/\btarget\b/gi, "goal"],
  [/\bsignals\b/gi, "signs"],
  [/\bsignall?ed\b/gi, "indicated"],
  [/\bsignall?ing\b/gi, "indicating"],
  [/\bsignal\b/gi, "sign"],
  [/\bsold\b/gi, "disposed of"],
  [/\bsells\b/gi, "disposes of"],
  [/\bselling\b/gi, "disposing of"],
  [/\bsell\b/gi, "dispose of"],
  [/\bbought\b/gi, "purchased"],
  [/\bbuys\b/gi, "purchases"],
  [/\bbuying\b/gi, "purchasing"],
  [/\bbuy\b/gi, "purchase"],
  [/\badded\b/gi, "gained"],
  [/\badds\b/gi, "gains"],
  [/\badding\b/gi, "gaining"],
  [/\btrimmed\b/gi, "cut"],
  [/\btrims\b/gi, "cuts"],
  [/\bentered into\b/gi, "signed"],
  [/\bexited\b/gi, "left"],
  [/\bexpects\b/gi, "anticipates"],
  [/\bexpected\b/gi, "anticipated"],
  [/\bexpecting\b/gi, "anticipating"],
  [/\bexpect\b/gi, "anticipate"],
  [/\bforecasts\b/gi, "projections"],
  [/\bforecasted\b/gi, "projected"],
  [/\bforecast\b/gi, "projection"],
  [/\breduced\b/gi, "lowered"],
  [/\breduces\b/gi, "lowers"],
  [/\breducing\b/gi, "lowering"],
  [/\breduce\b/gi, "lower"],
  [/\bconsidered\b/gi, "regarded"],
  [/\bis scheduled to\b/gi, "is set to"],
];

function keepCase(match: string, replacement: string): string {
  return /^[A-Z]/.test(match) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

export function softenCopy(text: string): string {
  let out = text;
  for (const [re, replacement] of SOFTENERS) {
    out = out.replace(re, (match, ...groups) => {
      const expanded = replacement.replace(/\$(\d)/g, (_m, n: string) => {
        const g = groups[Number(n) - 1];
        return typeof g === "string" ? g : "";
      });
      return keepCase(match, expanded);
    });
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** Sentences that still break a rule are removed; paragraphs are kept. */
export function dropOffending(text: string, alsoDrop: (sentence: string) => boolean = () => false): string {
  const kept = sentences(text).filter((s) => s === "\n\n" || (copyIssues(s).length === 0 && !alsoDrop(s)));
  return joinSentences(kept);
}

/**
 * The whole deterministic pass for one field: clean, then soften and drop
 * only if the text still breaks a rule. Returns "" when nothing survives,
 * so the caller can put its own fallback line in.
 */
export function enforceCopy(text: string, alsoDrop?: (sentence: string) => boolean): string {
  const cleaned = cleanModelText(text);
  const needsWork = copyIssues(cleaned).length > 0 || (alsoDrop ? sentences(cleaned).some((s) => s !== "\n\n" && alsoDrop(s)) : false);
  if (!needsWork) return cleaned;
  const softened = copyIssues(cleaned).length > 0 ? softenCopy(cleaned) : cleaned;
  return dropOffending(softened, alsoDrop);
}

/** A one-line field (headline, value) that must not come back empty. */
export function enforceLine(text: string, fallback: string): string {
  const out = enforceCopy(text.replace(/\s*\n+\s*/g, " "));
  return out || fallback;
}
