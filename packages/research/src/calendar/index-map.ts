/**
 * Session calendar: which held funds an index rebalance concerns.
 *
 * A rebalance of the S&P 500 matters to a reader who holds SPY, not to one who
 * holds only single stocks. This is the small, hand-kept map from a fund
 * symbol to the index family whose schedule moves it.
 */

import type { IndexFamily } from "./types.js";

export const INDEX_FAMILY_LABEL: Record<IndexFamily, string> = {
  sp: "S&P 500 family",
  nasdaq100: "Nasdaq-100",
  russell: "Russell",
  msci: "MSCI",
};

/**
 * Funds by the index provider whose rebalance calendar they follow, leveraged
 * and inverse wrappers included: they re-hedge on the same dates.
 *
 * "sp" is the provider family, not the S&P 500 alone. MDY and IJH (S&P MidCap
 * 400), IJR (S&P SmallCap 600), ITOT (S&P Total Market), the style and factor
 * funds over those indices, RSP (equal weight) and the Select Sector SPDRs all
 * rebalance after the same third-Friday close, so one scheduled date speaks
 * for all of them.
 *
 * Left out on purpose, although widely held: VTI (CRSP US Total Market), SCHD
 * (Dow Jones U.S. Dividend 100), and VWO, VEA, VXUS, VT (FTSE). Their indices
 * rebalance on other providers' calendars; filing them under the nearest
 * look-alike family would attach a date to a fund it does not move. A symbol
 * that is not listed gets no rebalance line at all, which is the honest
 * answer when the schedule is not known here.
 */
export const INDEX_FAMILY_FUNDS: Record<IndexFamily, readonly string[]> = {
  sp: [
    "SPY",
    "VOO",
    "IVV",
    "SPLG",
    "RSP",
    "UPRO",
    "SPXU",
    "SSO",
    "SDS",
    "MDY",
    "IJH",
    "IJR",
    "ITOT",
    "SPYG",
    "SPYV",
    "VOOG",
    "VOOV",
    "SPLV",
    "SPHQ",
    "XLK",
    "XLF",
    "XLE",
    "XLV",
    "XLY",
    "XLP",
    "XLI",
    "XLB",
    "XLU",
    "XLRE",
    "XLC",
  ],
  nasdaq100: ["QQQ", "QQQM", "TQQQ", "SQQQ"],
  russell: ["IWM", "IWB", "IWV", "TNA", "TZA"],
  msci: ["EEM", "EFA", "ACWI", "IEMG", "IEFA", "EWJ", "EWZ", "EWY", "EWG", "EWU", "INDA", "MCHI"],
};

const FAMILY_BY_SYMBOL: ReadonlyMap<string, IndexFamily> = new Map(
  (Object.keys(INDEX_FAMILY_FUNDS) as IndexFamily[]).flatMap((family) =>
    INDEX_FAMILY_FUNDS[family].map((symbol): [string, IndexFamily] => [symbol, family]),
  ),
);

/**
 * Holdings arrive from the renderer's paper account, where a symbol is whatever
 * the user typed: mixed case, stray spaces, and over IPC not even guaranteed
 * to be a string.
 */
function normalize(symbol: unknown): string | null {
  if (typeof symbol !== "string") return null;
  const s = symbol.trim().toUpperCase();
  return s.length > 0 ? s : null;
}

export function indexFamilyOf(symbol: string): IndexFamily | null {
  const s = normalize(symbol);
  return s === null ? null : (FAMILY_BY_SYMBOL.get(s) ?? null);
}

/** The held symbols that track `family`: upper-cased, de-duplicated, in input order. */
export function heldFundsTracking(family: IndexFamily, heldSymbols: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(heldSymbols)) return out;
  for (const raw of heldSymbols) {
    const s = normalize(raw);
    if (s === null || seen.has(s)) continue;
    seen.add(s);
    if (FAMILY_BY_SYMBOL.get(s) === family) out.push(s);
  }
  return out;
}
