/** Trailing legal-form tokens stripped by `normalizeCompanyName` (lowercase, punctuation-free). */
export const LEGAL_SUFFIXES = [
  "inc",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "llc",
  "plc",
  "co",
  "company",
  "holdings",
  "group",
  "ag",
  "sa",
  "nv",
  "se",
  "kk",
];

/** Lowercase, strip legal suffixes / punctuation, collapse spaces. */
export function normalizeCompanyName(name: string): string {
  let s = name.toLowerCase().trim();
  s = s.replace(/[^\w\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();

  const parts = s.split(" ");
  while (parts.length > 1) {
    const last = parts[parts.length - 1]!;
    if (LEGAL_SUFFIXES.includes(last)) {
      parts.pop();
      continue;
    }
    break;
  }

  return parts.join(" ").trim();
}

/** True when normalized name matches quote (substring or first token >= 4 chars). */
export function counterpartyNameInQuote(counterpartyName: string, quote: string): boolean {
  const nameNorm = normalizeCompanyName(counterpartyName);
  if (!nameNorm) return false;
  const quoteNorm = normalizeCompanyName(quote);

  if (quoteNorm.includes(nameNorm)) return true;

  const firstToken = nameNorm.split(/\s+/)[0] ?? "";
  return firstToken.length >= 4 && quoteNorm.includes(firstToken);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripJsonFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return raw.trim();
}
