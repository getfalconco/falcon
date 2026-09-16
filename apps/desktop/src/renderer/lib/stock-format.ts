const PRICE_FORMAT = {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
} as const;

export function formatStockPrice(value: number): string {
  return new Intl.NumberFormat("en-US", PRICE_FORMAT).format(value);
}

export function formatSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${new Intl.NumberFormat("en-US", {
    ...PRICE_FORMAT,
    signDisplay: "never",
  }).format(Math.abs(value))}`;
}

export function formatSignedPercent(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}
