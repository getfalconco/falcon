import { yahooOptions } from "./desk/tools/yahoo";
import { liveQuotes } from "./portfolio-prices";
import type { PortfolioAccount, PortfolioPosition } from "./portfolio-holdings";
import { buildTestPortfolio, nearestContract, pickExpiry, planTestPortfolio, type TestContract } from "./workspace/test-portfolio";

/**
 * Development only (read by GET /api/portfolio/holdings under `next dev`,
 * through a dynamic import behind a NODE_ENV check): the random test
 * portfolio for a seed (lib/workspace/test-portfolio.ts), sized from live
 * reference prices (the previous close, so the sizes hold still through the
 * day) and, for the option, a listed contract from Yahoo's chain. Kept in
 * this server's memory per seed, so polls revalue the same positions with
 * fresh prices. Nothing is written anywhere.
 */

const built = new Map<number, { accounts: PortfolioAccount[]; positions: PortfolioPosition[] }>();
const MAX_SEEDS = 8;

async function contractFor(ticker: string, call: boolean, expiryPick: number, ref: number): Promise<TestContract | null> {
  const yahoo = ticker.replace(".", "-");
  try {
    const first = await yahooOptions(yahoo, null, AbortSignal.timeout(6_000));
    const expiry = first ? pickExpiry(first.expirationDates ?? [], Date.now(), expiryPick) : null;
    if (expiry === null) return null;
    const chain = await yahooOptions(yahoo, expiry, AbortSignal.timeout(6_000));
    const leg = chain?.options?.[0];
    const best = nearestContract((call ? leg?.calls : leg?.puts) ?? [], ref);
    if (!best?.contract.contractSymbol || typeof best.contract.strike !== "number") return null;
    return {
      symbol: best.contract.contractSymbol.toUpperCase(),
      ticker,
      call,
      strike: best.contract.strike,
      expiry: new Date((best.contract.expiration ?? expiry) * 1000).toISOString().slice(0, 10),
      price: best.price,
    };
  } catch {
    return null;
  }
}

export async function testPortfolio(seed: number): Promise<{ accounts: PortfolioAccount[]; positions: PortfolioPosition[] }> {
  const hit = built.get(seed);
  if (hit) return hit;
  const plan = planTestPortfolio(seed);
  const symbols = [...plan.stocks.map((s) => s.ticker.replace(".", "-")), ...plan.etfs.map((e) => e.ticker), ...plan.coins.map((c) => `${c.symbol}-USD`)];
  const quotes = await liveQuotes(symbols);
  const refs: Record<string, number> = {};
  for (const [s, q] of Object.entries(quotes)) {
    const prev = q.change !== null ? q.price - q.change : q.price;
    refs[s] = prev > 0 ? prev : q.price;
  }
  const underlying = plan.option ? refs[plan.option.ticker.replace(".", "-")] : undefined;
  const contract = plan.option && underlying ? await contractFor(plan.option.ticker, plan.option.call, plan.option.expiryPick, underlying) : null;
  const out = buildTestPortfolio(plan, refs, contract, new Date().toISOString());
  // Only a complete answer is kept, so a failed quote request is tried again on the next poll.
  if (Object.keys(quotes).length) {
    built.set(seed, out);
    while (built.size > MAX_SEEDS) built.delete(built.keys().next().value!);
  }
  return out;
}
