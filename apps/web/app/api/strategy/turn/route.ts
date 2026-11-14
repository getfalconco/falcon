import { converse, MAX_TEXT_CHARS, type Answer } from "@falcon/backtest/ai";
import type { StrategySpecV2 } from "@falcon/backtest";
import { guard, json, preflight } from "@/lib/strategy/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 26;

/**
 * One Strategy Lab conversation turn (packages/backtest/src/ai/converse.ts).
 *
 *   POST /api/strategy/turn { intent, answers?: [{ q, a, typed }], questionsAsked?, edit?: { request, current } }
 *     -> 200 { kind: "questions", questions, assumptions }
 *     -> 200 { kind: "spec", spec, describe, assumptions, notExpressible, repaired }
 *     -> 200 { kind: "not_a_strategy", message }
 *     -> 422 { kind: "error", reason: "invalid" | "refusal" | "empty", message, issues? }
 *     -> 413 too long, 429 rate limited, 503 not configured or unavailable, 504 too slow
 *
 * Claude Sonnet 5.5 with the FSL reference in a 1-hour cached system prompt;
 * the spec is checked by zod and the FSL type checker, with one automatic
 * repair. Tickers come only from the person's text. Each call costs an API
 * request: 5 a minute and 30 an hour per IP, 300 an hour per instance.
 */

const TIMEOUT_MS = Number(process.env.STRATEGY_TURN_TIMEOUT_MS) || 22_000;
const STATUS = { empty: 422, too_long: 413, invalid: 422, refusal: 422, unavailable: 503, timeout: 504 } as const;

export function OPTIONS(request: Request) {
  return preflight(request);
}

function answers(v: unknown): Answer[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 6)
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
    .map((a) => ({ q: String(a.q ?? "").slice(0, 400), a: String(a.a ?? "").slice(0, 800), typed: a.typed === true }));
}

export async function POST(request: Request) {
  const g = await guard(
    request,
    "strategy-turn",
    [
      ["min", 5, 60_000, true],
      ["hour", 30, 3_600_000, true],
      ["instance", 300, 3_600_000, false],
    ],
    MAX_TEXT_CHARS * 3 + 40_000,
  );
  if (!g.ok) return g.response;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return json({ kind: "error", reason: "unavailable", message: "The strategy assistant is not configured on this server." }, 503, g.origin);
  const b = g.body;
  if (typeof b.intent !== "string") return json({ kind: "error", reason: "empty", message: "Send { intent }." }, 400, g.origin);
  const edit =
    b.edit && typeof b.edit === "object" && typeof (b.edit as { request?: unknown }).request === "string" && (b.edit as { current?: unknown }).current
      ? { request: String((b.edit as { request: string }).request).slice(0, MAX_TEXT_CHARS), current: (b.edit as { current: StrategySpecV2 }).current }
      : null;
  try {
    const r = await converse(
      { intent: b.intent, answers: answers(b.answers), questionsAsked: typeof b.questionsAsked === "number" ? b.questionsAsked : undefined, edit },
      { apiKey, timeoutMs: TIMEOUT_MS },
    );
    console.info("[api/strategy/turn]", JSON.stringify({ kind: r.kind, usage: "usage" in r ? r.usage : null }));
    if (r.kind === "error") return json(r, STATUS[r.reason], g.origin);
    return json(r, 200, g.origin);
  } catch (error) {
    console.error("[api/strategy/turn]", error);
    return json({ kind: "error", reason: "unavailable", message: "The strategy assistant is unavailable right now." }, 503, g.origin);
  }
}
