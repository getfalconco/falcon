/**
 * SEC SIC code -> one of 11 GICS-like sectors, for the Graph tab's Sector
 * filter. SIC is the SEC's own industry code (EDGAR submissions, `sic`); it
 * is free and public, but older and coarser than GICS, so a few names land
 * where GICS would not put them: SIC 7370-7379 (computer services) puts
 * Alphabet and Meta in Information Technology, not Communication Services,
 * and 5331 (variety stores) puts Walmart and Costco in Consumer Staples.
 *
 * Ranges are checked in order; the first that contains the code wins.
 */

export const SECTORS = [
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Financials",
  "Health Care",
  "Industrials",
  "Information Technology",
  "Materials",
  "Real Estate",
  "Utilities",
];

/** [from, to, sector], inclusive SIC ranges; specific ranges before the broad ones they sit in. */
const RANGES = [
  [100, 999, "Consumer Staples"], // agriculture, forestry, fishing
  [1000, 1099, "Materials"], // metal mining
  [1200, 1399, "Energy"], // coal, oil and gas
  [1400, 1499, "Materials"], // nonmetallic minerals
  [1520, 1531, "Consumer Discretionary"], // homebuilders
  [1500, 1799, "Industrials"], // construction
  [2000, 2199, "Consumer Staples"], // food, beverages, tobacco
  [2200, 2399, "Consumer Discretionary"], // textiles, apparel
  [2400, 2499, "Materials"], // lumber, wood
  [2500, 2599, "Consumer Discretionary"], // furniture
  [2600, 2699, "Materials"], // paper
  [2700, 2799, "Communication Services"], // printing, publishing
  [2830, 2836, "Health Care"], // drugs, biologicals
  [2840, 2844, "Consumer Staples"], // soaps, cosmetics
  [2800, 2899, "Materials"], // chemicals
  [2900, 2999, "Energy"], // petroleum refining
  [3011, 3011, "Consumer Discretionary"], // tires
  [3000, 3099, "Materials"], // rubber, plastics
  [3100, 3199, "Consumer Discretionary"], // leather
  [3200, 3399, "Materials"], // stone, glass, primary metals
  [3400, 3499, "Industrials"], // fabricated metal
  [3570, 3579, "Information Technology"], // computers, office machines
  [3500, 3599, "Industrials"], // industrial machinery
  [3630, 3639, "Consumer Discretionary"], // household appliances
  [3651, 3652, "Consumer Discretionary"], // household audio and video
  [3660, 3689, "Information Technology"], // communications equipment, semiconductors, components
  [3600, 3699, "Industrials"], // electrical equipment
  [3710, 3716, "Consumer Discretionary"], // motor vehicles, parts
  [3750, 3751, "Consumer Discretionary"], // motorcycles, bicycles
  [3790, 3799, "Consumer Discretionary"], // recreational vehicles
  [3700, 3799, "Industrials"], // aircraft, ships, rail, defense
  [3812, 3812, "Industrials"], // defense electronics, navigation
  [3820, 3829, "Information Technology"], // measuring instruments
  [3840, 3851, "Health Care"], // medical instruments
  [3860, 3869, "Information Technology"], // photographic equipment
  [3800, 3899, "Industrials"], // other instruments
  [3900, 3999, "Consumer Discretionary"], // miscellaneous manufacturing
  [4000, 4799, "Industrials"], // transportation
  [4800, 4899, "Communication Services"], // telecom, broadcasting
  [4950, 4959, "Industrials"], // waste management
  [4900, 4999, "Utilities"], // electric, gas, water
  [5122, 5122, "Health Care"], // drug wholesale
  [5140, 5149, "Consumer Staples"], // grocery wholesale
  [5170, 5172, "Energy"], // petroleum wholesale
  [5000, 5199, "Industrials"], // other wholesale
  [5330, 5331, "Consumer Staples"], // variety stores
  [5400, 5499, "Consumer Staples"], // food stores
  [5912, 5912, "Consumer Staples"], // drug stores
  [5200, 5999, "Consumer Discretionary"], // retail
  [6500, 6599, "Real Estate"], // real estate
  [6798, 6798, "Real Estate"], // REITs
  [6000, 6799, "Financials"], // banks, insurance, brokers, holding companies
  [7000, 7099, "Consumer Discretionary"], // hotels
  [7200, 7299, "Consumer Discretionary"], // personal services
  [7310, 7319, "Communication Services"], // advertising
  [7370, 7379, "Information Technology"], // software, computer services
  [7300, 7399, "Industrials"], // other business services
  [7500, 7599, "Consumer Discretionary"], // auto services
  [7800, 7899, "Communication Services"], // motion pictures
  [7900, 7999, "Consumer Discretionary"], // amusement, recreation
  [8000, 8099, "Health Care"], // health services
  [8200, 8299, "Consumer Discretionary"], // education
  [8000, 8999, "Industrials"], // engineering, management, other services
];

/** Names with no SIC on EDGAR (foreign or OTC) or only a preferred-share ticker: set by hand. */
export const SECTOR_OVERRIDES = {
  HNHPF: "Information Technology", // Hon Hai Precision (Foxconn), OTC
  IFNNY: "Information Technology", // Infineon, unsponsored ADR
  SUN: "Energy", // Sunoco LP
  "SCE-PG": "Utilities", // Southern California Edison preferred
  "PCG-PE": "Utilities", // Pacific Gas and Electric preferred
};

/** The sector for a SIC code, or null when no range holds it (9000s: nonclassifiable). */
export function sectorForSic(sic) {
  const n = Number(sic);
  if (!Number.isFinite(n)) return null;
  for (const [from, to, sector] of RANGES) if (n >= from && n <= to) return sector;
  return null;
}

export function sectorFor(ticker, sic) {
  return SECTOR_OVERRIDES[ticker] ?? sectorForSic(sic);
}
