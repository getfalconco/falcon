/**
 * The real caller: one Anthropic Messages call, structured JSON out, effort
 * turned down so the reader's spinner is short. Never imported by tests —
 * they inject a fixture caller.
 */

import Anthropic from "@anthropic-ai/sdk";
import { providerRouteFor } from "../providerRoute.js";
import { jsonFromModelText, withJsonInstruction } from "../model-json.js";
import type { GlossModelCaller } from "./types.js";

let client: Anthropic | null = null;
let clientKey: string | null = null;

function getClient(): Anthropic {
  // Re-create when the key changes: a packaged desktop build routes through the
  // research-worker proxy with the user's rotating Supabase JWT as the key.
  const route = providerRouteFor("insight");
  const currentKey = route.apiKey;
  if (client && clientKey === currentKey) return client;
  const apiKey = route.apiKey;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  client = new Anthropic({ apiKey, maxRetries: 1, ...(route.baseUrl ? { baseURL: route.baseUrl } : {}) });
  clientKey = apiKey;
  return client;
}

export const anthropicGlossCaller: GlossModelCaller = async (input) => {
  const response = await getClient().messages.create(
    {
      model: input.model,
      max_tokens: input.max_tokens,
      // No `temperature`: the current models reject sampling params outright.
      //
      // The schema goes in twice, on purpose. `output_config` is the real
      // guarantee, but a gateway that does not implement it answers 200 and
      // ignores it, and the reply comes back as prose. Restating the shape in
      // the prompt costs a few tokens and is what keeps that case working.
      system: withJsonInstruction(input.system, input.output_schema),
      messages: [{ role: "user", content: input.user }],
      output_config: {
        // Omitted rather than null for models that reject the field.
        ...(input.effort ? { effort: input.effort } : {}),
        format: { type: "json_schema", schema: input.output_schema },
      },
    },
    { timeout: input.timeout_ms, signal: input.signal },
  );

  if (response.stop_reason === "refusal") {
    throw new Error("the model declined to explain this selection");
  }
  if (response.stop_reason === "max_tokens") {
    // The ceiling covers reasoning as well as the answer, so a long think can
    // cut the JSON in half. Say that, rather than "malformed JSON".
    throw new Error("the explanation ran long — try a shorter selection");
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return {
    // Clean JSON passes through untouched; a preamble, a fence or a leaked
    // reasoning block is peeled off. Prose with no JSON in it stays prose, so
    // the caller's own parse error still fires.
    text: jsonFromModelText(text),
    input_tokens:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    output_tokens: response.usage.output_tokens,
  };
};

/** True when a live call is possible in this process. */
export function glossConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
