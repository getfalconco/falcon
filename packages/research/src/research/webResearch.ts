import { getConfig } from "../config.js";
import type { Citation, DynamicQuery, WebResearchResult } from "../types.js";
import { perplexityChat } from "./perplexityClient.js";
import { getStaticQueriesForTier, type StaticQuery } from "./queryPlan.js";

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

async function runQuery(
  id: string,
  label: string,
  prompt: string,
  model: string,
  recency?: "month" | "week" | "year",
): Promise<WebResearchResult> {
  const { content, citations } = await perplexityChat({
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 1200,
    searchRecencyFilter: recency,
  });

  return {
    queryId: id,
    label,
    answer: content.slice(0, 2200),
    citations,
  };
}

export async function runWebResearch(
  company: string,
  ticker: string,
  dynamicQueries: DynamicQuery[] = [],
): Promise<{ results: WebResearchResult[]; allCitations: Citation[] }> {
  const config = getConfig();
  const staticQueries = getStaticQueriesForTier(config.researchTier);
  const model = config.perplexityModel;

  const tasks: Array<Promise<WebResearchResult>> = [];

  for (const q of staticQueries) {
    tasks.push(runQuery(q.id, q.label, q.prompt(company, ticker), model, q.recency));
  }

  const dynamicLimit = config.researchTier === "institutional" ? 8 : config.researchTier === "deep" ? 4 : 2;
  for (const dq of dynamicQueries.slice(0, dynamicLimit)) {
    tasks.push(runQuery(dq.id, dq.label, dq.prompt, model, dq.recency));
  }

  const results = await Promise.all(tasks);
  const allCitations = dedupeCitations(results.flatMap((r) => r.citations));

  return { results, allCitations };
}

export type { StaticQuery };
