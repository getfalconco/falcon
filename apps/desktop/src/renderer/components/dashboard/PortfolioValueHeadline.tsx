import NumberFlow from "@number-flow/react";
import { Moon, Sunrise, Sunset } from "lucide-react";
import { usePortfolioBalance } from "@/hooks/usePortfolioBalance";
import { marketSessionLabel, useMarketSession } from "@/hooks/useMarketSession";
import { cn } from "@/lib/utils";

/**
 * Hero number for the dashboard: the live portfolio value (cash +
 * live-priced positions + connected brokerage), rendered huge in Geist
 * with a small muted label underneath.
 */

export default function PortfolioValueHeadline({
  overrideValue,
  masked = false,
}: {
  /** While scrubbing the chart, the hovered point's value shows instead. */
  overrideValue?: number | null;
  /** Privacy mode: digits render as stars. */
  masked?: boolean;
}) {
  const balance = usePortfolioBalance();
  const shown = overrideValue ?? balance;
  const session = useMarketSession();
  const sessionLabel = marketSessionLabel(session);

  return (
    <div className="flex select-none flex-col items-center">
      {masked ? (
        <span className="font-sans text-[76px] font-medium leading-none tracking-[0.01em] tabular-nums text-[#1d1b1b]">
          $*****
        </span>
      ) : (
      <NumberFlow
        value={shown}
        format={{
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }}
        className="font-sans text-[76px] font-medium leading-none tracking-[0.01em] tabular-nums text-[#1d1b1b]"
      />
      )}
      {/* Which session the number is priced from — outside regular hours that
          is the last extended-hours print, not the close. */}
      {sessionLabel ? (
        <span
          className={cn(
            "mt-3 flex items-center gap-1.5 text-[12.5px]",
            session === "regular" ? "text-[#189E9A]" : "text-[#6b7280]",
          )}
        >
          {session === "pre" ? (
            <Sunrise className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          ) : session === "post" ? (
            <Sunset className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          ) : session === "regular" ? (
            <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-[#189E9A]" />
          ) : (
            <Moon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          )}
          {sessionLabel}
        </span>
      ) : null}
    </div>
  );
}
