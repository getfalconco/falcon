/**
 * The source label of a news row, shared by the News view (GET /api/news)
 * and Falcon AI (list_news, get_news_article), so both name a story the same
 * way: the publisher and the date for an article ("Yahoo, Nov 20, 2026";
 * Finnhub is only the pipe), "SEC EDGAR, <form>, <filed date>" for a filing.
 * Dates are New York dates. Pure; safe in client components.
 */

const nyDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });

export function newsSourceLabel(row: { kind?: string; source: string; form?: string; publishedAt: string }): string {
  const t = Date.parse(row.publishedAt);
  const date = Number.isNaN(t) ? "" : nyDate.format(t);
  const parts = row.kind === "filing" ? ["SEC EDGAR", row.form || "filing", date] : [row.source.trim() || "Unknown publisher", date];
  return parts.filter(Boolean).join(", ");
}
