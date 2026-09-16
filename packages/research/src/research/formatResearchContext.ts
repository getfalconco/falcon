import type { EdgarResearch, MarketBundle, QuantContext, WebResearchResult } from "../types.js";
import type { PerformanceHorizons } from "../types.js";

const WEB_BUDGET = 16_000;

export function formatMarketBlock(bundle: MarketBundle | null): string {
  if (!bundle) return "VERIFIED MARKET DATA: unavailable";
  const q = bundle.quote;
  return [
    "VERIFIED MARKET DATA:",
    `Symbol: ${q.symbol}`,
    `Name: ${q.companyName}`,
    q.price != null ? `Price: $${q.price.toFixed(2)}` : null,
    q.changePercent != null ? `Change: ${q.changePercent.toFixed(2)}%` : null,
    q.marketCap != null ? `Market cap: ${q.marketCap}` : null,
    q.peRatio != null ? `P/E: ${q.peRatio}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatEdgarBlock(edgar: EdgarResearch | null): string {
  if (!edgar?.filings.length) return "SEC EDGAR: no filings loaded";
  const lines = edgar.filings.map((f) => `- ${f.type} (${f.filedAt}): ${f.excerpt}`);
  return `SEC EDGAR (${edgar.symbol}, CIK ${edgar.cik}):\n${lines.join("\n")}`;
}

export function formatWebBlock(results: WebResearchResult[]): string {
  let budget = WEB_BUDGET;
  const sections: string[] = ["VERIFIED WEB SOURCES:"];

  for (const r of results) {
    const text = `### ${r.label}\n${r.answer.slice(0, 2200)}`;
    if (text.length > budget) break;
    sections.push(text);
    budget -= text.length;
  }

  return sections.join("\n\n");
}

export function formatQuantBlock(quant: QuantContext | null, horizons: PerformanceHorizons | null): string {
  const lines = ["QUANT CONTEXT:"];
  if (horizons) {
    lines.push(
      `14d: ${horizons.return14d?.toFixed(2) ?? "n/a"}%`,
      `30d: ${horizons.return30d?.toFixed(2) ?? "n/a"}%`,
      `6m: ${horizons.return6m?.toFixed(2) ?? "n/a"}%`,
      `1y: ${horizons.return1y?.toFixed(2) ?? "n/a"}%`,
    );
  }
  if (quant?.fundamentals) {
    for (const [k, v] of Object.entries(quant.fundamentals)) {
      if (v != null) lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

export function buildResearchContext(input: {
  market: MarketBundle | null;
  edgar: EdgarResearch | null;
  web: WebResearchResult[];
  quant: QuantContext | null;
  horizons: PerformanceHorizons | null;
}): string {
  return [
    formatMarketBlock(input.market),
    formatEdgarBlock(input.edgar),
    formatQuantBlock(input.quant, input.horizons),
    formatWebBlock(input.web),
  ].join("\n\n");
}
