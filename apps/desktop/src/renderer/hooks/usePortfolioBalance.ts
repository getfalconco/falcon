import { useEffect, useState } from "react";
import {
  readPaperAccount,
  subscribePaperAccount,
  type PaperAccount,
} from "@/lib/paper-account";
import { useLivePrices } from "@/hooks/useLivePrices";

/**
 * Live portfolio value: cash + live-priced paper positions + connected
 * brokerage total. Prices come from the shared source so the headline can
 * never disagree with the holdings card.
 *
 * `priced` says whether every input actually arrived. Until a symbol's quote
 * lands its position is carried at cost, so the total is a real number made
 * of unreal parts — with two 5000-dollar positions it lands on exactly
 * 10000.00, and a half-priced book lands somewhere arbitrary. That is fine
 * for a headline that is about to re-render, and wrong to write into a
 * permanent series: recorded once, a placeholder is indistinguishable from a
 * real move forever after. Anything persisting this value must check it.
 */
export function usePortfolioValuation(): { value: number; priced: boolean } {
  const [account, setAccount] = useState<PaperAccount>(readPaperAccount);
  const [brokerageTotal, setBrokerageTotal] = useState(0);
  const [brokerageSettled, setBrokerageSettled] = useState(false);

  useEffect(() => subscribePaperAccount(() => setAccount(readPaperAccount())), []);

  const prices = useLivePrices(Object.keys(account.positions).sort().join(","));

  useEffect(() => {
    let cancelled = false;
    // Settled, not succeeded: with no brokerage linked this call fails or
    // returns nothing, and treating that as 'never ready' would stop the
    // recorder writing anything at all.
    const done = () => {
      if (!cancelled) setBrokerageSettled(true);
    };
    void window.meridian
      ?.getBrokerageNetWorth?.()
      .then((res) => {
        if (!cancelled && res?.ok) setBrokerageTotal(res.networth.total);
        done();
      })
      .catch(done);
    if (!window.meridian?.getBrokerageNetWorth) done();
    return () => {
      cancelled = true;
    };
  }, []);

  const positions = Object.values(account.positions);
  const positionsValue = positions.reduce(
    (sum, p) =>
      sum + (prices[p.symbol] != null ? p.shares * prices[p.symbol] : p.costUsd),
    0,
  );
  const priced = brokerageSettled && positions.every((p) => prices[p.symbol] != null);
  return { value: account.cash + positionsValue + brokerageTotal, priced };
}

/** The value alone — for everything that only ever displays it. */
export function usePortfolioBalance(): number {
  return usePortfolioValuation().value;
}
