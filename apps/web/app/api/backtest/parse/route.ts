import { NextResponse } from "next/server";
import { parseStrategy, MAX_INPUT_CHARS } from "@falcon/backtest/nl";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Plain-English strategy -> explicit rules the user can read and edit, with
 * Claude (claude-sonnet-5-5, structured output). See packages/backtest/src/nl.ts.
 *
 *   POST /api/backtest/parse  { text }
 *     ->  200 { strategy, range, summary, assumptions, unsupported, model }
 *     ->  422 { error, reason, errors?, unsupported? }   not a strategy, or rules that do not validate
 *     ->  413 text too long, 429 rate limited, 503 not configured or unavailable, 504 too slow
 *
 * `summary` is written from the rules, not by the model. Model-written lines
 * (assumptions, unsupported) are filtered for advice-like sentences.
 * Each call costs an API request, so the limits are tighter than /run:
 * 5 a minute and 30 an hour per IP, 300 an hour per server instance.
 */

const TIMEOUT_MS = Number(process.env.BACKTEST_PARSE_TIMEOUT_MS) || 9_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
}

const STATUS = {
  empty: 422,
  too_long: 413,
  not_a_strategy: 422,
  invalid: 422,
  refusal: 422,
  unavailable: 503,
  timeout: 504,
} as const;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  for (const [key, limit, windowMs] of [
    [`backtest-parse:${ip}`, 5, 60_000],
    [`backtest-parse-hour:${ip}`, 30, 3_600_000],
    ["backtest-parse-instance", 300, 3_600_000],
  ] as const) {
    const r = rateLimit(key, { limit, windowMs });
    if (!r.ok) return tooManyRequests(r.retryAfter, CORS);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return json({ error: "Strategy parsing is not configured on this server.", reason: "unavailable" }, 503);

  const raw = await request.text();
  if (raw.length > MAX_INPUT_CHARS * 4 + 200) return json({ error: "Request body is too large.", reason: "too_long" }, 413);
  let text: unknown;
  try {
    text = (JSON.parse(raw) as { text?: unknown })?.text;
  } catch {
    text = undefined;
  }
  if (typeof text !== "string") return json({ error: "Send a JSON object: { text }.", reason: "empty" }, 400);

  try {
    const r = await parseStrategy(text, { apiKey, timeoutMs: TIMEOUT_MS });
    if (!r.ok) {
      return json({ error: r.message, reason: r.reason, errors: r.errors, unsupported: r.unsupported }, STATUS[r.reason]);
    }
    return json({
      strategy: r.strategy,
      range: r.range,
      summary: r.summary,
      assumptions: r.assumptions,
      unsupported: r.unsupported,
      model: r.model,
    });
  } catch (error) {
    console.error("[api/backtest/parse]", error);
    return json({ error: "Strategy parsing is unavailable right now.", reason: "unavailable" }, 503);
  }
}
