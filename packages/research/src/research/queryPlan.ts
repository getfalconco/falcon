import type { ResearchTier } from "../config.js";

export type StaticQuery = {
  id: string;
  label: string;
  prompt: (company: string, ticker: string) => string;
  recency?: "month" | "week" | "year";
};

const ALL_STATIC_QUERIES: StaticQuery[] = [
  {
    id: "overview",
    label: "Company overview",
    prompt: (c, t) => `Provide a concise institutional overview of ${c} (${t}): business model, revenue mix, and strategic priorities.`,
    recency: "year",
  },
  {
    id: "supply_chain",
    label: "Supply chain",
    prompt: (c) => `Map key suppliers, manufacturing partners, and supply chain dependencies for ${c}.`,
    recency: "year",
  },
  {
    id: "customers",
    label: "Customers",
    prompt: (c) => `Identify major customers, distribution channels, and customer concentration risks for ${c}.`,
    recency: "year",
  },
  {
    id: "competitors",
    label: "Competitors",
    prompt: (c) => `List primary competitors and competitive dynamics for ${c}.`,
    recency: "year",
  },
  {
    id: "regulatory",
    label: "Regulatory",
    prompt: (c) => `Summarize regulatory exposures, compliance issues, and policy risks for ${c}.`,
    recency: "year",
  },
  {
    id: "recent_news",
    label: "Recent news",
    prompt: (c, t) => `Summarize the most material news and events affecting ${c} (${t}) in the past 90 days.`,
    recency: "month",
  },
  {
    id: "macro_sector",
    label: "Macro & sector",
    prompt: (c) => `Describe macroeconomic and sector trends impacting ${c}.`,
    recency: "month",
  },
  {
    id: "governance_esg",
    label: "Governance & ESG",
    prompt: (c) => `Summarize governance structure and ESG considerations for ${c}.`,
    recency: "year",
  },
  {
    id: "analyst_consensus",
    label: "Analyst consensus",
    prompt: (c, t) => `Summarize analyst consensus, estimates revisions, and key debates on ${c} (${t}).`,
    recency: "month",
  },
  {
    id: "insider_institutional",
    label: "Insider & institutional",
    prompt: (c, t) => `Summarize insider trading and institutional ownership trends for ${c} (${t}).`,
    recency: "month",
  },
  {
    id: "geographic_segments",
    label: "Geographic segments",
    prompt: (c) => `Break down geographic revenue exposure and regional risks for ${c}.`,
    recency: "year",
  },
  {
    id: "capital_allocation",
    label: "Capital allocation",
    prompt: (c) => `Describe capital allocation: R&D, capex, buybacks, dividends, M&A for ${c}.`,
    recency: "year",
  },
];

export function getStaticQueriesForTier(tier: ResearchTier): StaticQuery[] {
  if (tier === "standard") return ALL_STATIC_QUERIES.slice(0, 5);
  if (tier === "deep") return ALL_STATIC_QUERIES.slice(0, 8);
  return ALL_STATIC_QUERIES;
}
