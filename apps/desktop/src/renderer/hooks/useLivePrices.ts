import { useEffect, useMemo, useState } from "react";
import { getLiveQuote, getStockQuote } from "@/lib/stock-api";
import { useHomeTabActivity } from "@/lib/home-tab-activity";

/**
 * One price source for every surface that values the book.
 *
 * Extended-hours aware: outside 09:30–16:00 the last pre/post print is what a
 * position is actually worth, and it is what trades execute at. Anything that
 * prices the same holdings off a different quote invents P&L — a headline and
 * a holdings card disagreeing by the close-to-after-hours gap looks exactly
 * like a broken feed. Fetch here, once, and share it.
 *
 * Polled every 5s so the portfolio value and its chart actually move while the
 * app is open. That is one upstream request per held symbol per tick — the
 * main-process quote cache (1.5s TTL + inflight dedupe) collapses the several
 * surfaces asking for the same symbol, but a large book still means real
 * traffic; a 429 leaves the last good price on screen rather than clearing it.
 *
 * @param symbolsKey comma-joined, sorted symbols — a stable effect dependency.
 */
/** A live print and the move it is up or down on the session. */
export type LiveQuoteRow = { price: number; changePercent: number | null };

function sameQuotes(a: Record<string, LiveQuoteRow>, b: Record<string, LiveQuoteRow>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => b[k] !== undefined && a[k].price === b[k].price && a[k].changePercent === b[k].changePercent);
}

/**
 * Every surface on the book (five cards, the Exposure tab) polls the same
 * symbols: one read per symbol per SHARED_TTL_MS serves them all.
 */
const SHARED_TTL_MS = 4_000;
const sharedReads = new Map<string, { at: number; read: Promise<readonly [string, LiveQuoteRow] | null> }>();

async function readPrice(s: string): Promise<readonly [string, LiveQuoteRow] | null> {
  try {
    const live = await getLiveQuote(s);
    if (live.ok && Number.isFinite(live.quote.price) && live.quote.price > 0) {
      return [
        s,
        {
          price: live.quote.price,
          changePercent: Number.isFinite(live.quote.changePercent)
            ? live.quote.changePercent
            : null,
        },
      ] as const;
    }
  } catch {
    /* fall through to the regular-session quote */
  }
  try {
    const q = await getStockQuote(s);
    return [
      s,
      {
        price: q.price,
        changePercent: Number.isFinite(q.changePercent) ? q.changePercent : null,
      },
    ] as const;
  } catch {
    return null;
  }
}

function priceOf(s: string): Promise<readonly [string, LiveQuoteRow] | null> {
  const now = Date.now();
  const hit = sharedReads.get(s);
  if (hit && now - hit.at < SHARED_TTL_MS) return hit.read;
  for (const [k, v] of sharedReads) if (now - v.at >= SHARED_TTL_MS) sharedReads.delete(k);
  const read = readPrice(s);
  sharedReads.set(s, { at: now, read });
  return read;
}

export function useLiveQuotes(symbolsKey: string): Record<string, LiveQuoteRow> {
  const [prices, setPrices] = useState<Record<string, LiveQuoteRow>>({});
  const activity = useHomeTabActivity();

  useEffect(() => {
    const list = symbolsKey ? symbolsKey.split(",").filter(Boolean) : [];
    if (list.length === 0) {
      setPrices({});
      return;
    }
    let cancelled = false;

    const load = () => {
      void Promise.all(list.map(priceOf)).then((entries) => {
        if (cancelled) return;
        setPrices((prev) => {
          // Merge, never replace. Rebuilding the map from scratch dropped any
          // symbol that missed a tick, and every consumer reads a missing
          // symbol as 'value it at cost' — so one failed request turned a
          // position into its purchase price and the portfolio total jumped
          // to a number it had never been worth. Keeping the last good print
          // is what the note above always claimed this did.
          const next: Record<string, LiveQuoteRow> = {};
          // Held symbols only: a sold position must not keep a stale price.
          for (const symbol of list) {
            if (prev[symbol] != null) next[symbol] = prev[symbol];
          }
          for (const e of entries) {
            if (e && Number.isFinite(e[1].price) && e[1].price > 0) next[e[0]] = e[1];
          }
          // A tick that moved nothing keeps the same map, so nothing redraws
          // (every card on the book reads it, kept tabs included).
          return sameQuotes(prev, next) ? prev : next;
        });
      });
    };

    // Not from a tab kept hidden behind another, nor while the window is hidden; caught up on return.
    const tick = () => {
      if (activity.isActive() && document.visibilityState !== "hidden") load();
    };
    tick();
    const id = window.setInterval(tick, 5_000);
    const off = activity.onChange((active) => {
      if (active) tick();
    });
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      off();
      document.removeEventListener("visibilitychange", tick);
    };
  }, [symbolsKey, activity]);

  return prices;
}

/** Just the prints, for everything that values a book rather than tabulates it. */
export function useLivePrices(symbolsKey: string): Record<string, number> {
  const quotes = useLiveQuotes(symbolsKey);
  return useMemo(() => {
    const out: Record<string, number> = {};
    for (const [symbol, quote] of Object.entries(quotes)) out[symbol] = quote.price;
    return out;
  }, [quotes]);
}
