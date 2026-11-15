import { review } from "@falcon/backtest/ai";
import { describeSpec, validateSpec, type QualityReport } from "@falcon/backtest";
import { guard, json, preflight } from "@/lib/strategy/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Netlify's synchronous function limit (60 s, fixed; docs.netlify.com/build/functions/configuration). */
export const maxDuration = 60;

/**
 * "Explain" (design 6.4): Claude describes a run's QualityReport in slot
 * templates; the server fills every number and neutralizes the text.
 *
 *   POST /api/strategy/review { spec, quality, trials? }
 *     -> 200 { headline, flags, interpretationRisks, nextExperiments, model }
 *     -> 400 invalid spec or report, 401 not signed in, 413, 422 no valid description, 429, 503, 504
 *
 * Input to the model: the intent, describe(spec) and the report's checks and
 * values; no prices, no news. Members only (lib/strategy/guard.ts). 3 a minute,
 * 20 an hour per IP and per member, 100 an hour per instance.
 */

/**
 * The whole request, sign-in check included, ends within 50 s of arriving:
 * 10 s under the 60 s limit for a cold start and the response. The model gets
 * whatever the sign-in check left (about 49 s), including the one retry.
 */
const DEADLINE_MS = 50_000;
const STATUS = { invalid: 422, refusal: 422, unavailable: 503, timeout: 504 } as const;

export function OPTIONS(request: Request) {
  return preflight(request);
}

function isReport(v: unknown): v is QualityReport {
  const q = v as QualityReport | null;
  return Boolean(q && typeof q === "object" && Array.isArray(q.checks) && q.values && typeof q.values === "object" && q.label);
}

export async function POST(request: Request) {
  const arrived = Date.now();
  const g = await guard(
    request,
    "strategy-review",
    [
      ["min", 3, 60_000, true],
      ["hour", 20, 3_600_000, true],
      ["instance", 100, 3_600_000, false],
    ],
    120_000,
  );
  if (!g.ok) return g.response;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return json({ error: "Explain is not configured on this server." }, 503, g.origin);
  const check = validateSpec(g.body.spec);
  if (!check.ok) return json({ error: "The spec is not valid.", issues: check.issues }, 400, g.origin);
  if (!isReport(g.body.quality)) return json({ error: "Send the run's quality report." }, 400, g.origin);
  const trials = typeof g.body.trials === "number" ? Math.max(1, Math.round(g.body.trials)) : 1;
  const guardMs = Date.now() - arrived;
  try {
    const r = await review({ spec: check.spec, describe: describeSpec(check.spec, check.uses), report: g.body.quality, trials }, { apiKey, timeoutMs: DEADLINE_MS - guardMs });
    console.info(
      "[api/strategy/review]",
      JSON.stringify({ ok: r.ok, reason: r.ok ? undefined : r.reason, repaired: r.ok ? r.review.repaired : undefined, guardMs, totalMs: Date.now() - arrived, usage: r.ok ? r.review.usage : (r.usage ?? null) }),
    );
    if (!r.ok) return json({ error: r.message, reason: r.reason }, STATUS[r.reason], g.origin);
    return json(r.review, 200, g.origin);
  } catch (error) {
    console.error("[api/strategy/review]", error);
    return json({ error: "Explain is unavailable right now." }, 503, g.origin);
  }
}
