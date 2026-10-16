import { useCallback, useMemo, useState } from "react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useShownPoll } from "@/lib/use-shown-poll";
import { formatMove, nyToday } from "../../../shared/earnings-view";
import type { StockToday, TodayFormat } from "../../../shared/today-move";

/** New York's date now, for the lines' "today" and "yesterday". */
export { nyToday };

/**
 * The "Today" reads (main/stock-tab-data/today.ts) and the formatting the
 * lines take in the reader's language.
 *
 * Polled while shown only (`useShownPoll`: the tab in front, the window
 * visible); main keeps each answer two minutes, and the read itself is
 * cache first, so a poll costs a quote and little else on an ordinary day.
 */

const POLL_MS = 3 * 60_000;
const KEEP_MS = 3 * 60_000;

const kept = new Map<string, { at: number; value: StockToday | null }>();

function api() {
  return typeof window === "undefined" ? undefined : window.meridian;
}

/** The open stock's session against its usual day; null while unread, on a failure, or with too little history. */
export function useStockToday(ticker: string): StockToday | null {
  const [value, setValue] = useState<StockToday | null>(() => {
    const hit = kept.get(ticker);
    return hit && Date.now() - hit.at < KEEP_MS ? hit.value : null;
  });
  const run = useCallback(() => {
    const read = api()?.getStockToday;
    if (!read) return;
    void read(ticker)
      .then((r) => {
        if (!r.ok) return;
        kept.set(ticker, { at: Date.now(), value: r.today });
        setValue(r.today);
      })
      .catch(() => {});
  }, [ticker]);
  useShownPoll(ticker, run, POLL_MS, { freshForMs: POLL_MS / 2 });
  return value;
}

/** Held names moving unusually, by ticker (the Positions card). `symbolsKey` is the sorted, comma-joined holdings. */
export function useUnusualHoldings(symbolsKey: string): Record<string, StockToday> {
  const [value, setValue] = useState<Record<string, StockToday>>({});
  const run = useCallback(() => {
    const read = api()?.getStockTodayMoves;
    if (!read || !symbolsKey) return;
    void read(symbolsKey.split(","))
      .then((r) => {
        if (!r.ok) return;
        setValue(Object.fromEntries(r.unusual.map((d) => [d.ticker, d] as const)));
      })
      .catch(() => {});
  }, [symbolsKey]);
  useShownPoll(symbolsKey, run, 5 * 60_000, { freshForMs: 2 * 60_000 });
  return value;
}

function safe<T>(make: () => T, fallback: () => T): T {
  try {
    return make();
  } catch {
    return fallback();
  }
}

/** The formatting shared/today-move's lines take, in the reader's language. */
export function useTodayFormat(): TodayFormat {
  const { t, locale } = useI18n();
  return useMemo(() => {
    const share = safe(
      () => new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      () => new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    );
    const ratio = safe(
      () => new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      () => new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    );
    const money = safe(
      () => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }),
      () => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }),
    );
    const weekday = safe(
      () => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }),
      () => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }),
    );
    const clock = (withDay: boolean) =>
      safe(
        () => new Intl.DateTimeFormat(locale, { ...(withDay ? { weekday: "short" as const } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" }),
        () => new Intl.DateTimeFormat("en-US", { ...(withDay ? { weekday: "short" as const } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" }),
      );
    const timeShort = clock(false);
    const timeDay = clock(true);
    const list = safe(
      () => new Intl.ListFormat(locale, { style: "short", type: "unit" }),
      () => new Intl.ListFormat("en-US", { style: "short", type: "unit" }),
    );
    const plural = safe(
      () => new Intl.PluralRules(locale),
      () => new Intl.PluralRules("en-US"),
    );
    return {
      t: (key, params) => t(key as MessageKey, params),
      move: (fraction) => formatMove(fraction, locale) ?? "",
      share: (fraction) => share.format(Math.abs(fraction)),
      ratio: (value) => ratio.format(value),
      money: (usd) => money.format(usd),
      weekday: (ymd) => weekday.format(new Date(`${ymd}T12:00:00Z`)),
      time: (at, withDay) => `${(withDay ? timeDay : timeShort).format(new Date(at))} ET`,
      list: (parts) => list.format(parts),
      plural: (count) => (plural.select(count) === "one" ? "one" : "other"),
    };
  }, [t, locale]);
}
