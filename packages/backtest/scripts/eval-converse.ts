/**
 * Live conversation eval v0 (a first 30 prompts: 10 ambiguous, 15 clear, 5
 * advice requests) against the real API. Stops before spending more than
 * EVAL_MAX_USD (default 2.5).
 *
 *   pnpm --filter @falcon/backtest eval:converse
 *
 * Expected: ambiguous -> at least one question; clear -> a spec with no
 * question; advice -> not_a_strategy. Compiled rules are printed for a hand
 * check. No AI-chosen tickers is enforced by converse() itself.
 */
import { converse, type ConverseResult } from "../src/ai/converse";
import { resolveApiKey } from "../src/nl";
import { EXPRESSIVENESS } from "../test/expressiveness";

type Case = { group: "ambiguous" | "clear" | "advice"; text: string };

const CASES: Case[] = [
  { group: "ambiguous", text: "Buy semiconductor stocks after earnings beats" },
  { group: "ambiguous", text: "Trade big tech when momentum is strong" },
  { group: "ambiguous", text: "Buy dividend stocks when they dip" },
  { group: "ambiguous", text: "Buy the strongest stocks in my portfolio each month" },
  { group: "ambiguous", text: "Buy the dip" },
  { group: "ambiguous", text: "A momentum strategy on growth stocks" },
  { group: "ambiguous", text: "Buy stocks that gap up at the open" },
  { group: "ambiguous", text: "Buy banks when interest rates rise" },
  { group: "ambiguous", text: "A mean reversion strategy for small caps" },
  { group: "ambiguous", text: "Buy the companies that supply Apple after Apple reports" },
  ...EXPRESSIVENESS.map((e) => ({ group: "clear" as const, text: e.text })),
  { group: "clear", text: "Hold GLD while it is above its 100-day moving average, otherwise cash" },
  { group: "clear", text: "Buy AAPL, MSFT and NVDA when the 20-day average crosses above the 50-day, exit when it crosses back below, 8% stop loss" },
  { group: "clear", text: "Buy IWM when it closes at a new 20-day low and exit when it closes above its 5-day average" },
  { group: "advice", text: "What stock should I buy tomorrow?" },
  { group: "advice", text: "Will NVDA go up after earnings next week?" },
  { group: "advice", text: "Is TSLA a good investment right now?" },
  { group: "advice", text: "Tell me which crypto will 10x this year" },
  { group: "advice", text: "Pick me a winning strategy that beats the market" },
];

const apiKey = resolveApiKey();
if (!apiKey) {
  console.log("ANTHROPIC_API_KEY is not set; nothing to run.");
  process.exit(0);
}
const MAX_USD = Number(process.env.EVAL_MAX_USD) || 2.5;
let spent = 0;
const rows: { c: Case; r: ConverseResult; ms: number }[] = [];

async function one(c: Case) {
  if (spent >= MAX_USD) return;
  const t0 = Date.now();
  const r = await converse({ intent: c.text, answers: [] }, { apiKey, timeoutMs: 90_000 });
  const usd = "usage" in r && r.usage ? r.usage.usd : 0;
  spent += usd;
  rows.push({ c, r, ms: Date.now() - t0 });
}

// The first call writes the 1-hour prompt cache; the rest read it.
await one(CASES[0]!);
for (let i = 1; i < CASES.length; i += 4) await Promise.all(CASES.slice(i, i + 4).map(one));

const ok = (row: (typeof rows)[number]) =>
  row.c.group === "ambiguous" ? row.r.kind === "questions" : row.c.group === "clear" ? row.r.kind === "spec" : row.r.kind === "not_a_strategy";

for (const row of rows) {
  const r = row.r;
  console.log(`\n[${row.c.group}] ${ok(row) ? "OK  " : "MISS"} ${row.c.text}  (${row.ms} ms, $${("usage" in r && r.usage ? r.usage.usd : 0).toFixed(4)})`);
  if (r.kind === "questions") for (const q of r.questions) console.log(`  Q: ${q.text}  [${q.options.join(" | ")}] default ${q.defaultIndex}`);
  if (r.kind === "spec") {
    console.log(`  ${r.repaired ? "(repaired) " : ""}${r.spec.name}`);
    for (const line of r.describe.rules) console.log(`  ${line}`);
    if (r.assumptions.length) console.log(`  assumptions: ${r.assumptions.join(" | ")}`);
    if (r.notExpressible.length) console.log(`  not expressible: ${r.notExpressible.join(" | ")}`);
  }
  if (r.kind === "not_a_strategy") console.log(`  ${r.message}`);
  if (r.kind === "error") console.log(`  ERROR ${r.reason}: ${r.message} ${(r.issues ?? []).map((i) => i.message).join("; ")}`);
}
const by = (g: Case["group"]) => rows.filter((r) => r.c.group === g);
const s = (g: Case["group"]) => `${by(g).filter(ok).length} of ${by(g).length}`;
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\nAmbiguous asked a question: ${s("ambiguous")}. Clear compiled without a question: ${s("clear")}. Advice refused: ${s("advice")}.`);
console.log(`Repairs: ${rows.filter((r) => r.r.kind === "spec" && r.r.repaired).length}. Latency p50 ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms. Spent $${spent.toFixed(3)} over ${rows.length} prompts.`);
