/**
 * Counterparty → security resolution (§S1).
 *
 * The step1 extractor names a counterparty the way the filing named it
 * ("Amazon", "Chevron U.S.A. Inc.", "Eli Lilly and Company"); the graph needs a
 * ticker, because a target without one can never be priced, scored or
 * verified. Measured on the 2026-08-26 graph, 738 of 1,001 edges carried no
 * `counterparty_ticker`, and 271 of those were `public_company` — real
 * resolution failures, not genuinely unlistable names.
 *
 * The old resolver was alias-then-exact-SEC-title only, which is why "Amazon"
 * failed while "amazon com" (the normalized SEC title) sat right there. This
 * module keeps that spine and adds the two matches that recover most of the
 * gap, each guarded by the failure mode it invites:
 *
 *   - **forward prefix** — the SEC title extends the query ("dell" →
 *     "dell technologies"). Safe only when the extra tokens are generic
 *     descriptors: "tencent" → "tencent music entertainment" is a DIFFERENT
 *     company, and "westinghouse" → "westinghouse air brake" is a different
 *     company again. Hence `GENERIC_CONTINUATIONS`.
 *   - **reverse prefix** — the query extends the SEC title ("chevron u s a" →
 *     "chevron"). This is the subsidiary case, and mapping a subsidiary's
 *     events onto the listed parent is what we want. It is recorded as its own
 *     method so it stays auditable, because the same shape also catches joint
 *     ventures ("Sanofi Pasteur MSD" was an MSD/Sanofi JV, not Sanofi).
 *
 * Ambiguity is resolved only when it is share-class noise. A name matching
 * ASML and ASMLF is one company quoted two ways; a name matching GEHC and GEV
 * is two companies, and resolves to neither.
 *
 * Nothing here guesses. Every path returns the method that produced it, and an
 * unresolved name stays null — a wrong ticker is worse than no ticker, because
 * it produces a confident signal about the wrong company.
 */

import { COUNTERPARTY_ALIASES } from "./canonical.js";
import { normalizeCompanyName } from "./normalize.js";
import type { CounterpartyType } from "./types.js";

export type SecTickerLookup = { ticker: string; title: string };

export type ResolutionMethod =
  | "alias"
  | "exact"
  | "prefix_generic"
  | "prefix_subsidiary"
  | "share_class";

export type ResolutionResult = {
  ticker: string | null;
  method: ResolutionMethod | null;
  /** Why a resolvable-looking name was refused, for the hygiene report. */
  rejected: "ambiguous" | "blocked" | "distinguishing_suffix" | null;
};

const UNRESOLVED: ResolutionResult = { ticker: null, method: null, rejected: null };

/**
 * Normalized name → ticker, checked before any SEC lookup.
 *
 * Three kinds of entry live here, and only these three:
 *   1. acronyms and trade names the SEC title does not contain ("bms", "aws");
 *   2. names whose automatic match is WRONG and must be pinned or refused —
 *      these are the false positives the prefix rules produce, recorded here
 *      so they can never come back (see `BLOCKED_NAMES` for the refusals);
 *   3. foreign issuers whose US line is an ADR the title match cannot reach.
 */
export const COUNTERPARTY_TICKER_ALIASES: Readonly<Record<string, string>> = {
  // Trade names / acronyms
  google: "GOOGL",
  alphabet: "GOOGL",
  youtube: "GOOGL",
  honeywell: "HON",
  "honeywell aerospace defense": "HON",
  meta: "META",
  facebook: "META",
  instagram: "META",
  aws: "AMZN",
  "amazon web services": "AMZN",
  "microsoft azure": "MSFT",
  azure: "MSFT",
  bms: "BMY",
  "bristol myers squibb": "BMY",
  ibm: "IBM",
  "international business machines": "IBM",
  ge: "GE",
  "general electric": "GE",
  "ge aerospace": "GE",
  "ge vernova": "GEV",
  "ge healthcare": "GEHC",
  jd: "JD",
  "jd technology": "JD",
  "jd com": "JD",
  msd: "MRK",
  merck: "MRK",
  "hewlett packard": "HPQ",
  "hp inc": "HPQ",
  "hewlett packard enterprise": "HPE",
  hpe: "HPE",
  // Foreign issuers — US line where one exists
  "taiwan semiconductor manufacturing": "TSM",
  tsmc: "TSM",
  asml: "ASML",
  "asml holding": "ASML",
  sap: "SAP",
  "novo nordisk": "NVO",
  novartis: "NVS",
  "astrazeneca": "AZN",
  sanofi: "SNY",
  gsk: "GSK",
  glaxosmithkline: "GSK",
  "daiichi sankyo": "DSNKY",
  takeda: "TAK",
  "alibaba": "BABA",
  "alibaba group": "BABA",
  tencent: "TCEHY",
  "tencent holdings": "TCEHY",
  baidu: "BIDU",
  sony: "SONY",
  "hon hai precision industry": "HNHPF",
  foxconn: "HNHPF",
  "sk hynix": "HXSCL",
  infineon: "IFNNY",
  stmicroelectronics: "STM",
  "united microelectronics": "UMC",
  "nxp semiconductors": "NXPI",
  "globalfoundries": "GFS",
  embraer: "ERJ",
  airbus: "EADSY",
  siemens: "SIEGY",
  "siemens energy": "SMNEY",
  "siemens healthineers": "SMMNY",
  komatsu: "KMTUY",
  kubota: "KUBTY",
  "kubota tractor": "KUBTY",
  "volvo": "VLVLY",
  "volvo group": "VLVLY",
  "mitsubishi heavy industries": "MHVYF",
  "mitsubishi electric": "MIELY",
  "mitsubishi ufj financial": "MUFG",
  "sinopec": "SHI",
  "petrochina": "PCCYF",
  "china national petroleum": "PCCYF",
  vestas: "VWSYF",
  "vestas wind systems": "VWSYF",
  woodside: "WDS",
  "totalenergies": "TTE",
  ecopetrol: "EC",
  petrobras: "PBR",
  genmab: "GMAB",
  "ase technology": "ASX",
  ase: "ASX",
  "sany heavy industry": "SNHIY",
  "innovent biologics": "IVBXF",
  curevac: "CVAC",
  merus: "MRUS",
  syndax: "SNDX",
  immatics: "IMTX",
  mobileye: "MBLY",
  "l3harris technologies": "LHX",
  l3harris: "LHX",
  agco: "AGCO",
  "applied materials": "AMAT",
  "adobe systems": "ADBE",
  adobe: "ADBE",
  cisco: "CSCO",
  "cisco systems": "CSCO",
  dell: "DELL",
  "dell technologies": "DELL",
  amazon: "AMZN",
  "amazon com": "AMZN",
  amkor: "AMKR",
  "devon energy": "DVN",
  "occidental petroleum": "OXY",
  weatherford: "WFRD",
  centerpoint: "CNP",
  "eli lilly": "LLY",
  "eli lilly and": "LLY",
};

/**
 * Names that look resolvable and must never be auto-resolved.
 *
 * Each of these produced a confidently wrong ticker under the prefix rules.
 * They are not merely unresolved — they are refused, so that a later widening
 * of the matcher cannot silently reintroduce the error.
 */
export const BLOCKED_NAMES: ReadonlySet<string> = new Set([
  // "Mitsubishi" alone spans the bank, the trading house, Electric and Heavy
  // Industries. The automatic match picked MUFG (the bank) in a semiconductor
  // and industrials context. Only the qualified forms above resolve.
  "mitsubishi",
  // "Westinghouse Electric" (nuclear, private) vs WAB "Westinghouse Air Brake".
  "westinghouse",
  "westinghouse electric",
  // A Sanofi/MSD joint venture, not Sanofi. Reverse-prefix would map it to SNY.
  "sanofi pasteur msd",
  // Citibank N.A. is a bank subsidiary; the title match reaches unrelated ADRs.
  "citibank",
  "citibank n a",
  // Medline Industries is the (private) medical supplier; "Medline Inc." is an
  // unrelated small-cap the subsidiary rule would hand it.
  "medline industries",
  // "Tron Inc." is unrelated to the TRON the extractor meant; a product row
  // mis-typed as a public company should resolve to nothing, not to a shell.
  "tron",
  // Generic single words that prefix half the SEC list.
  "apollo",
  "arrow",
  "brookfield",
  "emerson",
  "national",
  "united",
  "general",
  "american",
]);

/**
 * Continuation tokens that describe a company without changing which company
 * it is. "dell" → "dell technologies" is Dell; "tencent" → "tencent music
 * entertainment" is not Tencent. Only a title whose extra tokens are ALL drawn
 * from this set may be reached by forward prefix.
 */
const GENERIC_CONTINUATIONS: ReadonlySet<string> = new Set([
  "com",
  "technologies",
  "technology",
  "systems",
  "system",
  "industries",
  "industrial",
  "international",
  "pharmaceuticals",
  "pharmaceutical",
  "pharma",
  "biosciences",
  "bioscience",
  "therapeutics",
  "laboratories",
  "labs",
  "energy",
  "resources",
  "petroleum",
  "materials",
  "semiconductor",
  "semiconductors",
  "microelectronics",
  "communications",
  "networks",
  "solutions",
  "services",
  "software",
  "digital",
  "global",
  "worldwide",
  "enterprises",
  "partners",
  "capital",
  "financial",
  "bancorp",
  "stores",
  "brands",
  "products",
  "manufacturing",
  "motor",
  "motors",
  "aerospace",
  "defense",
  "health",
  "healthcare",
  "medical",
  "biotech",
  "sciences",
]);

/** Counterparty kinds that can, in principle, carry a tradable ticker. */
export function isTradableKind(kind: CounterpartyType | string | null | undefined): boolean {
  return kind === "public_company";
}

/**
 * Extra legal forms `normalizeCompanyName` does not strip, and the SEC's
 * state-of-incorporation marker. Without these, "QUALCOMM INC/DE" normalizes
 * to "qualcomm inc de" — the trailing "de" blocks the "inc" strip — and a
 * perfectly ordinary name misses its own exact match.
 */
const EXTRA_LEGAL_FORMS: ReadonlySet<string> = new Set([
  "asa",
  "oyj",
  "ab",
  "as",
  "spa",
  "aktiengesellschaft",
  "sas",
  "srl",
  "bv",
  "gmbh",
  "pte",
  "pty",
  "lp",
  "llp",
  "trust",
  "adr",
]);

/** US state / territory codes the SEC appends as "/DE", "/MD/", "/DE/ADR". */
const STATE_CODES = /\/[A-Z]{2}(\/|\b)/g;

/**
 * Normalize an SEC `title` for indexing. Beyond `normalizeCompanyName` this
 * removes the state-of-incorporation marker, a leading "the", and the foreign
 * legal forms above — each of which otherwise splits a company from its own name.
 */
export function secTitleKey(title: string): string {
  const withoutState = title.replace(STATE_CODES, " ");
  return trimCompanyKey(normalizeCompanyName(withoutState));
}

/** Drop a leading "the" and any trailing legal forms `normalizeCompanyName` missed. */
function trimCompanyKey(key: string): string {
  const parts = key.split(" ").filter(Boolean);
  if (parts.length > 1 && parts[0] === "the") parts.shift();
  while (parts.length > 1 && EXTRA_LEGAL_FORMS.has(parts[parts.length - 1]!)) parts.pop();
  // "N.V." / "S.A." arrive as two single letters once punctuation is stripped.
  while (parts.length > 2 && parts[parts.length - 1]!.length === 1 && parts[parts.length - 2]!.length === 1) {
    parts.pop();
    parts.pop();
  }
  return parts.join(" ");
}

/** Normalize a counterparty name from a filing, the same way titles are keyed. */
export function counterpartyKey(name: string): string {
  return trimCompanyKey(normalizeCompanyName(name));
}

/**
 * The one US-tradable line for a single issuer.
 *
 * An issuer often carries several symbols: an ordinary common line, a
 * foreign-ordinary (…F) and/or ADR (…Y) five-letter line, and preferred lines
 * with a dot or dash. Exactly one of them is the symbol a reader would trade,
 * and this picks it. When only foreign lines exist the ADR wins, because that
 * is the line that trades in the US.
 *
 * This collapses share-class noise WITHIN one issuer. It must never be used to
 * choose between two issuers — see `resolveCounterparty`, which collapses each
 * title bucket first and only then requires the survivors to be unique.
 */
export function preferredListing(tickers: Iterable<string>): string | null {
  const all = [...new Set([...tickers].map((t) => t.toUpperCase()))].sort();
  if (all.length === 0) return null;
  if (all.length === 1) return all[0]!;

  let pool = all.filter((t) => !/[-.]/.test(t));
  if (pool.length === 0) pool = all;

  const domestic = pool.filter((t) => !(t.length === 5 && (t.endsWith("F") || t.endsWith("Y"))));
  if (domestic.length > 0) {
    pool = domestic;
  } else {
    const adr = pool.filter((t) => t.endsWith("Y"));
    if (adr.length > 0) pool = adr;
  }

  // The common line is the short one; a preferred series appends a letter.
  const shortest = Math.min(...pool.map((t) => t.length));
  return pool.filter((t) => t.length === shortest).sort()[0]!;
}

/**
 * Legacy name kept for the hygiene report: the set of listings that survive
 * share-class collapsing. One element means the name resolves.
 */
export function ordinaryListings(tickers: Iterable<string>): string[] {
  const preferred = preferredListing(tickers);
  return preferred ? [preferred] : [];
}

type TitleIndex = Map<string, Set<string>>;

function buildTitleIndex(entries: SecTickerLookup[]): TitleIndex {
  const index: TitleIndex = new Map();
  for (const entry of entries) {
    const key = secTitleKey(entry.title);
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) bucket.add(entry.ticker.toUpperCase());
    else index.set(key, new Set([entry.ticker.toUpperCase()]));
  }
  return index;
}

/** Cached per entries array — the SEC list is fetched once and reused. */
const indexCache = new WeakMap<SecTickerLookup[], TitleIndex>();

function titleIndexFor(entries: SecTickerLookup[]): TitleIndex {
  const cached = indexCache.get(entries);
  if (cached) return cached;
  const built = buildTitleIndex(entries);
  indexCache.set(entries, built);
  return built;
}

/** All extra tokens of `title` beyond `query` are generic descriptors. */
function continuationIsGeneric(query: string, title: string): boolean {
  if (!title.startsWith(`${query} `)) return false;
  const extra = title.slice(query.length + 1).split(" ").filter(Boolean);
  return extra.length > 0 && extra.every((token) => GENERIC_CONTINUATIONS.has(token));
}

/**
 * Resolve one counterparty name to a US-listed ticker.
 *
 * Order is by decreasing certainty: a pinned alias, an exact normalized SEC
 * title, a forward prefix whose continuation is generic, then the subsidiary
 * case. Ambiguity collapses only when it is share-class noise.
 */
export function resolveCounterparty(name: string, entries: SecTickerLookup[]): ResolutionResult {
  const query = counterpartyKey(name);
  if (!query) return UNRESOLVED;

  // The canonicaliser folds trade names onto their full legal form ("amd" →
  // "advanced micro devices"), so consult it before deciding the query is
  // unknown — otherwise every acronym the graph already handles regresses.
  const canonical = COUNTERPARTY_ALIASES[query] ?? query;

  for (const key of canonical === query ? [query] : [query, canonical]) {
    const alias = COUNTERPARTY_TICKER_ALIASES[key];
    if (alias) return { ticker: alias, method: "alias", rejected: null };
  }
  if (BLOCKED_NAMES.has(query) || BLOCKED_NAMES.has(canonical)) {
    return { ticker: null, method: null, rejected: "blocked" };
  }

  const index = titleIndexFor(entries);
  const keys = canonical === query ? [query] : [query, canonical];

  for (const key of keys) {
    const exact = index.get(key);
    if (!exact) continue;
    const listing = preferredListing(exact);
    if (listing) return { ticker: listing, method: "exact", rejected: null };
  }

  // Forward prefix — the SEC title extends the query with generic descriptors.
  // Each title bucket collapses to its own preferred listing FIRST, so two
  // share-class lines of one issuer read as one company while two genuinely
  // different companies (GEHC and GEV under "ge") still read as two.
  for (const key of keys) {
    const issuers = new Set<string>();
    let sawDistinguishingSuffix = false;
    for (const [title, tickers] of index) {
      if (!title.startsWith(`${key} `)) continue;
      if (!continuationIsGeneric(key, title)) {
        sawDistinguishingSuffix = true;
        continue;
      }
      const listing = preferredListing(tickers);
      if (listing) issuers.add(listing);
    }
    if (issuers.size === 1) {
      return { ticker: [...issuers][0]!, method: "prefix_generic", rejected: null };
    }
    if (issuers.size > 1) return { ticker: null, method: null, rejected: "ambiguous" };
    if (sawDistinguishingSuffix && key === keys[keys.length - 1]) {
      return { ticker: null, method: null, rejected: "distinguishing_suffix" };
    }
  }

  // Reverse prefix — the query extends a listed name: the subsidiary case.
  // The longest matching parent wins, so "chevron u s a" prefers "chevron"
  // over a shorter accidental stem.
  for (const key of keys) {
    let bestParent = "";
    let bestTickers: Set<string> | null = null;
    for (const [title, tickers] of index) {
      if (!key.startsWith(`${title} `)) continue;
      if (title.length > bestParent.length) {
        bestParent = title;
        bestTickers = tickers;
      }
    }
    if (!bestTickers) continue;
    const listing = preferredListing(bestTickers);
    if (listing) return { ticker: listing, method: "prefix_subsidiary", rejected: null };
  }

  return UNRESOLVED;
}
