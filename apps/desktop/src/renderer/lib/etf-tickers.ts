/**
 * Which held tickers are funds rather than companies.
 *
 * The symbol directory the app searches deliberately drops ETFs, so a held
 * fund carries no type with it — the only thing the book knows about a
 * position is its ticker. This is the list that tells the Positions card
 * which group a row belongs in: the funds a reader here plausibly holds
 * (index, sector, factor, bond, commodity, and the big thematic names).
 *
 * A fund missing from the list reads as a stock, which is the safe way round:
 * a wrong group is a cosmetic error, and the row is still there with its own
 * value and P/L.
 */
const ETFS = new Set([
  // Broad US market
  "SPY", "VOO", "IVV", "VTI", "ITOT", "SCHB", "SPLG", "QQQ", "QQQM", "DIA",
  "IWM", "IWB", "IWV", "VTV", "VUG", "VB", "VO", "MDY", "RSP", "SCHX", "SCHG",
  // International / regional
  "VXUS", "VEU", "VEA", "VWO", "IEFA", "IEMG", "EFA", "EEM", "ACWI", "VT",
  "EWJ", "EWZ", "EWY", "EWG", "EWU", "INDA", "MCHI", "FXI", "KWEB", "ASHR",
  // Sector / industry
  "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE",
  "XLC", "SMH", "SOXX", "SOXL", "SOXS", "IBB", "XBI", "XOP", "XME", "XRT",
  "KRE", "ITB", "JETS", "IYR", "VNQ", "VGT", "VHT", "VDE", "VFH", "VPU",
  // Factor / dividend / income
  "SCHD", "VYM", "DVY", "SDY", "NOBL", "HDV", "SPHD", "JEPI", "JEPQ", "QYLD",
  "DGRO", "VIG", "MOAT", "USMV", "QUAL", "MTUM", "VLUE", "SPMO",
  // Bonds / rates / cash-like
  "BND", "AGG", "BNDX", "TLT", "IEF", "SHY", "SGOV", "BIL", "TIP", "VTIP",
  "LQD", "HYG", "JNK", "MUB", "VCIT", "VCSH", "USFR", "TFLO",
  // Commodities / metals / crypto funds
  "GLD", "IAU", "GLDM", "SLV", "PPLT", "USO", "UNG", "DBC", "PDBC", "GDX",
  "GDXJ", "IBIT", "FBTC", "GBTC", "ETHE", "BITO", "ARKB", "BITB",
  // Thematic / active
  "ARKK", "ARKG", "ARKW", "ARKQ", "ARKF", "ICLN", "TAN", "LIT", "BOTZ",
  "ROBO", "HACK", "CIBR", "SKYY", "FDN", "IGV", "WCLD", "MJ", "URA", "NLR",
  // Leveraged / volatility (held more often than anyone admits)
  "TQQQ", "SQQQ", "UPRO", "SPXU", "SSO", "SDS", "TNA", "TZA", "UVXY", "VXX",
  "SVIX", "TMF", "TMV", "NVDL", "TSLL", "MSTX", "MSTU",
]);

/** True when the ticker is a fund the Positions card should file under ETFs. */
export function isEtfTicker(symbol: string): boolean {
  return ETFS.has(symbol.trim().toUpperCase());
}
