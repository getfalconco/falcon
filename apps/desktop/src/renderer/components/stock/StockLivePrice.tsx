import { withClock } from "@/lib/clock";
import { useEffect, useState } from "react";
import { AnimateNumber } from "@/components/ui/animated-blur-number";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { marketSessionLabel } from "@/hooks/useMarketSession";
import type { LiveQuoteState } from "@/hooks/useLiveQuote";

const PRICE_FORMAT = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
} as const;

const SIGNED_CURRENCY_FORMAT = {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
} as const satisfies Intl.NumberFormatOptions;

const SIGNED_PERCENT_FORMAT = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
} as const satisfies Intl.NumberFormatOptions;

/** Built per render so the clock picked in Settings, General applies on the next tick. */
function formatQuoteTime(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(
    locale,
    withClock({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      // On "auto" English keeps the 12-hour clock it was drawn in; every other
      // language reads its own habit.
      ...(locale === "en-US" ? { hour12: true } : {}),
      timeZone: "America/New_York",
    }),
  ).format(date);
}

/**
 * Live price for the stock screen: price, session change, and a freshness dot.
 * `hero` is the big centered block on the pre-analysis screen; `inline` is the
 * one-line version that sits in the results header.
 */
export default function StockLivePrice({
  state,
  variant = "hero",
  className,
}: {
  state: LiveQuoteState;
  variant?: "hero" | "inline";
  className?: string;
}) {
  const { quote, tick, error, loading } = state;
  const { t, locale } = useI18n();
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const inline = variant === "inline";

  // Briefly tint the price on every tick so movement is visible even when only
  // the cents change.
  useEffect(() => {
    if (!tick) return;
    setFlash(tick);
    const id = window.setTimeout(() => setFlash(null), 700);
    return () => window.clearTimeout(id);
  }, [tick, quote?.asOf]);

  if (!quote) {
    return (
      <p className={cn("text-sm text-fg-faint", inline ? "text-xs" : "h-9", className)}>
        {loading ? t("stock.price.loading") : (error ?? t("stock.price.unavailable"))}
      </p>
    );
  }

  const isPositive = quote.change >= 0;
  const isLive = quote.session !== "closed";

  const sessionBadge = (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          isLive ? "bg-gain" : "bg-white/25",
          quote.session === "regular" && "animate-pulse",
        )}
        aria-hidden
      />
      <span className="text-[11px] uppercase tracking-[0.12em] text-fg-faint">
        {t(marketSessionLabel(quote.session))}
      </span>
    </span>
  );

  const price = (
    <AnimateNumber
      value={quote.price}
      prefix="$"
      format={PRICE_FORMAT}
      duration={380}
      blur={14}
      className={cn(
        "font-semibold leading-none tracking-tight transition-colors duration-300",
        inline ? "text-[20px]" : "text-[34px]",
        flash === "up" ? "text-gain" : flash === "down" ? "text-loss" : "text-foreground",
      )}
    />
  );

  const change = (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 font-medium",
        inline ? "text-xs" : "text-sm",
        isPositive ? "text-gain" : "text-loss",
      )}
    >
      <span aria-hidden>{isPositive ? "↑" : "↓"}</span>
      <AnimateNumber value={quote.change} format={SIGNED_CURRENCY_FORMAT} duration={380} blur={10} />
      <AnimateNumber
        value={quote.changePercent}
        format={SIGNED_PERCENT_FORMAT}
        suffix="%"
        duration={380}
        blur={10}
      />
    </span>
  );

  const timestamp = (
    <span className="text-[11px] tabular-nums text-fg-faint">
      {t("stock.price.asOf", { time: formatQuoteTime(new Date(quote.asOf), locale) })}
    </span>
  );

  if (inline) {
    return (
      <div className={cn("flex flex-wrap items-baseline justify-end gap-x-3 gap-y-1", className)}>
        {price}
        {change}
        <span className="flex items-center gap-2">
          {sessionBadge}
          {timestamp}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      {sessionBadge}
      <div className="flex flex-wrap items-baseline justify-center gap-x-3">
        {price}
        {change}
      </div>
      {timestamp}
    </div>
  );
}
