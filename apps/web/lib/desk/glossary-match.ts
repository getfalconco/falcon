/**
 * Finds glossary terms (lib/desk/glossary.ts) in Falcon AI's replies for the
 * highlighted, hoverable terms (lab/Markdown.tsx, lab/TermPopover.tsx).
 *
 * Matching rules:
 * - Case-insensitive with Turkish-aware folding: I, ı, İ and i all fold to
 *   "i", â/î/û to a/i/u, curly apostrophes to "'". Folding keeps the length,
 *   so offsets map straight back to the original text. Forms written with a
 *   leading "=" in the glossary (IV, ATM, VaR, 8-K...) match case exactly.
 * - Longest form first: "IV çöküşü" wins over "IV", "max drawdown" over
 *   "drawdown". A match must start and end on a word edge.
 * - Turkish forms take Turkish suffixes ("IV çöküşünü", "oynaklığı" via the
 *   k→ğ / ç→c softening, "örneklem dışında"); English forms take an apostrophe
 *   suffix ("skew'i", "Sharpe'ı", "8-K'da") or a plural s/es.
 * - Only the first occurrence of each term is reported (the caller passes one
 *   `seen` set per reply), and nothing inside a bare URL.
 * - Explicit markup from the model: `[label](term:key "current value")`.
 *   Only a known key makes a term; the label and the value never change the
 *   definition, which always comes from the glossary. The value is plain text,
 *   80 characters at most.
 */

import { GLOSSARY, glossaryEntry } from "./glossary";
import type { GlossaryLang } from "./glossary";

export type TermHit = { start: number; end: number; key: string };

/** Folds one UTF-16 unit; always returns exactly one unit so offsets survive. */
function foldChar(ch: string): string {
  switch (ch) {
    case "I":
    case "ı":
    case "İ":
      return "i";
    case "â":
    case "Â":
      return "a";
    case "î":
    case "Î":
      return "i";
    case "û":
    case "Û":
      return "u";
    case "’":
    case "‘":
    case "ʼ":
      return "'";
    case "–":
    case "‑":
      return "-";
  }
  const lo = ch.toLowerCase();
  return lo.length === 1 ? lo : ch;
}

/** Turkish-aware case fold with the same length as the input. */
export function foldTr(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]!);
  return out;
}

type FormInfo = { key: string; tr: boolean; exact?: string };

const VOWEL = "aeioöuü";
/** A direct (no apostrophe) Turkish suffix starts with a vowel or one of these consonants (-lar, -nın, -sı, -yı, -da, -ta, -cı, -ça, -mı, -ki). */
const TR_SUFFIX = /^[aeioöuülnsydtcçmkğ]\p{L}{0,9}$/u;
const EN_SUFFIX = /^(?:'\p{L}{1,10}|s|es)?$/u;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

let index: { re: RegExp; forms: Map<string, FormInfo[]> } | null = null;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function buildIndex() {
  const forms = new Map<string, FormInfo[]>();
  const add = (raw: string, key: string, tr: boolean) => {
    const exact = raw.startsWith("=") ? raw.slice(1).replace(/\s+/g, " ") : undefined;
    const f = foldTr((exact ?? raw).trim().replace(/\s+/g, " "));
    if (!f) return;
    const list = forms.get(f) ?? [];
    list.push({ key, tr, ...(exact ? { exact } : {}) });
    forms.set(f, list);
  };
  for (const g of GLOSSARY) {
    g.tr.forms.forEach((f) => add(f, g.key, true));
    g.en.forms.forEach((f) => add(f, g.key, false));
  }
  const patterns = Array.from(forms.keys())
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((f) => {
      const tr = forms.get(f)!.some((x) => x.tr);
      let body = escape(f).replace(/ /g, "\\s+");
      // Turkish consonant softening before a vowel suffix: oynaklık → oynaklığı, kazanç → kazancı.
      if (tr && f.length >= 4 && /[kç]$/.test(f)) body = `${body.slice(0, -1)}(?:${f.endsWith("k") ? "k|ğ" : "ç|c"}(?=[${VOWEL}]))`;
      return body;
    });
  const re = new RegExp(`(?<![\\p{L}\\p{N}_@#]|\\p{N}[.,])(${patterns.join("|")})('\\p{L}{1,10}|\\p{L}{0,10})(?![\\p{L}\\p{N}])`, "gu");
  index = { re, forms };
  return index;
}

/** The glossary key for a matched form (folded text, any spacing, maybe softened), checking exact-case forms against the original. */
function resolve(folded: string, original: string, suffix: string): string | null {
  const { forms } = index ?? buildIndex();
  const norm = folded.replace(/\s+/g, " ");
  const list = forms.get(norm) ?? forms.get(norm.replace(/ğ$/, "k")) ?? forms.get(norm.replace(/c$/, "ç"));
  if (!list) return null;
  const orig = original.replace(/\s+/g, " ");
  for (const f of list) {
    if (f.exact && f.exact !== orig) continue;
    if (!suffix || suffix.startsWith("'") || (f.tr ? TR_SUFFIX : EN_SUFFIX).test(suffix)) return f.key;
  }
  return null;
}

/**
 * Glossary terms in a run of plain text, first occurrence of each key only:
 * keys already in `seen` are skipped and found keys are added to it.
 */
export function findTerms(text: string, seen: Set<string>): TermHit[] {
  if (!text) return [];
  const { re } = index ?? buildIndex();
  const folded = foldTr(text);
  const urls = Array.from(text.matchAll(URL), (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
  const out: TermHit[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded))) {
    const start = m.index;
    const stem = m[1]!;
    const suffix = m[2] ?? "";
    const key = resolve(stem, text.slice(start, start + stem.length), suffix);
    if (!key) {
      re.lastIndex = start + 1;
      continue;
    }
    const end = start + stem.length + suffix.length;
    if (seen.has(key) || urls.some(([a, b]) => start < b && end > a)) continue;
    seen.add(key);
    out.push({ start, end, key });
  }
  return out;
}

/** `[label](term:key "value")`: the model's explicit term markup. */
export const TERM_LINK = /\[([^\]\n]{1,120})\]\(term:([a-z0-9-]{1,40})(?:\s+"([^"\n]{0,400})")?\)/g;

export const MAX_TERM_VALUE = 80;

/** The model's current figure for a term: plain text, Markdown stripped, at most 80 characters. */
export function cleanTermValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/[*_`#<>[\]{}|\\]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX_TERM_VALUE ? `${t.slice(0, MAX_TERM_VALUE - 1).trimEnd()}…` : t;
}

/** One explicit term link: its label, its key when the glossary knows it, and the cleaned value. */
export function parseTermLink(token: string): { label: string; key: string | null; value?: string } | null {
  const m = new RegExp(TERM_LINK.source).exec(token);
  if (!m) return null;
  const key = glossaryEntry(m[2]!) ? m[2]! : null;
  const value = key ? cleanTermValue(m[3]) : undefined;
  return { label: m[1]!, key, ...(value ? { value } : {}) };
}

/** Keys the reply marks explicitly (known keys only), so the marked spot gets the highlight rather than an earlier plain mention. */
export function explicitTermKeys(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of Array.from(markdown.matchAll(TERM_LINK))) if (glossaryEntry(m[2]!)) out.add(m[2]!);
  return out;
}

/**
 * Keys a Markdown text would highlight (for first-occurrence-per-reply across
 * the reply's text parts): code, links and headings are skipped like the renderer does.
 */
export function termKeysIn(markdown: string): Set<string> {
  const seen = explicitTermKeys(markdown);
  const plain = markdown
    .replace(/^\s{0,3}(```|~~~)[\s\S]*?(?:^\s{0,3}\1|$(?![\s\S]))/gm, " ")
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/\[[^\]\n]+\]\((?:https?:|term:|src:)[^)\n]*\)/g, " ");
  findTerms(plain, seen);
  return seen;
}

/** The reply's language for the popup: Turkish when it reads Turkish, else English. */
export function replyLang(text: string): GlossaryLang {
  const sample = text.slice(0, 4000);
  const special = (sample.match(/[çğışöüÇĞİŞÖÜ]/g) ?? []).length;
  const words = (sample.match(/(?:^|\s)(?:ve|bir|bu|için|ile|da|de|olarak|daha|gibi|ama|çok|değil)(?=\s|[.,;:]|$)/gi) ?? []).length;
  return special >= 3 || words >= 3 ? "tr" : "en";
}
