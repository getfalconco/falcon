/**
 * SEC Form 4 (statement of changes in beneficial ownership), read from its
 * ownership XML: one reader for every part of the app that looks at insider
 * trades. The agents engine's first-transaction view (agents/sources.ts
 * `parseForm4`) and the Insider activity card (main/insiders) both read
 * through `parseOwnershipXml`.
 *
 * What a form carries and how it is read:
 *
 *   reporters     every <reportingOwner>: CIK, name, the director / officer /
 *                 10% owner boxes and the officer title as typed.
 *   lines         every <nonDerivativeTransaction> and <derivativeTransaction>,
 *                 in document order, marked `derivative`. Holdings rows
 *                 (<nonDerivativeHolding>) are kept apart: they move no
 *                 shares but say what else the insider owns.
 *   plan          a line counts as made under a Rule 10b5-1 plan when the
 *                 form's own box is ticked (`aff10b5One`, on forms since
 *                 April 2023) or a footnote the line points to says the trade
 *                 was made under such a plan. A footnote that says "not
 *                 pursuant to" a plan does not count.
 *   holdings      `sharesOwnedFollowingTransaction` per line, so a caller can
 *                 work out what the insider held before a purchase.
 *
 * Pure: the caller fetches the XML.
 */

import type { InsiderRole } from "../../shared/insider-types";

export type Form4Reporter = {
  cik: string | null;
  name: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  officerTitle: string | null;
  /** "Other" box text ("President, Latin America OU"): some officers file under it instead of the officer box. */
  otherText: string | null;
};

export type Form4Line = {
  derivative: boolean;
  securityTitle: string | null;
  /** P purchase, S sale, A award, M exercise, F tax, G gift, ... (upper case; "" when missing). */
  code: string;
  /** YYYY-MM-DD, or null when the form leaves it out. */
  date: string | null;
  shares: number | null;
  price: number | null;
  /** "A" acquired, "D" disposed. */
  acquiredDisposed: "A" | "D" | null;
  sharesAfter: number | null;
  /** "D" direct, "I" indirect. */
  ownership: "D" | "I" | null;
  /** The indirect owner as the form names it ("By Trust"); null for direct holdings. */
  nature: string | null;
  footnoteIds: string[];
  /** Under a Rule 10b5-1 plan: the form's box, or a footnote this line points to. */
  plan: boolean;
};

export type Form4Holding = {
  derivative: boolean;
  securityTitle: string | null;
  shares: number | null;
  ownership: "D" | "I" | null;
  nature: string | null;
};

export type Form4Document = {
  documentType: string | null;
  periodOfReport: string | null;
  issuerCik: string | null;
  issuerName: string | null;
  issuerSymbol: string | null;
  reporters: Form4Reporter[];
  /** The form-level Rule 10b5-1 box. */
  aff10b5One: boolean;
  lines: Form4Line[];
  holdings: Form4Holding[];
  footnotes: Record<string, string>;
};

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text of the first `<name>` in `scope` that holds text directly. */
function tag(name: string, scope: string): string | null {
  const m = scope.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"));
  return m ? decode(m[1]!) : null;
}

/** The `<value>` inside the first `<name>` in `scope`. */
function valueOf(name: string, scope: string): string | null {
  const block = scope.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))?.[1];
  if (!block) return null;
  const m = block.match(/<value>\s*([^<]*?)\s*<\/value>/i);
  return m ? decode(m[1]!) : null;
}

function blocks(name: string, scope: string): string[] {
  return scope.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "gi")) ?? [];
}

function num(v: string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const yes = (v: string | null) => v === "1" || v?.toLowerCase() === "true";

function ymd(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

/**
 * Does a footnote say the trade was made under a Rule 10b5-1 plan? "Effected
 * pursuant to a Rule 10b5-1 trading plan adopted on ..." and "intended to
 * satisfy the affirmative defense of Rule 10b5-1(c)" do; "not made pursuant
 * to a Rule 10b5-1 plan" does not.
 */
export function footnoteSaysPlan(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (!/10b5-1|10b5 - 1|10b-5-1/i.test(t)) return false;
  if (/\bnot\b[^.;]{0,60}(?:10b5-1|10b-5-1)/i.test(t)) return false;
  return /plan|pursuant|affirmative defense/i.test(t);
}

/** Every reporting owner, transaction line and holding of an ownership document; null for anything else. */
export function parseOwnershipXml(xml: string): Form4Document | null {
  if (typeof xml !== "string" || !/<ownershipDocument/i.test(xml)) return null;

  const footnotes: Record<string, string> = {};
  const notes = xml.match(/<footnotes>([\s\S]*?)<\/footnotes>/i)?.[1] ?? "";
  for (const m of notes.matchAll(/<footnote\s+id="([^"]+)"\s*>([\s\S]*?)<\/footnote>/gi)) {
    footnotes[m[1]!] = decode(m[2]!.replace(/<[^>]+>/g, " "));
  }
  const aff10b5One = yes(tag("aff10b5One", xml));

  // A copy without the <reportingOwner> wrapper (trimmed by hand) is read as one reporter.
  const owners = blocks("reportingOwner", xml);
  const reporters: Form4Reporter[] = (owners.length > 0 ? owners : /<rptOwnerName>/i.test(xml) ? [xml] : []).map((r) => ({
    cik: tag("rptOwnerCik", r),
    name: tag("rptOwnerName", r) ?? "unknown",
    isDirector: yes(tag("isDirector", r)),
    isOfficer: yes(tag("isOfficer", r)),
    isTenPercentOwner: yes(tag("isTenPercentOwner", r)),
    officerTitle: tag("officerTitle", r) || null,
    otherText: tag("otherText", r) || null,
  }));

  const lines: Form4Line[] = [];
  const holdings: Form4Holding[] = [];
  // Document order, the two tables one after the other: the order a reader of the form sees.
  // Without the table wrapper, the whole document: the line tag names alone tell the tables apart.
  const table = (name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? xml;
  for (const [derivative, body] of [
    [false, table("nonDerivativeTable")],
    [true, table("derivativeTable")],
  ] as const) {
    const txnTag = derivative ? "derivativeTransaction" : "nonDerivativeTransaction";
    for (const line of blocks(txnTag, body)) {
      const footnoteIds = [...line.matchAll(/<footnoteId\s+id="([^"]+)"\s*\/?>/gi)].map((m) => m[1]!);
      const ad = valueOf("transactionAcquiredDisposedCode", line);
      const own = valueOf("directOrIndirectOwnership", line);
      lines.push({
        derivative,
        securityTitle: valueOf("securityTitle", line),
        code: (tag("transactionCode", line) ?? "").toUpperCase(),
        date: ymd(valueOf("transactionDate", line)),
        shares: num(valueOf("transactionShares", line)),
        price: num(valueOf("transactionPricePerShare", line)),
        acquiredDisposed: ad === "A" || ad === "D" ? ad : null,
        sharesAfter: num(valueOf("sharesOwnedFollowingTransaction", line)),
        ownership: own === "D" || own === "I" ? own : null,
        nature: valueOf("natureOfOwnership", line),
        footnoteIds,
        plan: aff10b5One || footnoteIds.some((id) => footnoteSaysPlan(footnotes[id] ?? "")),
      });
    }
    const holdTag = derivative ? "derivativeHolding" : "nonDerivativeHolding";
    for (const h of blocks(holdTag, body)) {
      const own = valueOf("directOrIndirectOwnership", h);
      holdings.push({
        derivative,
        securityTitle: valueOf("securityTitle", h),
        shares: num(valueOf("sharesOwnedFollowingTransaction", h)),
        ownership: own === "D" || own === "I" ? own : null,
        nature: valueOf("natureOfOwnership", h),
      });
    }
  }

  return {
    documentType: tag("documentType", xml),
    periodOfReport: ymd(tag("periodOfReport", xml)),
    issuerCik: tag("issuerCik", xml),
    issuerName: tag("issuerName", xml),
    issuerSymbol: tag("issuerTradingSymbol", xml),
    reporters,
    aff10b5One,
    lines,
    holdings,
    footnotes,
  };
}

/** The reporter's role as the form gives it: the officer title as typed, else the box ticked. */
export function roleText(r: Form4Reporter | undefined): string {
  if (!r) return "insider";
  return r.officerTitle || (r.isOfficer ? "officer" : r.isDirector ? "director" : r.isTenPercentOwner ? "10% owner" : officerLike(r.otherText) ? r.otherText! : "insider");
}

const OFFICER_WORDS = /\b(?:chief|president|officer|vice president|EVP|SVP|VP|treasurer|controller|secretary|general counsel|C[EFO]O)\b/i;

function officerLike(text: string | null): boolean {
  return text !== null && OFFICER_WORDS.test(text);
}

/** The title to show: the officer title, or an officer's title typed in the "other" box. */
export function titleOf(r: Form4Reporter | undefined): string | null {
  if (!r) return null;
  return r.officerTitle ?? (officerLike(r.otherText) ? r.otherText : null);
}

/**
 * The reporter's role in one word. Officer titles are free text ("President
 * and CEO", "EVP, Chief Financial Officer", "Principal Financial Officer"),
 * read by pattern; CEO wins over CFO when a title names both.
 */
export function roleOf(r: Form4Reporter | undefined): InsiderRole {
  if (!r) return "other";
  const title = titleOf(r) ?? "";
  if (/chief executive|\bC\.?E\.?O\b|principal executive/i.test(title)) return "ceo";
  if (/chief financial|\bC\.?F\.?O\b|principal financial/i.test(title)) return "cfo";
  if (r.isOfficer || title) return "officer";
  if (r.isDirector) return "director";
  if (r.isTenPercentOwner) return "owner10";
  return "other";
}
