/**
 * The excerpt the auditor actually needs.
 *
 * Audit's job is "does this quote, in context, support this relationship?" —
 * so it needs the quote and the prose around it, not the whole 24,000-character
 * chunk the extractor happened to be reading. Sending the chunk was never a
 * requirement, it was the shape the first version took.
 *
 * Quotes are verbatim by contract (`evidence_quote must be VERBATIM from the
 * text`), so they can be located exactly and a window taken around each one.
 * Overlapping windows merge, which matters more than it sounds: candidates
 * usually arrive in clusters from one competitor list or one supplier
 * paragraph, so their windows collapse into a single span.
 *
 * The safety rule is that a quote which cannot be located falls the whole batch
 * back to the full chunk. Trimming context on a candidate whose evidence we
 * could not find is exactly the case where the auditor most needs to see
 * everything — a cheaper prompt is not worth a wrong verdict.
 */

/** Characters of prose kept either side of a quote. */
export const WINDOW_RADIUS = 1_200;

/** Marks removed text so the model never reads two spans as contiguous prose. */
export const ELISION = "\n\n[…]\n\n";

type Span = { start: number; end: number };

/** Merge overlapping or near-touching spans, left to right. */
export function mergeSpans(spans: Span[], joinWithin = 200): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [{ ...sorted[0]! }];
  for (const span of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    // Joining near-touching spans beats emitting an elision marker shorter
    // than the text it replaces.
    if (span.start <= last.end + joinWithin) {
      last.end = Math.max(last.end, span.end);
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/** Widen to whitespace so a window never starts or ends mid-word. */
function snapToWord(text: string, index: number, direction: -1 | 1): number {
  let i = Math.max(0, Math.min(text.length, index));
  while (i > 0 && i < text.length && !/\s/.test(text[i]!)) i += direction;
  return Math.max(0, Math.min(text.length, i));
}

export type EvidenceExcerptResult = {
  excerpt: string;
  /** False when a quote could not be located and the full chunk was kept. */
  trimmed: boolean;
  /** Quotes that could not be found verbatim — worth logging, not throwing. */
  missing: string[];
  originalChars: number;
  excerptChars: number;
};

/**
 * Build the smallest excerpt of `chunk` that still shows every quote in context.
 *
 * Returns the full chunk unchanged when any quote is missing, when trimming
 * would not actually save anything, or when there are no quotes to anchor on.
 */
export function buildEvidenceExcerpt(
  chunk: string,
  quotes: string[],
  radius = WINDOW_RADIUS,
): EvidenceExcerptResult {
  const base: EvidenceExcerptResult = {
    excerpt: chunk,
    trimmed: false,
    missing: [],
    originalChars: chunk.length,
    excerptChars: chunk.length,
  };
  if (!chunk || quotes.length === 0) return base;

  const spans: Span[] = [];
  const missing: string[] = [];
  for (const quote of quotes) {
    const needle = quote.trim();
    if (!needle) continue;
    const at = chunk.indexOf(needle);
    if (at === -1) {
      missing.push(needle);
      continue;
    }
    spans.push({
      start: snapToWord(chunk, at - radius, -1),
      end: snapToWord(chunk, at + needle.length + radius, 1),
    });
  }

  // A quote we could not place is the case for showing everything.
  if (missing.length > 0) return { ...base, missing };
  if (spans.length === 0) return base;

  const merged = mergeSpans(spans);
  const excerpt = merged.map((s) => chunk.slice(s.start, s.end).trim()).join(ELISION);

  // Only trim when it is worth the elision markers.
  if (excerpt.length >= chunk.length * 0.9) return base;

  return {
    excerpt,
    trimmed: true,
    missing: [],
    originalChars: chunk.length,
    excerptChars: excerpt.length,
  };
}
