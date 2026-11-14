/**
 * Counterparty name -> US-listed ticker (design 4.2, step 5, layers a, e and
 * a checked model guess). In order:
 *
 *   alias    curated names a filing uses for a listed parent (brands,
 *            subsidiaries, short forms): `ALIASES` below;
 *   name     the SEC title of a Nasdaq / NYSE / Cboe listing, legal suffixes
 *            folded (`matchListed`, src/feed/companies.ts);
 *   model    the extraction model's `us_ticker`, kept only when that ticker
 *            is listed and its SEC title and the filing's name agree word
 *            for word on the shorter of the two (so "Ford" -> F is kept,
 *            "American Express" -> AAL is not).
 *
 * Anything else stays a named node without a ticker (`to: null`): private
 * companies, foreign companies without a US listing, OTC-only ADRs. Those
 * edges cost nothing in `walk()` (it skips them) and keep the name for the
 * next resolver layers (EX-21, GLEIF, OpenFIGI). Pure given the listings.
 */

import { isListed, matchListed, normalizeCompanyName, type Listing, type Listings } from "../feed/companies.ts";

/**
 * The seed graph's aliases (scripts/build-graph.ts): names the old step1
 * extraction left without a ticker that do have one we use; subsidiaries
 * read as their listed parent (SPIL and ASE are ASE Technology Holding;
 * Microsemi is Microchip; Ansys is Synopsys).
 */
export const SEED_ALIASES: Array<[RegExp, string]> = [
  [/^Advanced Semiconductor Engineering/i, "ASX"],
  [/^Siliconware Precision Industries/i, "ASX"],
  [/^ASE Technology/i, "ASX"],
  [/^Arrow( Electronics)?$/i, "ARW"],
  [/^Avnet/i, "AVT"],
  [/^Microsemi/i, "MCHP"],
  [/^Ansys$/i, "SNPS"],
];

/**
 * Names filings use for a listed company that its SEC title does not match:
 * subsidiaries, brands and short forms read as their listed parent. "-" marks
 * a name that must stay unresolved (no US listing; a loose match would be
 * wrong). The seed aliases first.
 */
export const ALIASES: Array<[RegExp, string]> = [
  ...SEED_ALIASES,
  [/^(TSMC|Taiwan Semiconductor Manufacturing)/i, "TSM"],
  [/^(Google|Google Cloud|Google LLC|YouTube)\b/i, "GOOGL"],
  [/^(Alphabet)\b/i, "GOOGL"],
  [/^(Amazon|AWS|Amazon Web Services|Amazon\.com)\b/i, "AMZN"],
  [/^(Microsoft|Microsoft Azure|Azure)\b/i, "MSFT"],
  [/^(Meta Platforms|Facebook|Instagram|WhatsApp)\b/i, "META"],
  [/^(Walmart|Wal-Mart|Sam's Club)\b/i, "WMT"],
  [/^(McKesson)\b/i, "MCK"],
  [/^(Cardinal Health)\b/i, "CAH"],
  [/^(AmerisourceBergen|Cencora)\b/i, "COR"],
  [/^(CVS|CVS Health|CVS Caremark|Aetna)\b/i, "CVS"],
  [/^(Express Scripts|Cigna|Evernorth)\b/i, "CI"],
  [/^(OptumRx|Optum|UnitedHealth)\b/i, "UNH"],
  [/^(The Home Depot|Home Depot)\b/i, "HD"],
  [/^(Lowe's)\b/i, "LOW"],
  [/^(Costco)\b/i, "COST"],
  [/^(Target)( Corporation)?$/i, "TGT"],
  [/^(Kroger)\b/i, "KR"],
  [/^(Dollar General)\b/i, "DG"],
  [/^(General Motors|GM)$/i, "GM"],
  [/^(Ford|Ford Motor)( Company)?$/i, "F"],
  [/^(Stellantis|FCA US)\b/i, "STLA"],
  [/^(Toyota)\b/i, "TM"],
  [/^(Honda)\b/i, "HMC"],
  [/^(Tesla)\b/i, "TSLA"],
  [/^(Boeing|The Boeing Company)\b/i, "BA"],
  [/^(Airbus)\b/i, "-"], // OTC ADR only
  [/^(GE Aerospace|General Electric)\b/i, "GE"],
  [/^(GE Vernova)\b/i, "GEV"],
  [/^(RTX|Raytheon|Pratt & Whitney|Collins Aerospace)\b/i, "RTX"],
  [/^(Lockheed Martin)\b/i, "LMT"],
  [/^(Northrop Grumman)\b/i, "NOC"],
  [/^(General Dynamics|Gulfstream)\b/i, "GD"],
  [/^(Apple)( Inc\.?)?$/i, "AAPL"],
  [/^(Intel)( Corporation)?$/i, "INTC"],
  [/^(NVIDIA)\b/i, "NVDA"],
  [/^(AMD|Advanced Micro Devices)\b/i, "AMD"],
  [/^(Broadcom)\b/i, "AVGO"],
  [/^(Qualcomm)\b/i, "QCOM"],
  [/^(Samsung)\b/i, "-"],
  [/^(Oracle)\b/i, "ORCL"],
  [/^(ADP|Automatic Data Processing)\b/i, "ADP"],
  [/^(Salesforce)\b/i, "CRM"],
  [/^(IBM|International Business Machines)\b/i, "IBM"],
  [/^(Cisco)\b/i, "CSCO"],
  [/^(Dell)\b/i, "DELL"],
  [/^(HP Inc\.?|HP)$/i, "HPQ"],
  [/^(Hewlett Packard Enterprise|HPE)\b/i, "HPE"],
  [/^(Exxon|ExxonMobil|Exxon Mobil)\b/i, "XOM"],
  [/^(Chevron)\b/i, "CVX"],
  [/^(Shell)\b/i, "SHEL"],
  [/^(BP)( p\.?l\.?c\.?)?$/i, "BP"],
  [/^(UPS|United Parcel Service)\b/i, "UPS"],
  [/^(FedEx)\b/i, "FDX"],
  [/^(Pfizer)\b/i, "PFE"],
  [/^(Merck)( & Co\.?)?( Inc\.?)?$/i, "MRK"],
  [/^(Eli Lilly|Lilly)\b/i, "LLY"],
  [/^(Johnson & Johnson|Janssen)\b/i, "JNJ"],
];

/** A plain name from an SEC title ("WALMART INC." -> "Walmart"); mixed-case names keep their casing. Pure. */
export function displayName(title: string): string {
  const base = title === title.toUpperCase() ? title.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()) : title;
  return base
    .replace(/\/[A-Za-z]{2}\/?$/, "")
    .replace(/,?\s*\b(Inc|Corp|Corporation|Co|Ltd|Plc|N\.?V|S\.?A|LLC|L\.?P)\b\.?/gi, "")
    .replace(/[,\s]+$/, "")
    .trim();
}

export type Resolution ={ ticker: string | null; by: "alias" | "name" | "model" | "unresolved" };

function words(s: string): string[] {
  return normalizeCompanyName(s)
    .split(" ")
    .filter((w) => w.length > 0);
}

/** Whether every word of the shorter normalized name is a word of the longer. Pure. */
export function namesAgree(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.length === 0 || y.length === 0) return false;
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.every((w) => long.has(w));
}

/**
 * Whether a counterparty name can be the listing: the names agree, and a
 * one-word listing title must match the whole name ("Sony" is "Sony Group
 * Corp") unless the model named that same ticker ("Dynatrace Software Inc."
 * with DT is Dynatrace, Inc.; "Merlin Entertainment" without MRLN is not
 * Merlin, Inc.). Pure.
 */
export function listingAgrees(name: string, listing: Pick<Listing, "name" | "ticker">, modelTicker = ""): boolean {
  const t = words(listing.name);
  if (t.length === 1 && words(name).join(" ") !== t[0]) return modelTicker.trim().toUpperCase() === listing.ticker && namesAgree(name, listing.name);
  return namesAgree(name, listing.name);
}

/** The listed ticker a counterparty name refers to. Pure given `listings`. */
export function resolveCounterparty(name: string, modelTicker: string, listings: Listings): Resolution {
  const n = name.trim();
  for (const [re, t] of ALIASES) {
    if (re.test(n)) return t === "-" ? { ticker: null, by: "unresolved" } : { ticker: t, by: "alias" };
  }
  // matchListed also reads a subsidiary named after its parent ("BioNTech US
  // Inc."); a one-word parent title has to match the whole name here.
  const byName: Listing | null = matchListed(n, listings);
  if (byName && listingAgrees(n, byName, modelTicker)) return { ticker: byName.ticker, by: "name" };
  const t = modelTicker.trim().toUpperCase();
  if (t) {
    const l = listings.byTicker.get(t) ?? listings.byTicker.get(t.replace(".", "-"));
    if (l && isListed(l) && listingAgrees(n, l, t)) return { ticker: l.ticker, by: "model" };
  }
  return { ticker: null, by: "unresolved" };
}
