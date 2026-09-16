export const PASS0_PROMPT = `Pass 0 — Research Plan

Return JSON:
{
  "researchFocus": ["string — 3-6 focus areas for this company"],
  "dynamicQueries": [
    {
      "id": "unique_id",
      "label": "short label",
      "prompt": "detailed Perplexity search prompt",
      "recency": "month" | "week" | "year"
    }
  ]
}

Generate up to 8 dynamicQueries targeting company-specific risks, catalysts, and relationship gaps not covered by standard queries.`;
