import { useEffect, useRef, useState } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import ConnectPortfolioEmpty, { usePortfolioConnected } from "@/components/dashboard/ConnectPortfolioEmpty";
import PortfolioChart from "@/components/dashboard/PortfolioChart";
import PortfolioValueHeadline from "@/components/dashboard/PortfolioValueHeadline";
import { TIMEFRAMES, type Timeframe } from "@/components/dashboard/TimeframeControls";

/**
 * The balance and its chart as a card like any other: it sits in the grid,
 * lifts, drags, resizes, duplicates and deletes exactly as Positions does.
 * It used to be a block of its own above the grid, with a dock beside it and
 * a full-screen mode — every one of those made it a different kind of thing
 * from the cards under it, and none of them survives here.
 *
 * Everything inside is sized from the card's own width: the number holds its
 * 76px while there is room and steps down from there; the selector sits
 * beside it until the two would touch, then drops under it. One measurement
 * feeds both, so they can never disagree about how much room there is.
 */
const TIMEFRAME_KEY = "falcon.ui.chartTimeframe";

export default function PortfolioValueCard({
  masked = false,
  onDuplicate,
  onRemove,
}: {
  masked?: boolean;
  onDuplicate?: () => void;
  onRemove?: () => void;
}) {
  // The window the chart draws — chosen from the settings panel, and kept:
  // a reader who works in days should not be handed a month on every launch.
  const [timeframe, setTimeframeState] = useState<Timeframe>(() => {
    try {
      const raw = localStorage.getItem(TIMEFRAME_KEY);
      if (raw && (TIMEFRAMES as readonly string[]).includes(raw)) return raw as Timeframe;
    } catch {
      /* the default below */
    }
    return "Month";
  });
  const setTimeframe = (tf: Timeframe) => {
    setTimeframeState(tf);
    try {
      localStorage.setItem(TIMEFRAME_KEY, tf);
    } catch {
      /* non-fatal */
    }
  };
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  /** Nothing linked yet — a balance of zero over a flat line says nothing. */
  const connected = usePortfolioConnected();

  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // The width the balance actually has: the card less its padding.
  const inner = Math.max(0, width - 40);
  const headlineSize = inner > 0 ? Math.round(Math.min(76, Math.max(34, (76 * inner) / 1100))) : 76;

  return (
    <div
      ref={rootRef}
      className="grid h-full w-full grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
    >
      <ChartCardHeader
        timeframe={connected ? timeframe : undefined}
        onTimeframe={setTimeframe}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
      />

      {!connected ? (
        <div className="row-span-2 min-h-0">
          <ConnectPortfolioEmpty
            line="No account linked yet. Connect a brokerage or open a Falcon paper account to track your portfolio's value."
          />
        </div>
      ) : (
      <>
      {/* The band: the balance, centred on the card. The window the chart
          draws is chosen from the settings glyph in the masthead. */}
      <div className="mt-4 flex w-full shrink-0 flex-col items-center">
        <PortfolioValueHeadline overrideValue={scrubValue} masked={masked} size={headlineSize} />
      </div>

      {/* The plot takes whatever height the card has left — drag the card
          taller and the chart grows, not a band of white above it. */}
      <div className="mt-2 flex min-h-0 min-w-0 flex-col">
        <PortfolioChart
          timeframe={timeframe}
          showGrowth
          showSp500
          // The balance on its own: no benchmark or hold line drawn behind it.
          comparisonLines={false}
          fill
          onScrub={setScrubValue}
        />
      </div>
      </>
      )}
    </div>
  );
}
