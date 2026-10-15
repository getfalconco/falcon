/**
 * "Never invent numbers", as a check.
 *
 * Every figure in a write-up has to be traceable to the material the model
 * was given: the filing or press release, the consensus lines, the quotes, the
 * headlines. A figure that is not there is either made up or computed, and a
 * reader cannot tell which, so it does not ship.
 *
 * Matching is tolerant of how a number is written, not of what it says:
 * "$30,040 million" grounds "$30.0 billion" (same value at the shown
 * precision), "75.1%" grounds "75.1 percent". Small integers, years, quarter
 * labels and dates are not checked: "Q3", "2026" and "11/19" are labels.
 */

export type FoundNumber = { value: number; decimals: number; raw: string };

/** Dates, quarter and fiscal-year labels: never figures. */
const LABELS = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b[QH][1-4]\b|\bFY\s?\d{2,4}\b|\b\d{1,2}:\d{2}\b/gi;

export function numbersIn(text: string): FoundNumber[] {
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

/** Figures that need a source. Small whole numbers and years are labels or counts. */
export function isCheckable(n: FoundNumber): boolean {
  if (n.decimals === 0 && n.value < 10) return false;
  if (n.decimals === 0 && n.value >= 1900 && n.value <= 2100) return false;
  return true;
}

const SCALES = [1, 1e3, 1e-3, 1e6, 1e-6, 1e9, 1e-9];

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** The corpus figures, deduplicated, ready to be matched against. */
export function corpusNumbers(corpus: string): number[] {
  return [...new Set(numbersIn(corpus).map((n) => n.value))];
}

/**
 * Whether `n` is one of the corpus figures, possibly in other units and
 * rounded to the precision `n` is written with.
 */
export function isGrounded(n: FoundNumber, corpus: readonly number[]): boolean {
  if (!isCheckable(n)) return true;
  for (const c of corpus) {
    for (const s of SCALES) {
      const scaled = c * s;
      if (roundTo(scaled, n.decimals) === n.value) return true;
      // "30.04" written as "30.0": the corpus is more precise than the text.
      if (n.decimals > 0 && Math.abs(scaled - n.value) <= 0.5 * 10 ** -n.decimals + 1e-9) return true;
    }
  }
  return false;
}

/** The figures in `text` that the corpus does not contain. */
export function ungroundedNumbers(text: string, corpus: readonly number[]): string[] {
  return numbersIn(text)
    .filter((n) => !isGrounded(n, corpus))
    .map((n) => n.raw);
}
