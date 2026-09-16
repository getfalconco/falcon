/** Step1 / graph root tickers polled for company news. */
export const SEEDED_TICKERS = [
  "AMD",
  "AVGO",
  "DELL",
  "GRMN",
  "HPQ",
  "INTC",
  "MRT",
  "MSFT",
  "NVDA",
  "ORCL",
  "PLTR",
  "QCOM",
  "RBLX",
  "SNOW",
  "TSM",
] as const;

export type SeededTicker = (typeof SEEDED_TICKERS)[number];
