/**
 * Falcon rule universes (design 4.3). Membership is today's: every result on
 * them carries the survivorship flag (check 15).
 *
 * falcon_semis mirrors SECTORS.semis in packages/engine/src/universe.ts (the
 * engine's watched list, 58 tickers). It is copied, not imported, so the
 * backtester does not depend on the engine package; a test keeps them equal.
 */

export type UniverseBase = "falcon_semis" | "sector_etfs";

export const UNIVERSES: Record<UniverseBase, { label: string; tickers: string[]; note: string }> = {
  falcon_semis: {
    label: "Falcon semiconductors list",
    note: "The 58 semiconductor and equipment companies Falcon watches, as listed today.",
    tickers: [
      "NVDA", "AMD", "AVGO", "INTC", "QCOM", "MU", "MRVL", "ARM", "TXN", "ADI", "ON", "MCHP", "NXPI", "STM",
      "LSCC", "MPWR", "SWKS", "QRVO", "CRUS", "SITM", "SLAB", "SYNA", "MTSI", "ALGM", "AMBA", "RMBS", "ALAB",
      "CRDO", "WOLF", "POWI", "DIOD", "SMTC", "MXL",
      "TSM", "GFS", "UMC", "ASX", "AMKR",
      "ASML", "AMAT", "LRCX", "KLAC", "TER", "ENTG", "ONTO", "NVMI", "CAMT", "FORM", "COHU", "ACLS", "UCTT",
      "ICHR", "SNPS", "CDNS",
      "SMCI", "COHR", "LITE", "ANET",
    ],
  },
  sector_etfs: {
    label: "the 11 Select Sector SPDR ETFs",
    note: "XLRE starts in October 2015 and XLC in June 2018; rankings use the funds with data on each date.",
    tickers: ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"],
  },
};
