/**
 * "Open this stock" — the one way a card buried in the dashboard grid can ask
 * the page that owns the view state to switch to a ticker, the same door the
 * search bar goes through. HomePage listens; anything may dispatch.
 */
export const STOCK_OPEN_EVENT = "falcon:stock-open";

export type StockOpenDetail = { ticker: string; companyName?: string };

export function openStock(ticker: string, companyName?: string): void {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return;
  window.dispatchEvent(
    new CustomEvent<StockOpenDetail>(STOCK_OPEN_EVENT, { detail: { ticker: symbol, companyName } }),
  );
}
