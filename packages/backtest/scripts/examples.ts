/**
 * Three example strategies end to end on real Yahoo data, metrics vs SPY.
 *
 *   pnpm --filter @falcon/backtest examples            # rules written by hand
 *   pnpm --filter @falcon/backtest examples -- --nl    # rules from the English text (needs ANTHROPIC_API_KEY)
 */

import { backtest } from "../src/data/index";
import { TEMPLATES, describeStrategy, type BacktestResult, type Strategy } from "../src/index";
import { parseStrategy, resolveApiKey } from "../src/nl";

const EXAMPLES = TEMPLATES.map((t) => ({ text: t.text, rules: t.rules }));

const pct = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const dd = (v: number) => `-${v.toFixed(1)}%`;
const num = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));

function report(r: BacktestResult, ms: number): void {
  const s = r.metrics.strategy;
  const b = r.metrics.benchmark;
  const rows: [string, string, string][] = [
    ["Total return", pct(s.totalReturnPct), pct(b.totalReturnPct)],
    ["Annualized", pct(s.annualizedReturnPct), pct(b.annualizedReturnPct)],
    ["Sharpe", num(s.sharpe), num(b.sharpe)],
    ["Max drawdown", dd(s.maxDrawdownPct), dd(b.maxDrawdownPct)],
    ["Win rate", s.winRatePct === null ? "n/a" : `${s.winRatePct.toFixed(1)}%`, "-"],
    ["Trades", String(s.tradeCount), "-"],
    ["Exposure", `${s.exposurePct.toFixed(1)}%`, "100%"],
  ];
  console.log(`  ${r.period.start} to ${r.period.end}, ${r.period.sessions} sessions, ${ms} ms`);
  console.log(`  ${"".padEnd(14)}${"Strategy".padStart(10)}${"SPY B&H".padStart(10)}`);
  for (const [k, a, c] of rows) console.log(`  ${k.padEnd(14)}${a.padStart(10)}${c.padStart(10)}`);
  for (const w of r.warnings) console.log(`  note: ${w}`);
}

const useNl = process.argv.includes("--nl");
const key = useNl ? resolveApiKey() : null;
if (useNl && !key) console.log("ANTHROPIC_API_KEY not found: using the hand-written rules.\n");

for (const ex of EXAMPLES) {
  console.log(`\n"${ex.text}"`);
  let rules: Strategy = ex.rules;
  if (key) {
    const parsed = await parseStrategy(ex.text, { apiKey: key });
    if (parsed.ok) {
      rules = parsed.strategy;
      for (const a of parsed.assumptions) console.log(`  assumption: ${a}`);
    } else console.log(`  parse failed (${parsed.reason}): ${parsed.message}; using the hand-written rules`);
  }
  for (const line of describeStrategy(rules)) console.log(`  | ${line}`);
  const t0 = Date.now();
  const out = await backtest({ strategy: rules }, { timeoutMs: 60_000 });
  if (!out.ok) {
    console.log(`  failed (${out.status}): ${out.errors.join("; ")}`);
    continue;
  }
  report(out.result, Date.now() - t0);
}
