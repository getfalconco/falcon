import {
  CLAUDE_FAST_MODEL,
  CLAUDE_WRITING_MODEL,
  acceptsEffort,
  anthropicGlossCaller,
  glossConfigured,
  type GlossModelCaller,
} from "@meridian/research/gloss";
import { mt } from "../i18n";
import type { AgentModelCall, AgentModelCaller } from "./llm";

/**
 * The live model caller for agents: the Claude API.
 *
 * No new client and no key handling here. The call goes through the same
 * Anthropic wrapper the Insight chat and the briefing narrative use
 * (`anthropicGlossCaller` in @meridian/research), which reads the route per
 * call: `ANTHROPIC_API_KEY` from the desktop env in development, sent to
 * https://api.anthropic.com unless `ANTHROPIC_BASE_URL` overrides it, or the
 * research-worker proxy with the reader's session in a packaged build
 * (provider-routing.ts), which forwards to the Claude API with the real key.
 * The key never leaves this process. Structured JSON comes from
 * `output_config.format`, with the schema restated in the prompt for a
 * gateway that ignores it.
 *
 * Model: `FALCON_AGENTS_MODEL`, default the writing tier (`claude-opus-5-5`),
 * the model the Insight chat and the briefing narrative run on. Current
 * models reject sampling parameters, so "low temperature" is expressed as
 * effort "low" (`FALCON_AGENTS_EFFORT`); a model that takes no effort
 * (Haiku 4.5 and older) gets the field left out.
 *
 * Reading a brief into a draft is the one call the reader waits on with
 * nothing else to look at, and the structured output it needs is small, so it
 * runs on the fast tier (`CLAUDE_FAST_MODEL`), overridable with
 * `FALCON_AGENTS_DRAFT_MODEL`. Reports and chat keep the writing tier.
 */

export const AGENTS_MODEL_DEFAULT = CLAUDE_WRITING_MODEL;

export const AGENTS_DRAFT_MODEL_DEFAULT = CLAUDE_FAST_MODEL;

export function agentsModel(): string {
  return process.env.FALCON_AGENTS_MODEL?.trim() || AGENTS_MODEL_DEFAULT;
}

/** The model for one call: the fast tier for drafts, the writing tier for the rest. */
export function agentsModelFor(purpose: AgentModelCall["purpose"]): string {
  if (purpose === "draft") return process.env.FALCON_AGENTS_DRAFT_MODEL?.trim() || AGENTS_DRAFT_MODEL_DEFAULT;
  return agentsModel();
}

function agentsEffort(model: string): "low" | "medium" | "high" | undefined {
  if (!acceptsEffort(model)) return undefined;
  const raw = process.env.FALCON_AGENTS_EFFORT?.trim().toLowerCase();
  return raw === "medium" || raw === "high" ? raw : "low";
}

/** True when a model call is possible right now (a key or a session is in place). */
export function agentsModelConfigured(): boolean {
  return glossConfigured();
}

/** What went wrong on a model call, in the terms the reader is shown. */
export type AgentModelFailure =
  | "credentials"
  | "unavailable"
  | "busy"
  | "service"
  | "rejected"
  | "length"
  | "declined"
  | "timeout"
  | "notConfigured"
  | "network"
  | "malformed"
  | "failed";

type ErrorLike = { status?: unknown; code?: unknown; cause?: unknown; constructor?: { name?: string } };

/** Node / undici codes for a request that never got an answer from anyone. */
const NETWORK_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_\w+|CERT_\w+|UNABLE_TO_\w+)$/;

function networkCode(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 3) return false;
  const e = err as ErrorLike;
  if (typeof e.code === "string" && NETWORK_CODES.test(e.code)) return true;
  return networkCode(e.cause, depth + 1);
}

/**
 * Sorts one failed call. An answer from the service (any HTTP status) is never
 * "could not be reached": a 400 from a gateway that does not know the model,
 * or one that rejects a parameter, used to fall through to that message and
 * send the reader looking at their connection.
 */
export function classifyModelFailure(err: unknown): AgentModelFailure {
  const e = (err && typeof err === "object" ? err : {}) as ErrorLike;
  const status = typeof e.status === "number" ? e.status : null;
  const message = err instanceof Error ? err.message : String(err);
  const kind = e.constructor?.name ?? "";
  if (status === 401 || status === 403) return "credentials";
  if (status === 404) return "unavailable";
  if (status === 408 || /Timeout/.test(kind)) return "timeout";
  if (status === 429) return "busy";
  if (status !== null && status >= 500) return "service";
  if (status !== null && status >= 400) return "rejected";
  if (/ran long/i.test(message)) return "length";
  if (/declined/i.test(message)) return "declined";
  if (/abort|timeout|timed out/i.test(message)) return "timeout";
  if (/not configured/i.test(message)) return "notConfigured";
  if (kind === "APIConnectionError" || /^connection error/i.test(message) || /fetch failed/i.test(message) || networkCode(err)) {
    return "network";
  }
  if (/unexpected shape|not valid json|unexpected token|json at position/i.test(message)) return "malformed";
  return "failed";
}

/** Messages the reader may see, in the reader's language, never the provider's own text. */
export function readableModelError(err: unknown, model: string): Error {
  const failure = classifyModelFailure(err);
  const status = (err as ErrorLike | null)?.status;
  return new Error(mt(`agents.model.${failure}`, { model, status: typeof status === "number" ? status : "" }));
}

/** One line for the main process log: what failed and how, never a key or the prompt. */
function describeFailure(err: unknown): string {
  const e = (err && typeof err === "object" ? err : {}) as ErrorLike & {
    requestID?: unknown;
    error?: { error?: { type?: unknown } };
  };
  const parts = [
    e.constructor?.name ?? typeof err,
    typeof e.status === "number" ? `HTTP ${e.status}` : null,
    typeof e.error?.error?.type === "string" ? e.error.error.type : null,
    typeof e.requestID === "string" ? `request ${e.requestID}` : null,
    err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
  ];
  return parts.filter(Boolean).join(" | ");
}

/** Where model calls go right now (the worker proxy in a packaged build), for the log line. */
function routeHost(): string {
  const base = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  try {
    return new URL(base).host;
  } catch {
    return "an unreadable ANTHROPIC_BASE_URL";
  }
}

/** The agents' caller over a Claude call; the call itself is injectable for tests. */
export function makeAgentCaller(call: GlossModelCaller = anthropicGlossCaller): AgentModelCaller {
  return async (request) => {
    const model = agentsModelFor(request.purpose);
    try {
      const out = await call({
        model,
        max_tokens: request.maxTokens,
        effort: agentsEffort(model),
        system: request.system,
        user: request.user,
        output_schema: request.schema,
        timeout_ms: request.timeoutMs,
      });
      return out.text;
    } catch (err) {
      console.warn(`[agents] ${request.purpose} call to ${model} via ${routeHost()} failed: ${describeFailure(err)}`);
      throw readableModelError(err, model);
    }
  };
}

export const anthropicAgentCaller: AgentModelCaller = makeAgentCaller();
