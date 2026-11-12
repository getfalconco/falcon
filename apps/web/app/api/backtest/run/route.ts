import { NextResponse } from "next/server";
import { DEFAULT_RUN, LIMITS, type BacktestResult } from "@falcon/backtest";
import { backtest } from "@falcon/backtest/data";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Runs a backtest of explicit rules (packages/backtest) on daily Yahoo data.
 *
 *   GET  /api/backtest/run   ->  200 { limits, defaults }
 *   POST /api/backtest/run   { strategy, start?, end?, initialCapital?, commissionBps?, slippageBps? }
 *        ->  200 BacktestResult (equity curve, trades, metrics vs SPY buy-and-hold)
 *        ->  400 invalid rules or window, 413 body too large, 429 rate limited,
 *            502 data source failed, 504 data took too long (cached so far; retry)
 *
 * Limits keep a run inside a serverless function's time budget: at most 25
 * tickers, at most 10 years, a deadline of 8 s (BACKTEST_RUN_TIMEOUT_MS) for
 * loading and running. Prices are cached on disk (the OS temp dir on Netlify,
 * per warm instance) and in memory, so a repeat run takes well under a second.
 * Signals on the close, fills at the next open; see packages/backtest/README.md.
 */

const MAX_BODY_BYTES = 32_000;
const TIMEOUT_MS = Number(process.env.BACKTEST_RUN_TIMEOUT_MS) || 8_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const PUBLIC_LIMITS = {
  maxTickers: LIMITS.maxTickers,
  maxYears: LIMITS.maxYears,
  earliestDate: LIMITS.earliestDate,
  maxConditions: LIMITS.maxConditions,
  maxIndicatorPeriod: LIMITS.maxIndicatorPeriod,
  maxHoldingDays: LIMITS.maxHoldingDays,
  timeoutMs: TIMEOUT_MS,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", ...headers } });
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Same result with money rounded to cents and prices to 4 places: about a third of the bytes. */
function compact(r: BacktestResult): BacktestResult {
  return {
    ...r,
    equity: r.equity.map((p) => ({ date: p.date, strategy: r2(p.strategy), benchmark: r2(p.benchmark), invested: r4(p.invested) })),
    trades: r.trades.map((t) => ({
      ...t,
      entryPrice: r4(t.entryPrice),
      exitPrice: r4(t.exitPrice),
      shares: r4(t.shares),
      cost: r2(t.cost),
      proceeds: r2(t.proceeds),
      pnl: r2(t.pnl),
      returnPct: r4(t.returnPct),
    })),
  };
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET() {
  return json({ limits: PUBLIC_LIMITS, defaults: DEFAULT_RUN });
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  for (const [key, limit, windowMs] of [
    [`backtest-run:${ip}`, 10, 60_000],
    [`backtest-run-hour:${ip}`, 120, 3_600_000],
  ] as const) {
    const r = rateLimit(key, { limit, windowMs });
    if (!r.ok) return tooManyRequests(r.retryAfter, CORS);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request body is too large." }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Send a JSON object: { strategy, start?, end?, initialCapital?, commissionBps?, slippageBps? }." }, 400);
  }

  const config: Record<string, unknown> = {};
  for (const k of ["start", "end", "initialCapital", "commissionBps", "slippageBps"] as const) {
    if (body[k] !== undefined && body[k] !== null) config[k] = body[k];
  }

  try {
    const out = await backtest({ strategy: body.strategy, config }, { timeoutMs: TIMEOUT_MS, signal: request.signal });
    if (!out.ok) return json({ error: out.errors[0], errors: out.errors, limits: PUBLIC_LIMITS }, out.status);
    return json(compact(out.result));
  } catch (error) {
    console.error("[api/backtest/run]", error);
    return json({ error: "The backtest could not run right now." }, 500);
  }
}
