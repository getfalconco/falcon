const XBRL_QNAME = /\b[a-z][\w.-]*:[A-Z]\w+/;

/** Pre-audit guard: evidence must be natural-language narrative, not XBRL/tags/fragments. */
export function isNonNarrativeEvidence(quote: string): boolean {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (words.length < 5) return true;
  return XBRL_QNAME.test(quote);
}
