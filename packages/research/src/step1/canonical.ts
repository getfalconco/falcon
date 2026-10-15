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
  // One entity under its acronym and its full name (two nodes before).
  // CNPC and CNOOC are the state-owned parents, never the listed subsidiaries
  // (see NOT_THE_LISTED_ENTITY in entityResolution.ts).
  cnpc: "china national petroleum",
  cnooc: "china national offshore oil",
  egpc: "egyptian general petroleum",
  "egpc egyptian general petroleum": "egyptian general petroleum",
  "kuwait petroleum exploration company kufpec": "kuwait petroleum exploration",
  "foxconn hon hai": "hon hai precision industry",
  "national institutes of health nih": "national institutes of health",
  nih: "national institutes of health",
  ariad: "ariad pharmaceuticals",
  arbutus: "arbutus biopharma",
  genevant: "genevant sciences",
  liugong: "guangxi liugong machinery",
  "j c bamford excavators": "jc bamford excavators",
};

/** Canonical key and label of the one node US federal bodies collapse onto. */
export const US_GOVERNMENT_KEY = "us government";
export const US_GOVERNMENT_LABEL = "U.S. government";

/**
 * US federal government bodies that collapse onto the "U.S. government" node,
 * keyed by `canonicalCounterpartyKey(name, { applyAliases: false })`; the value
 * is the body's display name, kept on the edge as `counterparty_detail`.
 *
 * Conservative on purpose: every key names a US federal body without needing
 * context (a bare "Department of Energy" or "Federal Government" could be
 * another country's, so only the "U.S."-prefixed form is listed). Left out:
 * regulators acting as regulators (FDA, FAA, SEC), independent bodies that are
 * not the government's purse (Federal Reserve, FDIC), programs rather than
 * bodies (Medicare, Medicaid, Energy Star) and states.
 */
const US_GOVERNMENT_BODIES: Readonly<Record<string, string | null>> = {
  // The government itself (no detail: the edge names nothing narrower).
  "us government": null,
  "us federal government": null,
  "united states government": null,
  "united states federal government": null,
  "government of the united states": null,
  "us govt": null,
  // Defense
  "department of defense": "U.S. Department of Defense",
  "us department of defense": "U.S. Department of Defense",
  "united states department of defense": "U.S. Department of Defense",
  "department of war": "U.S. Department of War",
  "us department of war": "U.S. Department of War",
  "united states department of war": "U.S. Department of War",
  "us army": "U.S. Army",
  "united states army": "U.S. Army",
  "us navy": "U.S. Navy",
  "united states navy": "U.S. Navy",
  "us air force": "U.S. Air Force",
  "united states air force": "U.S. Air Force",
  "us marine corps": "U.S. Marine Corps",
  "united states marine corps": "U.S. Marine Corps",
  "us space force": "U.S. Space Force",
  "united states space force": "U.S. Space Force",
  "us coast guard": "U.S. Coast Guard",
  "united states coast guard": "U.S. Coast Guard",
  "missile defense agency": "Missile Defense Agency",
  "us missile defense agency": "Missile Defense Agency",
  "defense contract management agency": "Defense Contract Management Agency",
  "defense contract audit agency": "Defense Contract Audit Agency",
  "defense advanced research projects agency": "Defense Advanced Research Projects Agency",
  "defense logistics agency": "Defense Logistics Agency",
  "defense information systems agency": "Defense Information Systems Agency",
  "national geospatial intelligence agency": "National Geospatial-Intelligence Agency",
  "national reconnaissance office": "National Reconnaissance Office",
  "space development agency": "Space Development Agency",
  "us space development agency": "Space Development Agency",
  // Civil
  nasa: "NASA",
  "national aeronautics and space administration": "NASA",
  "department of homeland security": "U.S. Department of Homeland Security",
  "us department of homeland security": "U.S. Department of Homeland Security",
  "us department of energy": "U.S. Department of Energy",
  "united states department of energy": "U.S. Department of Energy",
  "us department of commerce": "U.S. Department of Commerce",
  "united states department of commerce": "U.S. Department of Commerce",
  "us department of health and human services": "U.S. Department of Health and Human Services",
  "us departments of health and human services": "U.S. Department of Health and Human Services",
  "united states department of health and human services": "U.S. Department of Health and Human Services",
  "centers for medicare and medicaid services": "Centers for Medicare & Medicaid Services",
  "centers for medicare medicaid services": "Centers for Medicare & Medicaid Services",
  "us department of veterans affairs": "U.S. Department of Veterans Affairs",
  "department of veterans affairs": "U.S. Department of Veterans Affairs",
  "us department of state": "U.S. Department of State",
  "us department of transportation": "U.S. Department of Transportation",
};

/**
 * Acronyms that name a US federal body only when the extractor typed the
 * counterparty as a government ("DOW" is also Dow Inc., "CMS" a dozen companies).
 */
const US_GOVERNMENT_ACRONYMS: Readonly<Record<string, string>> = {
  dod: "U.S. Department of Defense",
  usdod: "U.S. Department of Defense",
  dow: "U.S. Department of War",
  usaf: "U.S. Air Force",
  mda: "Missile Defense Agency",
  dcma: "Defense Contract Management Agency",
  dcaa: "Defense Contract Audit Agency",
  darpa: "Defense Advanced Research Projects Agency",
  dla: "Defense Logistics Agency",
  disa: "Defense Information Systems Agency",
  nga: "National Geospatial-Intelligence Agency",
  nro: "National Reconnaissance Office",
  sda: "Space Development Agency",
  dhs: "U.S. Department of Homeland Security",
  hhs: "U.S. Department of Health and Human Services",
  cms: "Centers for Medicare & Medicaid Services",
};

/**
 * The US federal body a counterparty name stands for, or null. `detail` is the
 * body's display name (null for the government itself).
 */
export function usGovernmentBody(
  name: string,
  counterpartyType?: string | null,
): { detail: string | null } | null {
  const raw = canonicalCounterpartyKey(name, { applyAliases: false });
  if (Object.prototype.hasOwnProperty.call(US_GOVERNMENT_BODIES, raw)) {
    return { detail: US_GOVERNMENT_BODIES[raw] ?? null };
  }
  if (counterpartyType === "government") {
    const acronym = US_GOVERNMENT_ACRONYMS[raw];
    if (acronym) return { detail: acronym };
  }
  return null;
}

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
  edge: {
    counterparty_name: string;
    counterparty_ticker: string | null;
    counterparty_type?: string | null;
    root_ticker?: string | null;
  },
  options: TickerSanitizeOptions = {},
): { id: string; ticker: string | null; detail: string | null } {
  const { ticker } = sanitizeCounterpartyTicker(edge.counterparty_ticker, options);
  // A counterparty resolved to the filer's own ticker is an affiliate the
  // filing names separately (or a resolver slip): keep it as a name node,
  // never as an edge from a company to itself.
  const self = ticker !== null && ticker === edge.root_ticker?.trim().toUpperCase();
  if (ticker && !self) return { id: ticker, ticker, detail: null };
  const gov = usGovernmentBody(edge.counterparty_name, edge.counterparty_type);
  if (gov) return { id: `name:${US_GOVERNMENT_KEY}`, ticker: null, detail: gov.detail };
  return { id: `name:${canonicalCounterpartyKey(edge.counterparty_name)}`, ticker: null, detail: null };
}

/**
 * True for an edge from a company to itself: its counterparty id or ticker is
 * the root's own ticker. The builder never emits one; graph files built before
 * that guard can carry them (JD's "JD Technology" resolved to JD), so loaders
 * drop them on read.
 */
export function isSelfEdge(edge: {
  root_ticker?: string | null;
  counterparty_id?: string | null;
  counterparty_ticker?: string | null;
}): boolean {
  const root = edge.root_ticker?.trim().toUpperCase();
  if (!root) return false;
  return (
    edge.counterparty_id?.trim().toUpperCase() === root || edge.counterparty_ticker?.trim().toUpperCase() === root
  );
}

/**
 * Bring an edge from a graph file built before the "U.S. government" fold up
 * to it: a US federal body without a ticker gets the shared node id and its
 * body as `counterparty_detail`. Edges with a ticker, edges the builder already
 * stamped (`counterparty_detail` present) and every other name are returned as
 * they are. Pure; returns a new object only when it changes something.
 */
export function foldGovernmentCounterparty<
  E extends {
    counterparty_id?: string | null;
    counterparty_ticker?: string | null;
    counterparty_name?: string | null;
    counterparty_type?: string | null;
    counterparty_detail?: string | null;
  },
>(edge: E): E {
  if (edge.counterparty_detail !== undefined) return edge;
  if (typeof edge.counterparty_ticker === "string" && edge.counterparty_ticker.trim()) return edge;
  if (typeof edge.counterparty_name !== "string" || !edge.counterparty_name.trim()) return edge;
  const gov = usGovernmentBody(edge.counterparty_name, edge.counterparty_type);
  if (!gov) return edge;
  return { ...edge, counterparty_id: `name:${US_GOVERNMENT_KEY}`, counterparty_detail: gov.detail };
}
