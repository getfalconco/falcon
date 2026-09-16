import { useEffect, useState } from "react";
import { getLiveQuote } from "@/lib/stock-api";

/**
 * Which trading session the clock is in, read off a liquid benchmark so it
 * costs one quote regardless of how many positions are held. Drives the
 * badge that tells the user which print their book is being valued at —
 * outside 09:30–16:00 that is an extended-hours price, not the close.
 */

export type MarketSession = "pre" | "regular" | "post" | "closed";

const SESSION_LABEL: Record<MarketSession, string> = {
  pre: "Pre-Market",
  regular: "Market Open",
  post: "After Hours",
  closed: "Market Closed",
};

export function marketSessionLabel(session: MarketSession | null): string | null {
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
