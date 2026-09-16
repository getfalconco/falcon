export type StockCatalogEntry = {
  symbol: string;
  companyName: string;
  exchange?: string;
};

/** Public logo CDN — falls back to initials in UI when image fails. */
export function getStockLogoUrl(symbol: string): string {
  return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol.toUpperCase())}.png`;
}
