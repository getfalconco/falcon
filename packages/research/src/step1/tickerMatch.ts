/**
 * Counterparty ticker matching.
 *
 * The matching rules themselves live in `entityResolution.ts`; this file keeps
 * the call surface the pipeline and its tests already use, and adds the SEC
 * fetch. `TICKER_ALIASES` is retained as an alias of the resolver's table so
 * existing importers keep working.
 */

import { loadCompanyTickers } from "./fetchFiling.js";
import {
  COUNTERPARTY_TICKER_ALIASES,
  resolveCounterparty,
  type ResolutionMethod,
  type SecTickerLookup,
} from "./entityResolution.js";

export type { SecTickerLookup } from "./entityResolution.js";

/** @deprecated Use `COUNTERPARTY_TICKER_ALIASES` from `entityResolution.js`. */
export const TICKER_ALIASES = COUNTERPARTY_TICKER_ALIASES;

export type TickerMatchResult = {
  ticker: string | null;
  method: ResolutionMethod | null;
};

/** Pure ticker resolver. See `resolveCounterparty` for the rules and their guards. */
export function matchTicker(name: string, secEntries: SecTickerLookup[]): TickerMatchResult {
  const { ticker, method } = resolveCounterparty(name, secEntries);
  return { ticker, method };
}

export async function matchCounterpartyTicker(counterpartyName: string): Promise<string | null> {
  const entries = await loadCompanyTickers();
  const { ticker, method, rejected } = resolveCounterparty(counterpartyName, entries);
  if (ticker && method) {
    console.info(`[step1] ticker match: ${counterpartyName} -> ${ticker} (${method})`);
  } else if (rejected) {
    // A refusal is a decision, not a gap — log it so the hygiene report can
    // tell "we have never seen this name" from "we refuse to guess at it".
    console.info(`[step1] ticker refused: ${counterpartyName} (${rejected})`);
  }
  return ticker;
}
