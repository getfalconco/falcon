/**
 * Runs the 12 audit strategies (test/expressiveness.ts) on real data through
 * the v2 pipeline: Yahoo prices (beta source), FRED DTB3, Tier A checks.
 *
 *   pnpm --filter @falcon/backtest exec tsx scripts/expressiveness.ts
 */
import { runSpec } from "../src/data/run-spec";
import { EXPRESSIVENESS } from "../test/expressiveness";

const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${v.toFixed(1)}%`);
let pass = 0;
for (const e of EXPRESSIVENESS) {
  const t0 = Date.now();
  const out = await runSpec(e.spec, { timeoutMs: 60_000 });
  const ms = Date.now() - t0;
  if (!out.ok) {
    console.log(`FAIL ${e.id}: ${out.errors.join("; ")}`);
    continue;
  }
  const r = out.result;
  const ok = r.trades.length > 0 && r.quality.checks.every((c) => c.status !== "gate");
  if (ok) pass++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${e.id.padEnd(15)} ${r.period.start}..${r.period.end} trades ${String(r.trades.length).padStart(4)}  CAGR ${pct(r.metrics.strategy.annualizedReturnPct)} vs SPY ${pct(r.metrics.benchmark.annualizedReturnPct)}  maxDD ${pct(-r.metrics.strategy.maxDrawdownPct)}  evidence: ${r.quality.label.title}  flags: ${r.quality.flags.map((f) => f.check_id).join(",") || "-"}  ${ms} ms`,
  );
}
console.log(`\n${pass} of ${EXPRESSIVENESS.length} ran on real data with trades and no gate.`);
