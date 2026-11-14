/**
 * Builds the graph's filer universe (src/graph/universe.ts): US-listed
 * operating companies passing the liquidity gate, top N by 20-day median
 * dollar volume. Writes .cache/graph-universe/universe-<date>.json, which
 * scripts/graph-extract.ts reads with --universe. The file holds price-derived
 * numbers (Yahoo), so it stays out of the repository.
 *
 *   pnpm --filter @falcon/engine run graph-universe -- --n 1500
 *
 * Flags:
 *   --n N            members to keep (default 1500)
 *   --min-float USD  10-K filers with a smaller public float are not priced (default 300000000)
 *   --concurrency N  price reads at once (default 8)
 *
 * Refresh: monthly is enough (floats change once a year per filer, the
 * ranking slowly); the extraction itself only needs a new run when a
 * member files a new annual report.
 */

import fs from "node:fs";
import path from "node:path";
import { filerMeta, isListed, loadListings } from "../src/feed/companies.ts";
import { ENGINE_ROOT, HOUR_MS, secGet } from "../src/http.ts";
import { backtestMarketData } from "../src/market.ts";
import { liquidityOf } from "../src/quality.ts";
import { floatFrames, latestFloats, rankUniverse, type Candidate, type FrameRow } from "../src/graph/universe.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const n = Number(arg("n") ?? 1500);
const minFloat = Number(arg("min-float") ?? 300_000_000);
const concurrency = Number(arg("concurrency") ?? 8);
const t0 = Date.now();
const log = (l: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${l}`);

/** Funds, trusts and other non-operating listings, by name: never priced. */
const FUND = /\b(ETF|ETN|Fund|Funds|Trust|iShares|ProShares|Direxion|SPDR|Invesco|Vanguard|Portfolio|Index|Notes due|Acquisition Corp|Acquisition Co)\b/i;

const today = new Date().toISOString().slice(0, 10);
const listings = await loadListings();
const listed = [...listings.byCik.values()].filter((l) => isListed(l));
log(`${listed.length} CIKs with a Nasdaq / NYSE / Cboe listing`);

const frames: FrameRow[][] = [];
for (const f of floatFrames(today)) {
  try {
    const body = await secGet(`https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/${f}.json`, { maxAgeMs: 24 * HOUR_MS, staleOk: true });
    frames.push((JSON.parse(body) as { data: FrameRow[] }).data);
  } catch (err) {
    log(`frame ${f}: ${(err as Error).message.split("\n")[0]}`);
  }
}
const floats = latestFloats(frames);
log(`public float known for ${floats.size} filers (frames ${floatFrames(today).join(", ")})`);

const candidates: Candidate[] = [];
let small = 0;
let funds = 0;
for (const l of listed) {
  const fl = floats.get(l.cik);
  if (fl && fl.floatUsd < minFloat) {
    small++;
    continue;
  }
  if (!fl && FUND.test(l.name)) {
    funds++;
    continue;
  }
  candidates.push({ ticker: l.ticker, cik: l.cik, name: l.name, exchange: l.exchange, floatUsd: fl?.floatUsd ?? null, liquidity: null, annualForm: fl ? "10-K" : undefined });
}
log(`${candidates.length} candidates to price (${small} with float under $${minFloat / 1e6}M and ${funds} fund-like names skipped)`);

const market = await backtestMarketData();
if ("error" in market) throw new Error(market.error);
const from = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
let done = 0;
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < candidates.length) {
      const c = candidates[next++]!;
      try {
        c.liquidity = liquidityOf(await market.market.dailyCloses(c.ticker, from, today));
      } catch {
        c.liquidity = null;
      }
      if (++done % 500 === 0) log(`priced ${done}/${candidates.length}`);
    }
  }),
);

// No float: confirm an annual report (10-K, 20-F, 40-F) for those that pass the gate and could rank.
const pre = rankUniverse(
  candidates.map((c) => ({ ...c, annualForm: c.annualForm ?? "?" })),
  Math.round(n * 1.3),
);
const toCheck = candidates.filter((c) => c.annualForm === undefined && pre.some((m) => m.cik === c.cik));
for (const c of toCheck) {
  const meta = await filerMeta(c.cik).catch(() => null);
  c.annualForm = meta?.recent.find((r) => /^(10-K|20-F|40-F)$/.test(r.form))?.form ?? null;
}
log(`checked ${toCheck.length} filers without a float: ${toCheck.filter((c) => c.annualForm).length} file annual reports (${toCheck.filter((c) => c.annualForm && c.annualForm !== "10-K").length} 20-F / 40-F)`);

const members = rankUniverse(candidates, n);
const passing = rankUniverse(candidates, Number.MAX_SAFE_INTEGER).length;
const dir = path.join(ENGINE_ROOT, ".cache", "graph-universe");
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `universe-${today}.json`);
fs.writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), n, minFloat, passing, members }, null, 1)}\n`);
const forms: Record<string, number> = {};
for (const m of members) forms[m.annualForm ?? "?"] = (forms[m.annualForm ?? "?"] ?? 0) + 1;
const last = members.at(-1);
log(`${passing} pass the liquidity gate; kept ${members.length} -> ${out}`);
log(`  forms ${JSON.stringify(forms)}; the ${members.length}th has median dollar volume $${((last?.medianDollarVolume20d ?? 0) / 1e6).toFixed(1)}M`);
