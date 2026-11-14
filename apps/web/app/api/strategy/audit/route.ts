import { auditSpec } from "@falcon/backtest/data";
import type { QualityReport } from "@falcon/backtest";
import { guard, json, preflight, roundDeep } from "@/lib/strategy/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 26;

/**
 * Tier B quality checks (design 6.1), requested after the first paint of a
 * run: the null with 200 seeds, the parameter neighbourhood, leave one ticker
 * out (up to 25 tickers) and regimes.
 *
 *   POST /api/strategy/audit { spec, quality? }
 *     -> 200 { tierB: { checks, values }, quality }  (quality = the Tier A report with Tier B merged, when sent)
 *     -> 400 invalid spec, 413, 429, 502, 503, 504
 *
 * No AI call; prices come from the same cache as /run. 5 a minute, 60 an hour per IP.
 */

const TIMEOUT_MS = Number(process.env.STRATEGY_RUN_TIMEOUT_MS) || 20_000;

export function OPTIONS(request: Request) {
  return preflight(request);
}

export async function POST(request: Request) {
  const g = await guard(
    request,
    "strategy-audit",
    [
      ["min", 5, 60_000, true],
      ["hour", 60, 3_600_000, true],
    ],
    200_000,
  );
  if (!g.ok) return g.response;
  const quality = g.body.quality && typeof g.body.quality === "object" ? (g.body.quality as QualityReport) : null;
  const started = Date.now();
  try {
    const out = await auditSpec(g.body.spec, { timeoutMs: TIMEOUT_MS, signal: request.signal, quality, deadlineMs: Math.max(3_000, 22_000 - (Date.now() - started) - 8_000) });
    if (!out.ok) return json({ error: out.errors[0], errors: out.errors, issues: out.issues }, out.status, g.origin);
    return json(roundDeep(out.result), 200, g.origin);
  } catch (error) {
    console.error("[api/strategy/audit]", error);
    return json({ error: "The checks could not run right now." }, 500, g.origin);
  }
}
