import { useEffect, useRef, useState } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import ConnectPortfolioEmpty, { usePortfolioConnected } from "@/components/dashboard/ConnectPortfolioEmpty";
import PortfolioChart from "@/components/dashboard/PortfolioChart";
import PortfolioValueHeadline, { MarketSessionTag } from "@/components/dashboard/PortfolioValueHeadline";
import { TIMEFRAMES, type Timeframe } from "@/components/dashboard/TimeframeControls";
import { useT } from "@/lib/i18n";

/**
 * The balance and its chart as a card like any other: it sits in the grid,
 * lifts, drags, resizes, duplicates and deletes exactly as Positions does.
 * It used to be a block of its own above the grid, with a dock beside it and
 * a full-screen mode — every one of those made it a different kind of thing
 * from the cards under it, and none of them survives here.
 *
 * Drawn on a surface of its own, the same in both themes: the blue
 * `.glow-card`, lit from inside along its edges (globals.css), with the balance as a dot-matrix figure
 * left aligned under the label and the change over the chart's window
 * beside it. Everything inside is sized from the card's own width: the
 * figure holds its size while there is room and steps down from there, and
 * the change sits beside it until the two would touch, then drops under it.
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
  const t = useT();
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
  /** Where the chart's window starts, for the change beside the balance. */
  const [startValue, setStartValue] = useState<number | null>(null);
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

  return (
    <div
      ref={rootRef}
      className="glow-card grid h-full w-full grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-3xl p-5"
    >
      <ChartCardHeader
        labelClassName="text-[13px] font-semibold text-[rgb(255,255,255)]"
        onColor
        meta={connected ? <MarketSessionTag /> : undefined}
        timeframe={connected ? timeframe : undefined}
        onTimeframe={setTimeframe}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
      />

      {!connected ? (
        <div className="row-span-2 min-h-0">
          <ConnectPortfolioEmpty line={t("dashboard.portfolioValue.empty")} onColor />
        </div>
      ) : (
      <>
      {/* The band: the balance, left aligned under the label, and its change
          over the window the chart draws (chosen from the settings glyph in
          the masthead). */}
      <div className="mt-3 w-full shrink-0">
        <PortfolioValueHeadline
          overrideValue={scrubValue}
          masked={masked}
          width={inner}
          start={startValue}
          timeframe={timeframe}
        />
      </div>

      {/* The plot takes whatever height the card has left — drag the card
          taller and the chart grows, not a band of white above it. */}
      <div className="mt-3 flex min-h-0 min-w-0 flex-col">
        <PortfolioChart
          timeframe={timeframe}
          showGrowth
          showSp500
          // The balance on its own: no benchmark or hold line drawn behind it.
          comparisonLines={false}
          fill
          onScrub={setScrubValue}
          onBaseline={setStartValue}
        />
      </div>
      </>
      )}
    </div>
  );
}
