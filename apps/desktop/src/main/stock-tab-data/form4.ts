/**
 * A Form 4's open market trades, totalled.
 *
 * The agents engine's reader (agents/sources.ts `parseForm4`) keeps the first
 * transaction line only, which is what an agent alert needs. A Form 4 often
 * carries a dozen sale lines at different prices on the same day, so the
 * Stock tab totals every non-derivative line of one code instead:
 *
 *   P  open market or private purchase
 *   S  open market or private sale
 *
 * Grants (A), option exercises (M), tax withholding (F) and gifts (G) are not
 * trades the insider chose to make in the market and are not counted. When a
 * form has both P and S lines, the larger side by shares is kept.
 *
 * The Rule 10b5-1 box (`aff10b5One`, on forms since April 2023) or a plan
 * footnote on a counted line marks trades made under a plan set up in
 * advance; it is carried, not dropped, so the view can mark them.
 *
 * The XML is read by the app's one Form 4 reader (main/edgar/form4.ts).
 *
 * Pure: the caller fetches the XML.
 */

import { parseOwnershipXml, roleText, type Form4Line } from "../edgar/form4";

export type Form4Totals = {
  name: string;
  role: string;
  code: "P" | "S";
  shares: number;
  /** Shares times price over the counted lines; null when a counted line has no price. */
  value: number | null;
  /** The latest transaction date among the counted lines, YYYY-MM-DD. */
  date: string | null;
  plan: boolean;
};

export function form4Totals(xml: string): Form4Totals | null {
  if (typeof xml !== "string") return null;
  const doc = parseOwnershipXml(xml);
  if (!doc) return null;
  type Side = { shares: number; value: number | null; date: string | null; lines: Form4Line[] };
  const sides: Record<"P" | "S", Side> = {
    P: { shares: 0, value: 0, date: null, lines: [] },
    S: { shares: 0, value: 0, date: null, lines: [] },
  };
  for (const line of doc.lines) {
    if (line.derivative || (line.code !== "P" && line.code !== "S")) continue;
    if (line.shares === null || line.shares <= 0) continue;
    const side = sides[line.code];
    side.lines.push(line);
    side.shares += line.shares;
    side.value = side.value === null || line.price === null ? null : side.value + line.shares * line.price;
    if (line.date && (side.date === null || line.date > side.date)) side.date = line.date;
  }
  const pick: "P" | "S" | null =
    sides.P.lines.length > 0 && (sides.S.lines.length === 0 || sides.P.shares >= sides.S.shares) ? "P" : sides.S.lines.length > 0 ? "S" : null;
  if (!pick) return null;
  const side = sides[pick];
  const reporter = doc.reporters[0];
  return {
    name: reporter?.name ?? "unknown",
    role: roleText(reporter),
    code: pick,
    shares: Math.round(side.shares),
    value: side.value === null ? null : Math.round(side.value),
    date: side.date,
    plan: doc.aff10b5One || side.lines.some((l) => l.plan),
  };
}
