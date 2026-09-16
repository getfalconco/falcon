export type StockCatalogEntry = {
  symbol: string;
  companyName: string;
  exchange?: string;
};

const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; Meridian Desktop/0.1)" };

let catalogPromise: Promise<StockCatalogEntry[]> | null = null;

type IndexEntry = StockCatalogEntry & { keywords: string[] };

/** Major market indices (Yahoo Finance symbols) surfaced in compare/search. */
const MARKET_INDICES: IndexEntry[] = [
  { symbol: "^GSPC", companyName: "S&P 500", exchange: "INDEX", keywords: ["sp500", "s&p 500", "spx", "standard and poors"] },
  { symbol: "^DJI", companyName: "Dow Jones Industrial Average", exchange: "INDEX", keywords: ["dow", "dow jones", "djia"] },
  { symbol: "^IXIC", companyName: "Nasdaq Composite", exchange: "INDEX", keywords: ["nasdaq", "nasdaq composite", "comp"] },
  { symbol: "^NDX", companyName: "Nasdaq 100", exchange: "INDEX", keywords: ["nasdaq 100", "ndx", "nq"] },
  { symbol: "^RUT", companyName: "Russell 2000", exchange: "INDEX", keywords: ["russell", "russell 2000", "rut"] },
  { symbol: "^VIX", companyName: "CBOE Volatility Index", exchange: "INDEX", keywords: ["vix", "volatility"] },
  { symbol: "^FTSE", companyName: "FTSE 100", exchange: "INDEX", keywords: ["ftse", "ftse 100", "uk"] },
  { symbol: "^GDAXI", companyName: "DAX", exchange: "INDEX", keywords: ["dax", "germany", "german"] },
  { symbol: "^FCHI", companyName: "CAC 40", exchange: "INDEX", keywords: ["cac", "cac 40", "france"] },
  { symbol: "^STOXX50E", companyName: "Euro Stoxx 50", exchange: "INDEX", keywords: ["stoxx", "euro stoxx", "europe"] },
  { symbol: "^N225", companyName: "Nikkei 225", exchange: "INDEX", keywords: ["nikkei", "nikkei 225", "japan"] },
  { symbol: "^HSI", companyName: "Hang Seng", exchange: "INDEX", keywords: ["hang seng", "hsi", "hong kong"] },
];

function matchIndices(trimmed: string): StockCatalogEntry[] {
  const toEntry = ({ keywords: _keywords, ...entry }: IndexEntry): StockCatalogEntry => entry;

  if (!trimmed) return MARKET_INDICES.map(toEntry);

  return MARKET_INDICES.filter(
    (index) =>
      index.symbol.toLowerCase().includes(trimmed) ||
      index.companyName.toLowerCase().includes(trimmed) ||
      index.keywords.some((keyword) => keyword.includes(trimmed)),
  ).map(toEntry);
}

/**
 * Fallback "popular" tickers shown when the compare menu opens with no query.
 * Used when trending/most-searched data is unavailable (currently always).
 */
const POPULAR_FALLBACK: StockCatalogEntry[] = [
  { symbol: "AAPL", companyName: "Apple", exchange: "NASDAQ" },
  { symbol: "MSFT", companyName: "Microsoft", exchange: "NASDAQ" },
  { symbol: "NVDA", companyName: "NVIDIA", exchange: "NASDAQ" },
  { symbol: "GOOGL", companyName: "Alphabet", exchange: "NASDAQ" },
  { symbol: "AMZN", companyName: "Amazon", exchange: "NASDAQ" },
  { symbol: "META", companyName: "Meta Platforms", exchange: "NASDAQ" },
  { symbol: "TSLA", companyName: "Tesla", exchange: "NASDAQ" },
  { symbol: "AMD", companyName: "Advanced Micro Devices", exchange: "NASDAQ" },
];

const SP500_ENTRY: StockCatalogEntry = {
  symbol: "^GSPC",
  companyName: "S&P 500",
  exchange: "INDEX",
};

/**
 * Suggestions for the empty compare menu: S&P 500 first, then the most-searched
 * tickers. Trending data isn't wired up yet, so we use a known-name fallback.
 */
function getDefaultSuggestions(): StockCatalogEntry[] {
  const trending: StockCatalogEntry[] = [];
  const popular = trending.length > 0 ? trending : POPULAR_FALLBACK;
  return [SP500_ENTRY, ...popular];
}

function cleanCompanyName(name: string): string {
  return name
    .replace(/\s+Common Stock.*$/i, "")
    .replace(/\s+Class [A-Z].*$/i, "")
    .replace(/\s+Ordinary Shares.*$/i, "")
    .replace(/\s+American Depositary Shares.*$/i, "")
    // "NVIDIA Corporation - Common Stock" leaves a dangling " -" once the
    // share-class suffix is stripped.
    .replace(/\s+[-–—]\s*$/, "")
    .trim();
}

function parseNasdaqListed(text: string): StockCatalogEntry[] {
  return text
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("File Creation"))
    .flatMap((line) => {
      const [symbol, securityName, , testIssue, , , etf] = line.split("|");
      if (!symbol || testIssue === "Y" || etf === "Y" || symbol.includes("$")) return [];

      return [
        {
          symbol: symbol.trim(),
          companyName: cleanCompanyName(securityName ?? symbol),
          exchange: "NASDAQ",
        },
      ];
    });
}

function parseOtherListed(text: string): StockCatalogEntry[] {
  return text
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("File Creation"))
    .flatMap((line) => {
      const [symbol, securityName, exchange, , etf, , testIssue] = line.split("|");
      if (!symbol || testIssue === "Y" || etf === "Y" || symbol.includes("$")) return [];

      return [
        {
          symbol: symbol.trim(),
          companyName: cleanCompanyName(securityName ?? symbol),
          exchange: exchange?.trim(),
        },
      ];
    });
}

async function loadCatalog(): Promise<StockCatalogEntry[]> {
  const [nasdaqResponse, otherResponse] = await Promise.all([
    fetch(NASDAQ_LISTED_URL, { headers: FETCH_HEADERS }),
    fetch(OTHER_LISTED_URL, { headers: FETCH_HEADERS }),
  ]);

  if (!nasdaqResponse.ok || !otherResponse.ok) {
    throw new Error("Failed to load US stock symbol directory");
  }

  const [nasdaqText, otherText] = await Promise.all([
    nasdaqResponse.text(),
    otherResponse.text(),
  ]);

  const bySymbol = new Map<string, StockCatalogEntry>();
  for (const entry of [...parseNasdaqListed(nasdaqText), ...parseOtherListed(otherText)]) {
    bySymbol.set(entry.symbol, entry);
  }

  return Array.from(bySymbol.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function getUsStockCatalog(): Promise<StockCatalogEntry[]> {
  if (!catalogPromise) {
    catalogPromise = loadCatalog().catch((error) => {
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

export async function searchUsStocks(
  query: string,
  limit = 50,
): Promise<StockCatalogEntry[]> {
  const trimmed = query.trim().toLowerCase();

  if (!trimmed) {
    return getDefaultSuggestions().slice(0, limit);
  }

  const catalog = await getUsStockCatalog();
  const indexMatches = matchIndices(trimmed);

  const results: StockCatalogEntry[] = [...indexMatches];
  for (const entry of catalog) {
    if (results.length >= limit) break;
    if (
      entry.symbol.toLowerCase().includes(trimmed) ||
      entry.companyName.toLowerCase().includes(trimmed)
    ) {
      results.push(entry);
    }
  }

  return results.slice(0, limit);
}

export async function getRandomUsStock(): Promise<StockCatalogEntry> {
  const catalog = await getUsStockCatalog();
  return catalog[Math.floor(Math.random() * catalog.length)]!;
}
