import { useEffect, useState } from "react";
import { getLiveQuote } from "@/lib/stock-api";
import type { MessageKey } from "@/lib/i18n";

/**
 * Which trading session the clock is in, read off a liquid benchmark so it
 * costs one quote regardless of how many positions are held. Drives the
 * badge that tells the user which print their book is being valued at —
 * outside 09:30–16:00 that is an extended-hours price, not the close.
 */

export type MarketSession = "pre" | "regular" | "post" | "closed";

const SESSION_LABEL: Record<MarketSession, MessageKey> = {
  pre: "market.session.pre",
  regular: "market.session.regular",
  post: "market.session.post",
  closed: "market.session.closed",
};

/**
 * The session's words, as a key for `t()`. One set (`market.session.*`) for
 * every place a price says which session it is from: the dashboard headline's
 * badge, the stock page's live price and the peek.
 */
export function marketSessionLabel(session: MarketSession): MessageKey;
export function marketSessionLabel(session: MarketSession | null): MessageKey | null;
export function marketSessionLabel(session: MarketSession | null): MessageKey | null {
  return session ? SESSION_LABEL[session] : null;
}

export function useMarketSession(): MarketSession | null {
  const [session, setSession] = useState<MarketSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void getLiveQuote("SPY")
        .then((res) => {
          if (!cancelled && res.ok) setSession(res.quote.session);
        })
        .catch(() => {
          /* badge just stays hidden */
        });
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return session;
}
