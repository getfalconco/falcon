/**
 * Options / flow data CLI (all pulls through the guarded client).
 *
 *   node --import tsx src/options/cli.ts spend
 *   node --import tsx src/options/cli.ts features --ticker KLAC --date 2026-11-13 [--dry-run] [--no-oi] [--no-volume]
 *          [--caller NAME] [--max-call 0.5] [--max-caller 5] [--model bs2002|crr|european] [--json]
 *   node --import tsx src/options/cli.ts flow --ticker KLAC --date 2026-11-13 [--dataset XNAS.ITCH] [--dry-run]
 *
 * `features` prints the surface features of one underlying-day; `--dry-run`
 * only prices the pulls (cached parts cost nothing and are used).
 */

import { DatabentoClient, fetchOptionDay, fetchStockDaily, fetchStockSpot, fetchStockTrades, type PullOptions } from "./client.ts";
import { aggregateFlow } from "./flow.ts";
import { dividendYieldOn, fetchDividends, fetchDtb3, rateOn } from "./rates.ts";
import { surfaceFeatures, type IvModel } from "./surface.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function nextDay(d: string): string {
  return new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const client = new DatabentoClient();
  const pull: PullOptions = {
    caller: arg("caller") ?? "options-cli",
    maxCallUsd: Number(arg("max-call") ?? 0.5),
    maxCallerUsd: arg("max-caller") ? Number(arg("max-caller")) : undefined,
    dryRun: flag("dry-run"),
  };
  if (cmd === "spend") {
    const entries = client.guard.entries();
    const by = new Map<string, number>();
    for (const e of entries) by.set(e.caller, (by.get(e.caller) ?? 0) + e.costUsd);
    console.log(`total $${client.guard.spentUsd().toFixed(4)} of $${client.guard.totalBudgetUsd} (${entries.length} lines)`);
    for (const [c, v] of by) console.log(`  ${c}: $${v.toFixed(4)}`);
    return;
  }
  const ticker = arg("ticker");
  const date = arg("date");
  if (!ticker || !date) throw new Error("--ticker and --date are required");
  if (cmd === "features") {
    const day = await fetchOptionDay(client, {
      parents: [`${ticker}.OPT`],
      date,
      openInterest: !flag("no-oi"),
      volume: !flag("no-volume"),
      pull,
    });
    const daily = await fetchStockDaily(client, { symbols: [ticker], start: date, end: nextDay(date), pull });
    const spotMap = await fetchStockSpot(client, { symbols: [ticker], date, pull });
    for (const p of day.pulls) console.log(`${p.dataset} ${p.schema}: ${p.records} records, priced $${p.pricedUsd.toFixed(4)}, charged $${p.costUsd.toFixed(4)}${p.cached ? " (cached)" : ""}${p.dryRun ? " (dry run)" : ""}`);
    if (pull.dryRun && !day.definitions.length) return;
    const spot = spotMap.get(ticker) ?? daily.get(ticker)?.get(date)?.close;
    if (!spot) throw new Error("no spot");
    const rate = rateOn(await fetchDtb3(), date) ?? 0.04;
    const q = dividendYieldOn(await fetchDividends(ticker), date) ?? 0;
    const f = surfaceFeatures({
      underlying: ticker,
      date,
      asOfMs: day.asOfMs,
      spot,
      rate,
      divYield: q,
      definitions: day.definitions.filter((d) => d.underlying === ticker),
      quotes: day.quotes,
      openInterest: day.openInterest ?? undefined,
      volume: day.volume ?? undefined,
      stockVolume: daily.get(ticker)?.get(date)?.volume,
      options: { ivModel: (arg("model") as IvModel | undefined) ?? "bs2002" },
    });
    const { contracts, ...rest } = f;
    if (flag("json")) console.log(JSON.stringify(rest, null, 1));
    else {
      const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
      console.log(`${ticker} ${date} spot ${spot} r ${pct(rate)} q ${pct(q)} contracts ${contracts.length}`);
      console.log(`ATM IV 30/60/90: ${pct(f.atmIv30)} / ${pct(f.atmIv60)} / ${pct(f.atmIv90)}  slope ${pct(f.termSlope)}`);
      console.log(`skew (XZZ, ~30d): ${pct(f.skew)}  mean ${pct(f.skewMean)}  call-put spread (CW): ${pct(f.callPutSpread)} over ${f.callPutPairs} pairs`);
      console.log(`option volume ${f.optionVolume}  stock volume ${f.stockVolume}  O/S ${f.oToS?.toFixed(4)}`);
      console.log(`GEX $${f.gex?.toExponential(3)} per 1% (calls ${f.gexCalls?.toExponential(3)}, puts ${f.gexPuts?.toExponential(3)})`);
      for (const m of f.impliedMoves) console.log(`implied move to ${m.expiration} (${m.days.toFixed(1)}d): straddle ${pct(m.straddlePct)}, IV abs ${pct(m.ivAbsPct)}, IV sd ${pct(m.ivSdPct)}`);
      console.log(`quality ${JSON.stringify(f.quality)}  parity spot ${f.parityImpliedSpot?.toFixed(2)}`);
    }
    console.log(`ledger total $${client.guard.spentUsd().toFixed(4)}`);
    return;
  }
  if (cmd === "flow") {
    const trades = await fetchStockTrades(client, { symbols: [ticker], date, dataset: arg("dataset"), pull });
    for (const d of aggregateFlow(trades.get(ticker) ?? [])) console.log(JSON.stringify(d));
    for (const d of aggregateFlow(trades.get(ticker) ?? [], { classify: "tick" })) console.log("tick", JSON.stringify(d));
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
