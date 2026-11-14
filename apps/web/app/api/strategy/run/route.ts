import { runSpec } from "@falcon/backtest/data";
import { guard, json, preflight, roundDeep } from "@/lib/strategy/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 26;

/**
 * Runs a StrategySpec v2 (packages/backtest: FSL evaluator, engine v2, Tier A
 * quality checks and the evidence label).
 *
 *   POST /api/strategy/run { spec, trials? }
 *     -> 200 RunResultV2 (curves vs SPY and the equal-weight universe, trades, year table, metrics, quality)
 *     -> 400 { errors, issues } invalid spec (zod or FSL type check), 413, 429,
 *        502 data source failed, 503 data source not available at this stage, 504 too slow (cached so far; retry)
 *
 * No AI call. 25 s budget: 20 s to load data (Yahoo in dev/beta behind
 * MARKET_DATA_PROVIDER, FRED DTB3), the rest to run. 10 a minute, 120 an hour per IP.
 */

const TIMEOUT_MS = Number(process.env.STRATEGY_RUN_TIMEOUT_MS) || 20_000;

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request) {
  const g = await guard(
    request,
    "strategy-run",
    [
      ["min", 10, 60_000, true],
      ["hour", 120, 3_600_000, true],
    ],
    64_000,
  );
  if (!g.ok) return g.response;
  const trials = typeof g.body.trials === "number" && Number.isFinite(g.body.trials) ? Math.min(10_000, Math.max(1, Math.round(g.body.trials))) : 1;
  try {
    const out = await runSpec(g.body.spec, { timeoutMs: TIMEOUT_MS, signal: request.signal, trials });
    if (!out.ok) return json({ error: out.errors[0], errors: out.errors, issues: out.issues }, out.status, g.origin);
    return json(roundDeep(out.result), 200, g.origin);
  } catch (error) {
    console.error("[api/strategy/run]", error);
    return json({ error: "The backtest could not run right now." }, 500, g.origin);
  }
}
