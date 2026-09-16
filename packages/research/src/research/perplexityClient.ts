import { getConfig } from "../config.js";
import type { Citation } from "../types.js";

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

export type PerplexityHealth = {
  ok: boolean;
  configured: boolean;
  model?: string;
  keyPrefix?: string;
  error?: string;
};

export async function checkPerplexityHealth(): Promise<PerplexityHealth> {
  const config = getConfig();
  if (!config.perplexityApiKey) {
    return { ok: false, configured: false, error: "PERPLEXITY_API_KEY missing" };
  }

  const keyPrefix = config.perplexityApiKey.slice(0, 8);

  try {
    await perplexityChat({
      model: config.perplexityModel,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 16,
    });
    return {
      ok: true,
      configured: true,
      model: config.perplexityModel,
      keyPrefix,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, configured: true, model: config.perplexityModel, keyPrefix, error: message };
  }
}

type PerplexityMessage = { role: "system" | "user" | "assistant"; content: string };

type PerplexityOptions = {
  model: string;
  messages: PerplexityMessage[];
  maxTokens?: number;
  searchRecencyFilter?: "month" | "week" | "year";
  searchContextSize?: "low" | "medium" | "high";
  reasoningEffort?: "low" | "medium" | "high";
  /** Log full request body + raw API response (signal research diagnostics). */
  diagnostic?: boolean;
};

type PerplexitySearchResult = {
  title?: string;
  url?: string;
};

type PerplexityResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: PerplexitySearchResult[];
};

function extractCitations(data: PerplexityResponse): Citation[] {
  const byUrl = new Map<string, Citation>();

  for (const result of data.search_results ?? []) {
    const url = result.url?.trim();
    if (!url) continue;
    byUrl.set(url, { url, title: result.title?.trim() || undefined });
  }

  for (const url of data.citations ?? []) {
    const trimmed = url.trim();
    if (!trimmed || byUrl.has(trimmed)) continue;
    byUrl.set(trimmed, { url: trimmed });
  }

  return [...byUrl.values()];
}

export async function perplexityChat(
  options: PerplexityOptions,
): Promise<{ content: string; citations: Citation[] }> {
  const config = getConfig();
  if (!config.perplexityApiKey) {
    throw new Error("PERPLEXITY_API_KEY is not configured");
  }

  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    max_tokens: options.maxTokens ?? 1200,
    return_citations: true,
  };

  if (options.searchRecencyFilter) {
    body.search_recency_filter = options.searchRecencyFilter;
  }

  if (options.searchContextSize || options.reasoningEffort) {
    const supportsReasoning =
      options.model.includes("reasoning") || options.model.includes("deep");
    body.web_search_options = {
      ...(options.searchContextSize
        ? { search_context_size: options.searchContextSize }
        : {}),
      ...(options.reasoningEffort && supportsReasoning
        ? { reasoning_effort: options.reasoningEffort }
        : {}),
    };
  }

  if (options.diagnostic) {
    console.info("[daily-signal] perplexity DIAGNOSTIC — request", {
      url: PERPLEXITY_URL,
      model: options.model,
      max_tokens: body.max_tokens,
      return_citations: body.return_citations,
      search_recency_filter: body.search_recency_filter ?? "(not set)",
      web_search_options: body.web_search_options ?? "(not set)",
      messageCount: options.messages.length,
      systemPromptChars: options.messages.find((m) => m.role === "system")?.content.length ?? 0,
      userPromptChars: options.messages.find((m) => m.role === "user")?.content.length ?? 0,
    });
    console.info("[daily-signal] perplexity DIAGNOSTIC — full messages JSON:\n" + JSON.stringify(options.messages, null, 2));
    console.info("[daily-signal] perplexity DIAGNOSTIC — request body JSON:\n" + JSON.stringify(body, null, 2));
  }

  const res = await fetch(PERPLEXITY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.perplexityApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Perplexity ${res.status}: ${rawText.slice(0, 200)}`);
  }

  let data: PerplexityResponse & Record<string, unknown>;
  try {
    data = JSON.parse(rawText) as PerplexityResponse & Record<string, unknown>;
  } catch {
    throw new Error(`Perplexity response not JSON: ${rawText.slice(0, 200)}`);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  const citations = extractCitations(data);

  if (options.diagnostic) {
    const topLevelKeys = Object.keys(data);
    const choice = data.choices?.[0];
    const messageKeys = choice?.message
      ? Object.keys(choice.message as object)
      : [];
    console.info("[daily-signal] perplexity DIAGNOSTIC — response status:", res.status);
    console.info("[daily-signal] perplexity DIAGNOSTIC — top-level JSON keys:", topLevelKeys);
    console.info("[daily-signal] perplexity DIAGNOSTIC — choice[0] keys:", choice ? Object.keys(choice) : []);
    console.info("[daily-signal] perplexity DIAGNOSTIC — message keys:", messageKeys);
    console.info("[daily-signal] perplexity DIAGNOSTIC — parsed citation fields:", {
      citationsArray: data.citations ?? null,
      searchResults: data.search_results ?? null,
      extractedCitationCount: citations.length,
    });
    // Full raw response (content truncated for readability)
    const logPayload = { ...data };
    if (typeof logPayload.choices?.[0]?.message?.content === "string") {
      const full = logPayload.choices[0].message!.content!;
      logPayload.choices = [{
        ...logPayload.choices[0],
        message: {
          ...logPayload.choices[0].message,
          content: full.length > 500 ? full.slice(0, 500) + `… (${full.length} chars total)` : full,
        },
      }];
    }
    console.info("[daily-signal] perplexity DIAGNOSTIC — raw response JSON:\n" + JSON.stringify(logPayload, null, 2));
  }

  if (options.messages.some((m) => m.content.includes("Signal date:")) && !options.diagnostic) {
    console.info("[daily-signal] perplexity response citation fields:", {
      model: options.model,
      citationsFieldCount: data.citations?.length ?? 0,
      citationsField: data.citations?.slice(0, 10) ?? [],
      searchResultsCount: data.search_results?.length ?? 0,
      searchResultUrls: (data.search_results ?? []).map((r) => r.url).filter(Boolean).slice(0, 10),
      extractedCount: citations.length,
    });
  }

  return { content, citations };
}
