import NumberFlow from "@number-flow/react";
import { Moon, Sunrise, Sunset } from "lucide-react";
import { usePortfolioBalance } from "@/hooks/usePortfolioBalance";
import { marketSessionLabel, useMarketSession } from "@/hooks/useMarketSession";
import { useT } from "@/lib/i18n";

/**
 * Hero number for the Net worth card: the live portfolio value (cash +
 * live-priced positions + connected brokerage), set large and light with a
 * small muted label underneath, in the same type and inks as the
 * Allocation card's figure and caption.
 */

export default function PortfolioValueHeadline({
  overrideValue,
  masked = false,
  size = 76,
}: {
  /** While scrubbing the chart, the hovered point's value shows instead. */
  overrideValue?: number | null;
  /** Privacy mode: digits render as stars. */
  masked?: boolean;
  /**
   * Type size in pixels. The caller sets it from the width it has to give:
   * held at 76 the number simply runs off a narrowed card, or into the
   * controls beside it.
   */
  size?: number;
}) {
  const t = useT();
  const balance = usePortfolioBalance();
  const shown = overrideValue ?? balance;
  const session = useMarketSession();
  const sessionLabel = marketSessionLabel(session);

  return (
    <div className="flex select-none flex-col items-center">
      {masked ? (
        <span
          className="font-sans font-light leading-none tracking-[-0.03em] tabular-nums text-content-primary"
          style={{ fontSize: size }}
        >
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
        className="font-sans font-light leading-none tracking-[-0.03em] tabular-nums text-content-primary"
        style={{ fontSize: size }}
      />
      )}
      {/* Which session the number is priced from — outside regular hours that
          is the last extended-hours print, not the close. */}
      {sessionLabel ? (
        <span className="mt-3 flex items-center gap-1.5 text-[12px] leading-none text-content-tertiary">
          {session === "pre" ? (
            <Sunrise className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          ) : session === "post" ? (
            <Sunset className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          ) : session === "regular" ? (
            <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-[var(--teal)]" />
          ) : (
            <Moon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          )}
          {t(sessionLabel)}
        </span>
      ) : null}
    </div>
  );
}
