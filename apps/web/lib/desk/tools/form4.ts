/**
 * Form 4 `ownershipDocument` XML reader and the open-market trade rules the
 * engine's F7 insider detector uses (packages/engine/src/feed/form4.ts and
 * src/detectors/insider.ts, Cohen, Malloy and Pomorski 2012). Ported, not
 * imported: the engine is not a dependency of apps/web and its files use
 * `.ts` import paths this app's compiler settings do not accept. Keep the
 * rules in step with the engine when they change. Pure.
 */

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
  date: string;
  code: string;
  shares: number | null;
  pricePerShare: number | null;
  acquiredDisposed: string;
  sharesOwnedAfter: number | null;
  directOrIndirect: string;
  footnoteIds: string[];
};

export type OwnershipDocument = {
  documentType: string;
  issuerCik: string;
  issuerName: string;
  issuerTradingSymbol: string | null;
  owners: ReportingOwner[];
  aff10b5One: boolean | null;
  transactions: NonDerivativeTransaction[];
  footnotes: Record<string, string>;
  remarks: string;
};

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1]! : null;
}

function all(xml: string, name: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))).map((m) => m[1]!);
}

function text(xml: string | null): string {
  return xml === null ? "" : decodeXml(xml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function val(xml: string, name: string): string {
  const inner = tag(xml, name);
  if (inner === null) return "";
  const v = tag(inner, "value");
  return text(v ?? inner);
}

const bool = (s: string) => /^(1|true)$/i.test(s.trim());

function numeric(s: string): number | null {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
}

export function parseOwnershipDocument(body: string): OwnershipDocument | null {
  const xml = /<ownershipDocument>[\s\S]*?<\/ownershipDocument>/.exec(body)?.[0];
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
  for (const m of Array.from(xml.matchAll(/<footnote\s+id="([^"]+)"\s*>([\s\S]*?)<\/footnote>/g))) footnotes[m[1]!] = text(m[2]!);
  const table = tag(xml, "nonDerivativeTable") ?? "";
  const transactions: NonDerivativeTransaction[] = all(table, "nonDerivativeTransaction").map((t) => {
    const amounts = tag(t, "transactionAmounts") ?? "";
    return {
      securityTitle: val(t, "securityTitle"),
      date: val(t, "transactionDate").slice(0, 10),
      code: text(tag(tag(t, "transactionCoding") ?? "", "transactionCode")),
      shares: numeric(val(amounts, "transactionShares")),
      pricePerShare: numeric(val(amounts, "transactionPricePerShare")),
      acquiredDisposed: val(amounts, "transactionAcquiredDisposedCode"),
      sharesOwnedAfter: numeric(val(tag(t, "postTransactionAmounts") ?? "", "sharesOwnedFollowingTransaction")),
      directOrIndirect: val(tag(t, "ownershipNature") ?? "", "directOrIndirectOwnership"),
      footnoteIds: Array.from(t.matchAll(/<footnoteId\s+id="([^"]+)"/g)).map((m) => m[1]!),
    };
  });
  const symbol = text(tag(issuer, "issuerTradingSymbol")).toUpperCase();
  return {
    documentType: text(tag(xml, "documentType")),
    issuerCik: text(tag(issuer, "issuerCik")).replace(/^0+/, "").padStart(10, "0"),
    issuerName: text(tag(issuer, "issuerName")),
    issuerTradingSymbol: symbol && symbol !== "NONE" && symbol !== "N/A" ? symbol : null,
    owners,
    aff10b5One: flag === null || text(flag) === "" ? null : bool(text(flag)),
    transactions,
    footnotes,
    remarks: text(tag(xml, "remarks")),
  };
}

/** "CEO, Director", "10% owner", "Insider". */
export function ownerRole(o: ReportingOwner): string {
  const parts: string[] = [];
  if (o.isOfficer) parts.push(o.officerTitle ? o.officerTitle : "Officer");
  if (o.isDirector) parts.push("Director");
  if (o.isTenPercentOwner) parts.push("10% owner");
  if (o.isOther && o.otherText) parts.push(o.otherText);
  return parts.length ? parts.join(", ") : "Insider";
}

/* ------------------------------------------------------------------ trade rules (engine detectors/insider.ts) */

export const MIN_PRICE_USD = 5;
export const CLUSTER_MIN_INSIDERS = 3;
export const CLUSTER_MAX_BUSINESS_DAYS = 5;
export const SINGLE_MIN_USD = 100_000;

const NOT_COMMON = /\b(preferred|pref\.?|notes?|debentures?|bonds?|warrants?|rights?|units?|options?)\b/i;
const NOT_OPEN_MARKET =
  /\b(underwritten|public offering|registered direct|private placement|securities purchase agreement|subscription agreement|dividend reinvestment|reinvestment of dividends|employee stock purchase plan|ESPP|DRIP|rights offering|initial public offering|IPO|directed share program|concurrent private)\b/i;
const PLAN_10B51 = /10b5-?1/i;

export type Trade = {
  kind: "buy" | "sell";
  date: string;
  shares: number;
  price: number;
  value: number;
  sharesOwnedAfter: number | null;
  securityTitle: string;
};

/** Why a P or S row is not an opportunistic open-market trade, or null when it is. */
export type SetAside = "10b5-1 plan" | "not common stock" | "offering or plan purchase" | "no shares or price" | "price at or below $5";

/**
 * The open-market rows (codes P and S) of one Form 4: the trades that pass
 * the engine's F7 filters, and the ones set aside with the reason. Purchases
 * follow the detector's rules exactly; sales drop the 10b5-1 ones (box ticked
 * or a footnote naming a plan) and non-common securities. Pure.
 */
export function openMarketTrades(doc: OwnershipDocument): { trades: Trade[]; setAside: { reason: SetAside; trade: Trade }[]; otherCodes: Record<string, number> } {
  const trades: Trade[] = [];
  const setAside: { reason: SetAside; trade: Trade }[] = [];
  const otherCodes: Record<string, number> = {};
  for (const t of doc.transactions) {
    if (t.code !== "P" && t.code !== "S") {
      if (t.code) otherCodes[t.code] = (otherCodes[t.code] ?? 0) + 1;
      continue;
    }
    const kind = t.code === "P" ? "buy" : "sell";
    const shares = t.shares ?? 0;
    const price = t.pricePerShare ?? 0;
    const trade: Trade = { kind, date: t.date, shares, price, value: shares * price, sharesOwnedAfter: t.sharesOwnedAfter, securityTitle: t.securityTitle };
    const notes = t.footnoteIds.map((id) => doc.footnotes[id] ?? "").join(" ");
    let reason: SetAside | null = null;
    if (doc.aff10b5One === true || PLAN_10B51.test(notes)) reason = "10b5-1 plan";
    else if (shares <= 0 || price <= 0) reason = "no shares or price";
    else if (NOT_COMMON.test(t.securityTitle)) reason = "not common stock";
    else if (kind === "buy" && t.acquiredDisposed && t.acquiredDisposed !== "A") reason = "no shares or price";
    else if (kind === "buy" && NOT_OPEN_MARKET.test(`${notes} ${doc.remarks}`)) reason = "offering or plan purchase";
    else if (kind === "buy" && price <= MIN_PRICE_USD) reason = "price at or below $5";
    if (reason) setAside.push({ reason, trade });
    else trades.push(trade);
  }
  return { trades, setAside, otherCodes };
}

/**
 * Routine by CMP 2012: the insider filed a Form 4 in the same calendar month
 * in each of the 3 prior years (any issuer, from their EDGAR filing list).
 * Null when the list is cut short and cannot tell (EDGAR's recent list holds
 * the last 1,000 filings). Pure (engine detectors/insider.ts isRoutine).
 */
export function isRoutine(form4Dates: string[], ym: string, oldestCovered: string | null): boolean | null {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const months = new Set(form4Dates.map((d) => d.slice(0, 7)));
  const priorYears = [1, 2, 3].map((k) => `${y - k}-${String(m).padStart(2, "0")}`);
  if (priorYears.every((p) => months.has(p))) return true;
  if (oldestCovered && oldestCovered > `${priorYears[2]}-01`) {
    const missing = priorYears.filter((p) => !months.has(p));
    if (missing.every((p) => p < oldestCovered.slice(0, 7))) return null;
  }
  return false;
}
