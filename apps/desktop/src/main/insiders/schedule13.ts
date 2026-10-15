/**
 * Schedule 13D and 13G, read for the few facts the Insider activity card
 * states: who filed, the percent of the class on the cover page, and, for a
 * 13D amendment, whether it restates Item 4 (the purpose of the holding).
 *
 * Two shapes reach here. Before December 2024 a schedule was an HTML or text
 * document with the cover page rows ("PERCENT OF CLASS REPRESENTED BY AMOUNT
 * IN ROW (11)") and the items as headings. Since then EDGAR takes them as XML
 * ("SCHEDULE 13D", "SCHEDULE 13G"), where the percent sits in an element
 * whose name says percent and Item 4 in its own element. Both are read.
 *
 * The filer comes from the filing's SEC header (`<accession>-index-headers.html`),
 * "FILED BY:" then "COMPANY CONFORMED NAME:", which every schedule has.
 *
 * An amendment only repeats the items it changes, so an Item 4 with text of
 * its own (not "not amended", "no change", "unchanged") is a restated purpose.
 *
 * Pure.
 */

import { htmlToText } from "../agents/sources";

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The "FILED BY" company's name in an SEC header; null when there is none. */
export function filerFromHeader(header: string): string | null {
  const text = htmlToText(header);
  const filedBy = text.search(/FILED BY:/i);
  if (filedBy < 0) return null;
  const m = text.slice(filedBy).match(/COMPANY CONFORMED NAME:\s*([^\n]+)/i);
  const name = m ? clean(m[1]!) : "";
  return name || null;
}

/** The subject company's CIK in an SEC header; null when the header names none. */
export function subjectCikFromHeader(header: string): string | null {
  const text = htmlToText(header);
  const at = text.search(/SUBJECT COMPANY:/i);
  if (at < 0) return null;
  const rest = text.slice(at);
  const end = rest.search(/FILED BY:/i);
  const m = (end > 0 ? rest.slice(0, end) : rest).match(/CENTRAL INDEX KEY:\s*(\d+)/i);
  return m ? m[1]! : null;
}

function percentNumber(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/** The percent of the class on the cover page (the first reporting person's); null when it cannot be read. */
export function percentOfClass(doc: string): number | null {
  // XML: <percentOfClass>7.2</percentOfClass>, <classPercent>, <aggregatePercent> ...
  const xml = doc.match(/<((?:\w+:)?\w*[Pp]ercent\w*)>\s*([\d.,]+)\s*%?\s*<\/\1>/);
  if (xml) {
    const n = percentNumber(xml[2]!);
    if (n !== null) return n;
  }
  const text = htmlToText(doc);
  const m = text.match(/percent of (?:the )?class represented by amount in row\s*\(?\s*(?:9|11)\s*\)?[^%\d]{0,80}?(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (m) return percentNumber(m[1]!);
  return null;
}

/** "Item 4 ... is not being amended by this Amendment No. 6", "No change", "Not applicable". */
const NO_CHANGE = /\b(?:not (?:being |hereby )?(?:amended|supplemented|modified|changed)|no (?:material )?changes?|unchanged|not applicable)\b|^\W*none\b/i;
/** "Item 4 is hereby amended and supplemented by adding the following", "... amended and restated in its entirety". */
const CHANGED = /\b(?:amended|supplemented)\b[^.]{0,60}?\b(?:to add|by adding|as follows|in (?:its|their) entirety|following)\b/i;

function restates(body: string): boolean {
  if (body.length < 40) return false;
  if (CHANGED.test(body)) return true;
  return !NO_CHANGE.test(body);
}

/**
 * Does this 13D amendment restate Item 4, the purpose of the holding? The
 * XML schedules always carry an Item 4 element, often only to say it "is not
 * being amended"; the older documents leave unchanged items out.
 */
export function purposeAmended(doc: string): boolean {
  const xml = doc.match(/<((?:\w+:)?(?:transactionPurpose|purposeOfTransaction|item4))\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (xml) return restates(clean(htmlToText(xml[2]!)));
  const text = htmlToText(doc);
  const start = text.search(/item\s*4\s*[.:)]?\s*(?:[-,]\s*)?purpose of (?:the )?transaction/i);
  if (start < 0) return false;
  const rest = text.slice(start).replace(/^item\s*4\s*[.:)]?\s*(?:[-,]\s*)?purpose of (?:the )?transaction\.?/i, "");
  const end = rest.search(/item\s*5\s*[.:)]?\s*(?:[-,]\s*)?interest in securities/i);
  return restates(clean(end >= 0 ? rest.slice(0, end) : rest.slice(0, 4000)));
}
