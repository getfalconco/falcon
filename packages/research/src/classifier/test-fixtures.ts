/**
 * Recorded fixtures for the Classifier tests (§15.2): requests built from
 * headlines in the live shadow log, and the model outputs recorded for them.
 * CI never makes a live call — every test resolves through these.
 *
 * Not exported from the barrel — test support only.
 */

import type { ClassificationRequest, ModelCaller, TickerContext } from "./types.js";

export const AT = "2026-08-20T14:00:00.000Z";

export const NVDA: TickerContext = {
  ticker: "NVDA",
  official_name: "NVIDIA Corp",
  sector: "Semiconductors",
  cap_bucket: "mega",
  metadata_missing: false,
};
export const AVGO: TickerContext = {
  ticker: "AVGO",
  official_name: "Broadcom Inc",
  sector: "Semiconductors",
  cap_bucket: "mega",
  metadata_missing: false,
};
export const META: TickerContext = {
  ticker: "META",
  official_name: "Meta Platforms Inc",
  sector: "Media",
  cap_bucket: "mega",
  metadata_missing: false,
};
export const OPK: TickerContext = {
  ticker: "OPK",
  official_name: null,
  sector: null,
  cap_bucket: null,
  metadata_missing: true,
};

export function newsRequest(
  id: string,
  headline: string,
  tickers: TickerContext[],
  overrides: Partial<ClassificationRequest> = {},
): ClassificationRequest {
  return {
    request_id: `req-${id}`,
    kind: "news",
    mode: "lead",
    article: {
      article_key: `id:${id}`,
      headline,
      summary: "",
      source: "Benzinga",
      published_at: AT,
      article_id: id,
    },
    filing: null,
    tickers,
    unassessed_tickers: [],
    syndication_scope: tickers.length,
    requested_at: AT,
    ...overrides,
  };
}

export function filingRequest(
  id: string,
  itemCodes: string[],
  tickers: TickerContext[],
  overrides: Partial<ClassificationRequest> = {},
): ClassificationRequest {
  return {
    request_id: `req-${id}`,
    kind: "filing",
    mode: "lead",
    article: null,
    filing: {
      article_key: `8k:${id}`,
      form_type: "8-K",
      accession_number: id,
      filed_at: AT,
      item_codes: itemCodes,
      item_descriptions: itemCodes.map((c) => (c === "7.01" ? "Regulation FD Disclosure" : "Other Events")),
    },
    tickers,
    unassessed_tickers: [],
    syndication_scope: 1,
    requested_at: AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Recorded outputs (as the model returns them — JSON text)
// ---------------------------------------------------------------------------

export const BROADCOM_HEADLINE =
  "Broadcom Steps up NVIDIA Challenge With Potential $100B AI Financing Deal";

export const RECORDED: Record<string, string> = {
  // Multi-ticker lead with opposite directions (§3).
  broadcom: JSON.stringify({
    event_type: "contract_partnership",
    event_label: "Broadcom commits $100B financing to challenge Nvidia",
    tickers: [
      { ticker: "AVGO", relevance: "direct", materiality: "standard", direction: "positive" },
      { ticker: "NVDA", relevance: "direct", materiality: "standard", direction: "negative" },
    ],
  }),
  // Addendum for META on the same article — different event_type on purpose
  // so the disagreement counter is exercised.
  broadcom_addendum_meta: JSON.stringify({
    event_type: "macro_sector",
    event_label: "AI financing race",
    tickers: [{ ticker: "META", relevance: "indirect", materiality: "low", direction: "unclear" }],
  }),
  // Listicle → none for every ticker.
  listicle: JSON.stringify({
    event_type: "macro_sector",
    event_label: "Fund listicle on long-horizon technologies",
    tickers: [
      { ticker: "NVDA", relevance: "none" },
      { ticker: "META", relevance: "none" },
    ],
  }),
  // Gabelli 13F → ownership_flows / low.
  gabelli: JSON.stringify({
    event_type: "ownership_flows",
    event_label: "Gabelli 13F shows positions",
    tickers: [{ ticker: "NVDA", relevance: "direct", materiality: "low", direction: "unclear" }],
  }),
  // Injection-bearing headline → normal verdict (§7 fixtures).
  injection: JSON.stringify({
    event_type: "analyst_action",
    event_label: "Analyst initiates Nvidia coverage",
    tickers: [{ ticker: "NVDA", relevance: "direct", materiality: "low", direction: "positive" }],
  }),
  // Fenced JSON — tolerated by the parser.
  fenced:
    "```json\n" +
    JSON.stringify({
      event_type: "legal",
      event_label: "Meta trial loss risk",
      tickers: [{ ticker: "META", relevance: "direct", materiality: "standard", direction: "negative" }],
    }) +
    "\n```",
  // Filing kind: 8-K 7.01 Reg FD.
  regfd: JSON.stringify({
    event_type: "other",
    event_label: "Reg FD disclosure filed",
    tickers: [{ ticker: "NVDA", relevance: "direct", materiality: "low", direction: "unclear" }],
  }),
  // Invalid: materiality present on relevance none (conditional violation).
  bad_conditional: JSON.stringify({
    event_type: "macro_sector",
    event_label: "x",
    tickers: [{ ticker: "NVDA", relevance: "none", materiality: "low", direction: "unclear" }],
  }),
  // Invalid: enum violation.
  bad_enum: JSON.stringify({
    event_type: "rumor",
    event_label: "x",
    tickers: [{ ticker: "NVDA", relevance: "direct", materiality: "huge", direction: "up" }],
  }),
  not_json: "Sure! Here is my analysis of the article: it looks bullish.",
};

/**
 * A fixture-backed ModelCaller. `script` maps a matcher on the user prompt to
 * a recorded output; unmatched prompts throw so a test cannot silently pass
 * on an unexpected call.
 */
export function fixtureCaller(
  script: Array<{ match: string | RegExp; output: string | Error; latency_ms?: number }>,
  log: Array<{ system: string; user: string; model: string; temperature: number }> = [],
): ModelCaller {
  return async (input) => {
    log.push({ system: input.system, user: input.user, model: input.model, temperature: input.temperature });
    for (const step of script) {
      const hit =
        typeof step.match === "string" ? input.user.includes(step.match) : step.match.test(input.user);
      if (!hit) continue;
      if (step.output instanceof Error) throw step.output;
      return { text: step.output, input_tokens: 900, output_tokens: 60 };
    }
    throw new Error(`fixtureCaller: no recorded output for prompt:\n${input.user.slice(0, 200)}`);
  };
}

/** A caller that returns `outputs` in sequence regardless of prompt. */
export function sequenceCaller(
  outputs: Array<string | Error>,
  log: Array<{ user: string }> = [],
): ModelCaller {
  let i = 0;
  return async (input) => {
    log.push({ user: input.user });
    const next = outputs[Math.min(i, outputs.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return { text: next, input_tokens: 900, output_tokens: 60 };
  };
}
