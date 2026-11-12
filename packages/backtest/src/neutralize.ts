/**
 * Information framing only (vault: Business/Legal and Compliance). Model text
 * shown to the user passes through here: sentences that read as a buy or sell
 * call, a recommendation or a promise of returns are dropped, and the UI copy
 * rules apply (no em dashes, no emoji). Pure.
 */

const ADVICE = new RegExp(
  [
    String.raw`\byou (?:should|must|ought to|need to) (?:buy|sell|hold|invest|short|consider buying|consider selling|get in|get out)`,
    String.raw`\b(?:we|i) (?:recommend|suggest|advise)`,
    String.raw`\brecommend(?:ed|s)? (?:buying|selling|holding|that you)`,
    String.raw`\b(?:strong|must) (?:buy|sell)\b`,
    String.raw`\b(?:buy|sell) (?:it |this |these )?now\b`,
    String.raw`\bguarantee(?:d|s)?\b`,
    String.raw`\brisk[- ]free\b`,
    String.raw`\bcan(?:'|no)t lose\b`,
    String.raw`\bsure (?:thing|bet|profit|win)\b`,
    String.raw`\bwill (?:make|earn|outperform|beat the market|go up|rise|double|profit)\b`,
    String.raw`\bsafe (?:investment|bet)\b`,
    String.raw`\bprice target\b`,
    String.raw`\b(?:financial|investment) advice\b`,
  ].join("|"),
  "i",
);

/** True when a sentence reads as advice or a return promise. */
export function isAdviceLike(sentence: string): boolean {
  return ADVICE.test(sentence);
}

// Built from a string so the web app's type check (no ES2015 target) accepts the "u" flag.
const EMOJI = new RegExp(String.raw`\p{Extended_Pictographic}|\uFE0F|\u200D`, "gu");

/** Em dash (U+2014) and en dash (U+2013), with the spaces around them. */
const DASHES = new RegExp(String.raw`\s*[` + String.fromCharCode(0x2014, 0x2013) + String.raw`]\s*`, "g");

/** UI copy rules: no em or en dashes, no emoji, single spaces. */
export function plainStyle(text: string): string {
  return text
    .replace(DASHES, ", ")
    .replace(EMOJI, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

/** Drops advice-like sentences; returns the rest in plain style, and how many were dropped. */
export function neutralize(text: string): { text: string; removed: number } {
  const sentences = plainStyle(text).split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => s && !isAdviceLike(s));
  return { text: kept.join(" ").trim(), removed: sentences.filter(Boolean).length - kept.length };
}

export function neutralizeList(items: readonly string[], maxItems = 8, maxLen = 240): { items: string[]; removed: number } {
  let removed = 0;
  const out: string[] = [];
  for (const raw of items) {
    const n = neutralize(raw);
    removed += n.removed;
    if (n.text) out.push(n.text.length > maxLen ? `${n.text.slice(0, maxLen - 3).trimEnd()}...` : n.text);
    if (out.length >= maxItems) break;
  }
  return { items: out, removed };
}
