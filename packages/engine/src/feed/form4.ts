/**
 * Form 4 `ownershipDocument` XML: issuer, reporting owners and their
 * relationship, the 10b5-1 flag, footnotes, and non-derivative transactions.
 * A small regex reader for this one fixed schema (no XML dependency). Pure.
 */

import { decodeXml } from "./edgar.ts";

export type ReportingOwner = {
  cik: string;
  name: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  isOther: boolean;
  officerTitle: string | null;
  otherText: string | null;
};

export type NonDerivativeTransaction = {
  securityTitle: string;
  /** YYYY-MM-DD */
  date: string;
  code: string;
  shares: number | null;
  pricePerShare: number | null;
  /** "A" acquired, "D" disposed. */
  acquiredDisposed: string;
  sharesOwnedAfter: number | null;
  directOrIndirect: string;
  natureOfOwnership: string | null;
  footnoteIds: string[];
  /** The values as written in the XML (for quotes). */
  raw: { shares: string; price: string };
};

export type OwnershipDocument = {
  documentType: string;
  periodOfReport: string | null;
  issuerCik: string;
  issuerName: string;
  issuerTradingSymbol: string | null;
  owners: ReportingOwner[];
  /** true / false when the filing answers the 10b5-1 checkbox; null on older schemas. */
  aff10b5One: boolean | null;
  transactions: NonDerivativeTransaction[];
  footnotes: Record<string, string>;
  remarks: string;
};

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1]! : null;
}

function all(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]!);
}

function text(xml: string | null): string {
  return xml === null ? "" : decodeXml(xml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** `<x><value>v</value></x>` or `<x>v</x>`. */
function val(xml: string, name: string): string {
  const inner = tag(xml, name);
  if (inner === null) return "";
  const v = tag(inner, "value");
  return text(v ?? inner);
}

function bool(s: string): boolean {
  return /^(1|true)$/i.test(s.trim());
}

function num(s: string): number | null {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
}

/** The `<ownershipDocument>` inside a submission text, or the XML itself. */
export function ownershipXml(body: string): string | null {
  const m = /<ownershipDocument>[\s\S]*?<\/ownershipDocument>/.exec(body);
  return m ? m[0] : null;
}

export function parseOwnershipDocument(body: string): OwnershipDocument | null {
  const xml = ownershipXml(body);
  if (!xml) return null;
  const issuer = tag(xml, "issuer") ?? "";
  const owners: ReportingOwner[] = all(xml, "reportingOwner").map((o) => {
    const rel = tag(o, "reportingOwnerRelationship") ?? "";
    return {
      cik: (text(tag(o, "rptOwnerCik")) || "").replace(/^0+/, "").padStart(10, "0"),
      name: text(tag(o, "rptOwnerName")),
      isDirector: bool(text(tag(rel, "isDirector"))),
      isOfficer: bool(text(tag(rel, "isOfficer"))),
      isTenPercentOwner: bool(text(tag(rel, "isTenPercentOwner"))),
      isOther: bool(text(tag(rel, "isOther"))),
      officerTitle: text(tag(rel, "officerTitle")) || null,
      otherText: text(tag(rel, "otherText")) || null,
    };
  });
  const flag = tag(xml, "aff10b5One");
  const footnotes: Record<string, string> = {};
  for (const m of xml.matchAll(/<footnote\s+id="([^"]+)"\s*>([\s\S]*?)<\/footnote>/g)) footnotes[m[1]!] = text(m[2]!);
  const table = tag(xml, "nonDerivativeTable") ?? "";
  const transactions: NonDerivativeTransaction[] = all(table, "nonDerivativeTransaction").map((t) => {
    const amounts = tag(t, "transactionAmounts") ?? "";
    const shares = val(amounts, "transactionShares");
    const price = val(amounts, "transactionPricePerShare");
    return {
      securityTitle: val(t, "securityTitle"),
      date: val(t, "transactionDate").slice(0, 10),
      code: text(tag(tag(t, "transactionCoding") ?? "", "transactionCode")),
      shares: num(shares),
      pricePerShare: num(price),
      acquiredDisposed: val(amounts, "transactionAcquiredDisposedCode"),
      sharesOwnedAfter: num(val(tag(t, "postTransactionAmounts") ?? "", "sharesOwnedFollowingTransaction")),
      directOrIndirect: val(tag(t, "ownershipNature") ?? "", "directOrIndirectOwnership"),
      natureOfOwnership: val(tag(t, "ownershipNature") ?? "", "natureOfOwnership") || null,
      footnoteIds: [...t.matchAll(/<footnoteId\s+id="([^"]+)"/g)].map((m) => m[1]!),
      raw: { shares, price },
    };
  });
  return {
    documentType: text(tag(xml, "documentType")),
    periodOfReport: text(tag(xml, "periodOfReport")) || null,
    issuerCik: text(tag(issuer, "issuerCik")).replace(/^0+/, "").padStart(10, "0"),
    issuerName: text(tag(issuer, "issuerName")),
    issuerTradingSymbol: (() => {
      const s = text(tag(issuer, "issuerTradingSymbol")).toUpperCase();
      return s && s !== "NONE" && s !== "N/A" ? s : null;
    })(),
    owners,
    aff10b5One: flag === null || text(flag) === "" ? null : bool(text(flag)),
    transactions,
    footnotes,
    remarks: text(tag(xml, "remarks")),
  };
}

/** A plain role for an owner: "Director", "CEO", "10% owner". */
export function ownerRole(o: ReportingOwner): string {
  const parts: string[] = [];
  if (o.isOfficer) parts.push(o.officerTitle ? o.officerTitle : "Officer");
  if (o.isDirector) parts.push("Director");
  if (o.isTenPercentOwner) parts.push("10% owner");
  if (o.isOther && o.otherText) parts.push(o.otherText);
  return parts.length ? parts.join(", ") : "Insider";
}
