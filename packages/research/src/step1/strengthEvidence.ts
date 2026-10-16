/**
 * What the strength classifier reads for one edge, beyond its first quote.
 *
 * The classifier used to see only the edge's first evidence quote. A filing
 * often names a counterparty in one sentence and states the dependence in
 * another: NVDA names TSMC in "We utilize foundries, such as ... TSMC, and
 * Samsung" (Item 1) and says "We depend on foundries to manufacture our
 * semiconductor wafers" (Item 1A), a sentence that names no foundry. So the
 * classifier now gets:
 *   - every evidence quote of the edge that is found in the filing text (the
 *     pre-audit rule), capped in total length;
 *   - up to two sentences from the same filing section that state dependence
 *     on the category the quotes put the counterparty in ("foundries",
 *     "contract manufacturers", "distributors", ...). These are cut verbatim
 *     from the filing text, never paraphrased, and a sentence that names
 *     another counterparty of the same filer is left out, so it cannot lend
 *     one company's dependence to another.
 *
 * Pure: no I/O, no model calls.
 */
import { normalizeCompanyName, normalizeWhitespace } from "./normalize.js";
import type { StrengthClassifyInput } from "./strength.js";

/** Total characters of evidence quotes sent for one edge (the first quote is always sent whole). */
export const MAX_STRENGTH_QUOTE_CHARS = 1_600;
/** Category dependence sentences sent for one edge. */
export const MAX_DEPENDENCE_SENTENCES = 2;
/** A longer sentence is a run-on list (a risk-factor block), not a statement about one category. */
export const MAX_DEPENDENCE_SENTENCE_CHARS = 400;
/** The category word has to follow the dependence words within this many characters. */
const TERM_AFTER_DEPENDENCE_CHARS = 90;

/**
 * Categories a filer can say it depends on, specific enough that the statement
 * is about the category and not about every supplier or customer: bare
 * "suppliers", "customers" or "partners" are deliberately absent (a "we depend
 * on our suppliers" sentence would lift every supplier edge of the filer).
 */
export const DEPENDENCE_CATEGORY_TERMS: ReadonlyArray<{ key: string; re: RegExp }> = [
  // Not "wafers": filers also say they rely on wafers as a material, or are the sole source of their own.
  { key: "foundry", re: /\bfoundr(?:y|ies)\b/i },
  { key: "contract manufacturer", re: /\b(?:contract|third[- ]party) manufactur(?:ers?|ing (?:organizations?|partners?))\b|\bCMOs?\b|\bCDMOs?\b/i },
  { key: "subcontractor", re: /\bsubcontractors?\b/i },
  { key: "assembly and test", re: /\bassembly(?:,)? (?:and )?test(?:ing)?\b|\bOSATs?\b/i },
  { key: "memory", re: /\bmemory\b/i },
  { key: "distributor", re: /\bdistributors?\b/i },
  { key: "wholesaler", re: /\bwholesalers?\b/i },
  { key: "pharmacy benefit manager", re: /\bpharmacy benefit managers?\b|\bPBMs?\b/i },
  { key: "cloud provider", re: /\b(?:cloud|hyperscale)(?: service| computing| infrastructure)? providers?\b|\bhyperscalers?\b/i },
  { key: "carrier", re: /\b(?:wireless|mobile|network|telecommunications) carriers?\b/i },
  { key: "payment network", re: /\b(?:payment|card) networks?\b/i },
  { key: "licensor", re: /\blicensors?\b/i },
  { key: "oem", re: /\bOEMs?\b|\bODMs?\b|\boriginal (?:equipment|design) manufacturers?\b/i },
  { key: "reseller", re: /\bresellers?\b|\bchannel partners?\b/i },
];

/** Words that state a dependence on what follows them. */
const DEPENDENCE =
  /\b(?:depend(?:s|ed|ent|ence|ency|ing)?\s+(?:up)?on|rel(?:y|ies|ied|iance|iant|ying)\s+(?:up)?on|sole[- ]source[sd]?|single[- ]source[sd]?|sole suppliers?|single suppliers?|limited number (?:of|and)|small number of|only (?:one|two|a few)|substantially all of our)\b/gi;

/**
 * Kinds of third party a sentence can list after the dependence words. A
 * sentence that lists more than MAX_KINDS_IN_DEPENDENCE of them ("we rely on
 * third parties, including suppliers, distributors, alliances ...") is
 * boilerplate about everyone, not a dependence on one category.
 */
const GENERIC_KINDS = /\b(?:suppliers?|supplies|services|vendors?|third parties|service providers?|partners?|providers?|manufacturers?|alliances?|collaborat\w+|transportation|raw materials|logistics)\b/gi;
const MAX_KINDS_IN_DEPENDENCE = 2;

/** A first-person subject before the dependence words: "We depend on", "our reliance on". */
const FIRST_PERSON = /\b(?:we|our|us)\b/i;

/** Relationship categories a dependence sentence can strengthen. A competitor is never a dependence. */
const DEPENDENCE_CATEGORIES = new Set(["supplier", "dependency", "partner", "customer"]);

/** Abbreviations a period does not end a sentence after. */
const ABBREVIATION = /(?:\b(?:Inc|Co|Corp|Ltd|Ltda|Bros|No|Nos|vs|Mr|Ms|Mrs|Dr|St|Jr|Sr|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)|\b[A-Z]|\b(?:e\.g|i\.e|U\.S|U\.K|L\.P|N\.V|S\.A))\.$/;

/** The category keys a set of quotes puts a counterparty in. */
export function categoryTermsInQuotes(quotes: readonly string[]): string[] {
  const keys: string[] = [];
  for (const { key, re } of DEPENDENCE_CATEGORY_TERMS) {
    if (quotes.some((q) => re.test(q))) keys.push(key);
  }
  return keys;
}

/**
 * Sentence-like units of a (whitespace-normalized) text with their offsets:
 * split after ". ", "? ", "! ", "; " and at bullets, but not after a legal
 * form or other abbreviation ("Co., Ltd., or Samsung").
 */
export function filingSentences(text: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: start + lead });
  };
  const boundary = /[.!?;](?=\s)|\s?[•●▪◦■]\s?/g;
  for (const m of text.matchAll(boundary)) {
    const at = m.index!;
    if (m[0] === ".") {
      // "Co., Ltd., or Samsung" / "U.S. government": not an end.
      if (ABBREVIATION.test(text.slice(Math.max(0, at - 12), at + 1))) continue;
      // A lowercase continuation is the same sentence ("approx. two").
      const next = text.slice(at + 1).trimStart()[0] ?? "";
      if (next && /[a-z]/.test(next)) continue;
    }
    const end = /^[.!?;]$/.test(m[0]) ? at + 1 : at;
    push(end);
    start = at + m[0].length;
  }
  push(text.length);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `sentence` names `name`: the whole normalized name as words, or
 * its first word (4+ letters) written capitalized, as a name is.
 */
export function sentenceNames(name: string, sentence: string): boolean {
  const norm = normalizeCompanyName(name);
  if (!norm) return false;
  const normSentence = ` ${normalizeCompanyName(sentence)} `;
  if (normSentence.includes(` ${norm} `)) return true;
  const first = norm.split(" ")[0] ?? "";
  if (first.length < 4) return false;
  const cap = first[0]!.toUpperCase() + first.slice(1);
  return new RegExp(`\\b(?:${escapeRegExp(cap)}|${escapeRegExp(first.toUpperCase())})\\b`).test(sentence);
}

/** How many kinds of third party `span` names: the known categories plus the generic kinds. */
function kindsNamed(span: string): number {
  const kinds = new Set<string>();
  for (const { key, re } of DEPENDENCE_CATEGORY_TERMS) if (re.test(span)) kinds.add(key);
  for (const m of span.matchAll(GENERIC_KINDS)) kinds.add(m[0].toLowerCase().replace(/s$/, ""));
  return kinds.size;
}

/**
 * True when the dependence words in `sentence` are followed, closely, by a
 * word of category `key`, and not inside a list of many kinds of third party.
 */
export function statesDependenceOn(sentence: string, key: string): boolean {
  const term = DEPENDENCE_CATEGORY_TERMS.find((t) => t.key === key);
  if (!term) return false;
  for (const m of sentence.matchAll(DEPENDENCE)) {
    const after = sentence.slice(m.index!, m.index! + m[0].length + TERM_AFTER_DEPENDENCE_CHARS);
    if (term.re.test(after) && kindsNamed(after) <= MAX_KINDS_IN_DEPENDENCE) return true;
  }
  return false;
}

export type DependenceContextInput = {
  counterparty_name: string;
  category: string;
  /** The edge's evidence quotes (already found in the filing text). */
  quotes: readonly string[];
  /** The filer's other counterparties: a sentence naming one is not about this edge. */
  otherNames: readonly string[];
};

/**
 * Up to MAX_DEPENDENCE_SENTENCES sentences of `filingText` that state the
 * filer depends on the category the edge's quotes put the counterparty in.
 * First-person statements ("We depend on foundries") first, then the nearest
 * to the edge's quotes. Each is a verbatim (whitespace-normalized) span of the
 * filing text. Empty for a competitor, for quotes in no known category, or
 * with no filing text.
 */
export function dependenceSentences(filingText: string, input: DependenceContextInput): string[] {
  if (!filingText || !DEPENDENCE_CATEGORIES.has(input.category)) return [];
  const keys = categoryTermsInQuotes(input.quotes);
  if (keys.length === 0) return [];
  const filing = prepareFiling(filingText);
  const quotes = input.quotes.map((q) => normalizeWhitespace(q)).filter(Boolean);
  const anchors = quotes.map((q) => filing.lower.indexOf(q.toLowerCase())).filter((i) => i >= 0);
  const self = normalizeCompanyName(input.counterparty_name);
  const others = input.otherNames.filter((n) => normalizeCompanyName(n) !== self);

  const found: Array<{ text: string; firstPerson: boolean; distance: number }> = [];
  const seen = new Set<string>();
  for (const s of filing.candidates) {
    if (seen.has(s.text)) continue;
    if (!keys.some((k) => statesDependenceOn(s.text, k))) continue;
    // Already among the quotes, or a part of one.
    if (quotes.some((q) => q.includes(s.text) || s.text.includes(q))) continue;
    if (others.some((n) => sentenceNames(n, s.text))) continue;
    seen.add(s.text);
    const dep = s.text.search(DEPENDENCE);
    found.push({
      text: s.text,
      firstPerson: dep > 0 && FIRST_PERSON.test(s.text.slice(0, dep)),
      distance: anchors.length ? Math.min(...anchors.map((a) => Math.abs(a - s.start))) : Number.MAX_SAFE_INTEGER,
    });
  }
  found.sort((a, b) => Number(b.firstPerson) - Number(a.firstPerson) || a.distance - b.distance);
  return found.slice(0, MAX_DEPENDENCE_SENTENCES).map((f) => f.text);
}

type PreparedFiling = {
  raw: string;
  /** Whitespace-normalized, lowercased: what quotes are found in. */
  lower: string;
  /** Sentences short enough to send that carry dependence words at all. */
  candidates: Array<{ text: string; start: number }>;
};

let lastFiling: PreparedFiling | null = null;

/** Normalize and split a filing once: a run classifies every edge of a filer against the same text. */
function prepareFiling(raw: string): PreparedFiling {
  if (lastFiling?.raw === raw) return lastFiling;
  const text = normalizeWhitespace(raw);
  const candidates = filingSentences(text).filter(
    (s) => s.text.length <= MAX_DEPENDENCE_SENTENCE_CHARS && s.text.split(" ").length >= 5 && s.text.search(DEPENDENCE) >= 0,
  );
  lastFiling = { raw, lower: text.toLowerCase(), candidates };
  return lastFiling;
}

/**
 * The edge's quotes the classifier reads: those found in `filingText` (every
 * quote when there is no text to check against: stored quotes passed the same
 * check when the edge was extracted), duplicates dropped, in order, capped at
 * MAX_STRENGTH_QUOTE_CHARS in total. The first found quote is always kept.
 */
export function strengthQuotes(quotes: readonly string[], filingText?: string | null): string[] {
  const text = filingText ? prepareFiling(filingText).lower : null;
  const key = (q: string) => q.toLowerCase().replace(/[\s.,;:]+$/, "");
  const found: string[] = [];
  for (const raw of quotes) {
    if (typeof raw !== "string") continue;
    const q = normalizeWhitespace(raw);
    if (!q) continue;
    if (text !== null && !text.includes(q.toLowerCase())) continue;
    found.push(q);
  }
  // The same sentence quoted twice, or once in part, reads as one quote: a
  // repeat is not a second piece of evidence.
  const distinct = found.filter((q, i) => {
    const k = key(q);
    return !found.some((other, j) => {
      const ok = key(other);
      return j !== i && (ok === k ? j < i : ok.includes(k));
    });
  });
  const out: string[] = [];
  let total = 0;
  for (const q of distinct) {
    if (out.length > 0 && total + q.length > MAX_STRENGTH_QUOTE_CHARS) continue;
    out.push(q);
    total += q.length;
  }
  return out;
}

/**
 * The classifier input for a stored edge: its quotes found in `filingText`
 * (all of them when there is no text), and the category dependence sentences
 * of that text. With quotes none of which is found in the text (a filing
 * other than the one the edge came from), the edge keeps only its stored
 * quotes and gets no dependence sentences.
 */
export function strengthInputForEdge(
  edge: {
    counterparty_name: string;
    category: string;
    subtype: string;
    evidence: ReadonlyArray<{ quote: string }>;
  },
  filingText: string | null,
  otherNames: readonly string[],
  disclosedPct: number | null = null,
): StrengthClassifyInput {
  const stored = edge.evidence.map((e) => e.quote).filter((q) => typeof q === "string" && q.trim());
  const found = filingText ? strengthQuotes(stored, filingText) : [];
  const quotes = found.length ? found : strengthQuotes(stored);
  const category_dependence =
    filingText && found.length
      ? dependenceSentences(filingText, {
          counterparty_name: edge.counterparty_name,
          category: edge.category,
          quotes,
          otherNames,
        })
      : [];
  return {
    counterparty_name: edge.counterparty_name,
    category: edge.category,
    subtype: edge.subtype,
    disclosed_revenue_dependency_pct: disclosedPct,
    evidence_quote: stored[0] ?? "",
    evidence_quotes: quotes,
    ...(category_dependence.length ? { category_dependence } : {}),
  };
}
