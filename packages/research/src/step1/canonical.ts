/**
 * Counterparty identity hygiene for the relationship graph.
 *
 * The step1 extractor names the same company in several ways across filings
 * ("Samsung Electronics Co., Ltd." / "Samsung", "Huawei Technologies Co. Ltd." /
 * "Huawei", "AMD" while AMD is also a root ticker). `normalizeCompanyName` only
 * strips legal suffixes, so those variants became separate `name:` nodes.
 *
 * This module produces a stricter, deterministic *canonical key* used for graph
 * node identity (builder side only — the extraction pipeline, dedupe and the
 * SEC ticker matcher keep using `normalizeCompanyName`), plus a small explicit
 * blocklist of implausible `counterparty_ticker` values.
 */
import { LEGAL_SUFFIXES, normalizeCompanyName } from "./normalize.js";

/**
 * Normalised-name variant → canonical normalised key. Keys and values are in
 * `normalizeCompanyName` form. Values should be the most complete legal form so
 * that an un-aliased full name lands on the same key. Keep this list small and
 * unambiguous — trade names / acronyms of one legal entity only.
 */
export const COUNTERPARTY_ALIASES: Readonly<Record<string, string>> = {
  // Semis / hardware
  samsung: "samsung electronics",
  huawei: "huawei technologies",
  foxconn: "hon hai precision industry",
  "foxconn technology": "hon hai precision industry",
  "foxconn technology group": "hon hai precision industry",
  amd: "advanced micro devices",
  tsmc: "taiwan semiconductor manufacturing",
  "taiwan semiconductor": "taiwan semiconductor manufacturing",
  "global foundries": "globalfoundries",
  nxp: "nxp semiconductors",
  umc: "united microelectronics",
  "sk hynix": "sk hynix",
  // Healthcare / retail
  cvs: "cvs health",
  // Cloud / software
  aws: "amazon web services",
  "openai opco": "openai",
  // Funds
  hps: "hps investment partners",
  elmtree: "elmtree funds",
  // Government / agencies
  dcaa: "defense contract audit agency",
  "department of defense": "us department of defense",
  dod: "us department of defense",
  "space development agency": "us space development agency",
  opec: "organization of petroleum exporting countries",
};

/**
 * `counterparty_ticker` values the SEC ticker matcher can emit that are not
 * tradable US symbols. The edge keeps its name node; the ticker is cleared.
 *
 * - SKHY: SEC company_tickers.json lists "SKHY" for SK hynix Inc. but no US
 *   exchange or OTC venue trades it (US OTC ADR is HXSCL, home listing 000660.KS).
 */
export const IMPLAUSIBLE_COUNTERPARTY_TICKERS: ReadonlySet<string> = new Set(["SKHY"]);

/** Extra trailing tokens (beyond `LEGAL_SUFFIXES`) that never carry identity. */
const EXTRA_SUFFIXES = [
  "incorporated",
  "spa",
  "lp",
  "llp",
  "lpa",
  "na",
  "gmbh",
  "bv",
  "ab",
  "asa",
  "oyj",
  "pte",
  "pty",
  "kg",
  "sarl",
  "srl",
];

const SUFFIX_SET = new Set<string>([...LEGAL_SUFFIXES, ...EXTRA_SUFFIXES]);

/** Trailing "/DE", "/NEW", " /MD/" incorporation-state junk on SEC company titles. */
const SEC_TITLE_JUNK =
  /\s*\/\s*(?:NEW|OLD|ADR|DE|MD|CA|NV|PA|OH|TX|NJ|MN|FL|MA|VA|GA|WA|NY|IL|IN|MI|WI|CO|UT|OK|CT|AZ|NC|TN|MO|OR|KY|LA|NE|MS|AL|AR|SC|ID|KS|IA|NH|RI|VT|WV|NM|HI|AK|ND|SD|MT|WY|ME|DC|PR)\s*\/?\s*$/i;

/**
 * Canonical identity key for a counterparty name. Superset of
 * `normalizeCompanyName`: also collapses dotted abbreviations ("N.V." → "nv",
 * "U.S." → "us", "S.p.A." → "spa"), drops SEC title junk ("/DE/", "/NEW"),
 * a leading "the", extra legal-form suffixes, then applies
 * `COUNTERPARTY_ALIASES`.
 */
export function canonicalCounterpartyKey(
  name: string,
  options: { applyAliases?: boolean } = {},
): string {
  let s = name.trim();
  // SEC titles: "QUALCOMM INC/DE", "NORTHROP GRUMMAN CORP /DE/", "COSTCO WHOLESALE CORP /NEW".
  s = s.replace(SEC_TITLE_JUNK, "");
  // Dotted abbreviations (two or more single letters each followed by a dot).
  s = s.replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ""));
  s = normalizeCompanyName(s);

  const parts = s.split(" ").filter(Boolean);
  if (parts.length > 1 && parts[0] === "the") parts.shift();
  while (parts.length > 1 && SUFFIX_SET.has(parts[parts.length - 1]!)) parts.pop();

  const key = parts.join(" ");
  if (options.applyAliases === false) return key;
  return COUNTERPARTY_ALIASES[key] ?? key;
}

export type TickerSanitizeOptions = {
  /**
   * Optional catalog of plausible symbols (e.g. the US exchange listing files the
   * desktop stock catalog already loads). When provided, tickers outside it are
   * cleared. Without it only `IMPLAUSIBLE_COUNTERPARTY_TICKERS` applies.
   */
  knownTickers?: ReadonlySet<string> | null;
};

export type TickerSanitizeResult = {
  ticker: string | null;
  /** Set when a non-null input ticker was cleared. */
  clearedReason: "blocklist" | "not_in_catalog" | null;
};

/** Upper-case and validate a `counterparty_ticker`; clears implausible ones. */
export function sanitizeCounterpartyTicker(
  ticker: string | null | undefined,
  options: TickerSanitizeOptions = {},
): TickerSanitizeResult {
  const upper = ticker?.trim().toUpperCase() ?? "";
  if (!upper) return { ticker: null, clearedReason: null };
  if (IMPLAUSIBLE_COUNTERPARTY_TICKERS.has(upper)) return { ticker: null, clearedReason: "blocklist" };
  const catalog = options.knownTickers;
  if (catalog && catalog.size > 0 && !catalog.has(upper)) {
    return { ticker: null, clearedReason: "not_in_catalog" };
  }
  return { ticker: upper, clearedReason: null };
}

/**
 * True for acronym-style labels ("AMD", "UMC", "SAP") that may literally be a ticker
 * symbol. Report-only hint — the builder never folds on this alone (BNTX's licensor
 * "MRT" is not Marti Technologies).
 */
export function looksLikeTickerSymbol(name: string): boolean {
  const t = name.trim();
  return /^[A-Z][A-Z0-9.-]{0,5}$/.test(t) && /[A-Z]{2,}/.test(t);
}

/**
 * Per-edge counterparty identity without whole-graph context: sanitised ticker
 * (ticker node id) or `name:<canonical key>`. `buildGraphFromResearchDir` adds
 * the whole-graph step of folding name variants onto existing ticker nodes.
 */
export function canonicalCounterparty(
  edge: { counterparty_name: string; counterparty_ticker: string | null },
  options: TickerSanitizeOptions = {},
): { id: string; ticker: string | null } {
  const { ticker } = sanitizeCounterpartyTicker(edge.counterparty_ticker, options);
  if (ticker) return { id: ticker, ticker };
  return { id: `name:${canonicalCounterpartyKey(edge.counterparty_name)}`, ticker: null };
}
