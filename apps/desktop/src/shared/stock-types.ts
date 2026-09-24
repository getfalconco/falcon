export type ChartTimeframe = "1D" | "1W" | "1M" | "YTD" | "1Y" | "ALL";

export type StockQuote = {
  symbol: string;
  companyName: string;
  price: number;
  change: number;
  changePercent: number;
};

/** Which trading session the live price came from. */
export type LiveQuoteSession = "pre" | "regular" | "post" | "closed";

/** Lightweight, frequently-polled price for a single ticker. */
export type LiveQuote = {
  symbol: string;
  companyName: string;
  price: number;
  /** Change vs the baseline for the session (prev close, or today's close after hours). */
  change: number;
  changePercent: number;
  session: LiveQuoteSession;
  /** Unix ms of the trade/candle behind `price`. */
  asOf: number;
  /** The close before `regularPrice`'s session. Absent when the provider sent none. */
  previousClose?: number;
  /**
   * The last regular-session price. Equal to `price` while the regular session
   * trades; outside it, the close that an extended-hours `price` moved away from.
   */
  regularPrice?: number;
};

/** `t` = unix timestamp in milliseconds, `v` = price */
export type PricePoint = {
  t: number;
  v: number;
  o?: number;
  h?: number;
  l?: number;
  vol?: number;
  /** Trading session for intraday points: pre-market / regular / after-hours. */
  s?: "pre" | "reg" | "post";
};

/** Price movement for a ticker from a reference moment (e.g. a news event) to now. */
export type PriceMoveSince = {
  symbol: string;
  /** First candle close at/after the reference moment. */
  firstClose: number;
  /** Most recent candle close. */
  lastClose: number;
  /** Percent change firstClose → lastClose. */
  changePct: number;
  /** Lowest low across the window (intraday extreme). */
  low: number;
  /** Highest high across the window. */
  high: number;
  /** Unix ms of first / last candle used. */
  firstAt: number;
  lastAt: number;
  /** Number of candles in the window. */
  points: number;
};

export type StockKeyStat = {
  id: string;
  label: string;
  value: string;
};

export type SignalSentiment = "bullish" | "bearish" | "neutral";

export type StockAiSignal = {
  id: string;
  sentiment: SignalSentiment;
  text: string;
};

export type StockAiSummaryData = {
  summary: string;
  signals: StockAiSignal[];
};

export const DEFAULT_STOCK_SYMBOL = "NVDA";

export const CHART_TIMEFRAMES: ChartTimeframe[] = ["1D", "1W", "1M", "YTD", "1Y", "ALL"];

export type OverviewChartTimeframe = "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX";

export const OVERVIEW_CHART_TIMEFRAMES: OverviewChartTimeframe[] = [
  "1D",
  "5D",
  "1M",
  "6M",
  "YTD",
  "1Y",
  "5Y",
  "MAX",
];

export type StockSessionQuote = {
  price: number;
  change: number;
  changePercent: number;
  timestampLabel?: string;
};

export type StockOverviewStats = {
  prevClose: string;
  peRatio: string;
  weekRange52: string;
  marketCap: string;
  dayRange: string;
  eps: string;
  open: string;
  dividendYield: string;
  volume: string;
};

export type StockCompanyProfile = {
  symbol: string;
  ipoDate?: string;
  ceo?: string;
  fullTimeEmployees?: string;
  sector?: string;
  industry?: string;
  country?: string;
  exchange?: string;
  description?: string;
};

export type StockAnalystConsensus = {
  rating: string;
  /** Coarse sentiment bucket for badge styling. */
  ratingTone: "bullish" | "neutral" | "bearish";
  analystCount: number;
  bearish: number;
  neutral: number;
  bullish: number;
  priceTargets?: {
    low: number;
    current: number;
    average: number;
    high: number;
  };
};

export type StockNewsItem = {
  id: string;
  title: string;
  url: string;
  imageUrl?: string;
  source?: string;
  /** ISO-8601 timestamp */
  publishedAt?: string;
};

export type StockOverviewData = {
  quote: StockQuote;
  series: PricePoint[];
  previousClose: number;
  atClose: StockSessionQuote;
  preMarket?: StockSessionQuote;
  stats: StockOverviewStats;
  company: StockCompanyProfile;
  analystConsensus?: StockAnalystConsensus;
};

export const UNABLE_AI_SUMMARY: StockAiSummaryData = {
  summary: "Unable to provide",
  signals: [],
};
