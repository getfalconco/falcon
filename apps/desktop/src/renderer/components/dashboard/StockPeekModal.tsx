import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Star, X } from "lucide-react";
import StockIcon from "../stock/StockIcon";
import { AnimateNumber } from "@/components/ui/animated-blur-number";
import { useLiveQuote } from "@/hooks/useLiveQuote";
import { getStockChart, getStockOverview } from "@/lib/stock-api";
import {
  positionFor,
  positionSide,
  readPaperAccount,
  subscribePaperAccount,
  type PaperPositionSide,
} from "@/lib/paper-account";
import { isFollowed, subscribeWatchlist, toggleFollow } from "@/lib/watchlist";
import { cn } from "../../lib/utils";
import type { ChartTimeframe, LiveQuoteSession, PricePoint } from "../../../shared/stock-types";
import type { StockCatalogEntry } from "../../../shared/stock-catalog";

/**
 * ⌘K's landing surface: pick a stock in the command menu and it opens here —
 * the same glass frame as the Insight panel, at the same size — instead of
 * leaving the dashboard for the stock screen.
 *
 * Today it carries the identity + price strip: ticker, name, sector, the live
 * price with the session's change, a held/watchlist badge, and a mini chart
 * over day/week/month. The space below the chart is deliberately unclaimed;
 * the deeper layers of the peek land there next.
 */

const PANEL_TWEEN = { type: "spring", stiffness: 260, damping: 28, mass: 0.9 } as const;

const PRICE_FORMAT = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;

const SIGNED_USD = {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
} as const satisfies Intl.NumberFormatOptions;

const SIGNED_PERCENT = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
} as const satisfies Intl.NumberFormatOptions;

const SESSION_LABEL: Record<LiveQuoteSession, string> = {
  regular: "Live",
  pre: "Pre-market",
  post: "After hours",
  closed: "Market closed",
};

/** The peek's mini ranges: a day, a week, a month. */
const PEEK_TIMEFRAMES = ["1D", "1W", "1M"] as const satisfies readonly ChartTimeframe[];
type PeekTimeframe = (typeof PEEK_TIMEFRAMES)[number];

const UP = "#16A34A";
const DOWN = "#DC2626";

type ChartSession = "pre" | "reg" | "post";

/**
 * Plain-SVG price line: stretched to its box, stroke kept at 1.5px. The series
 * arrives extended-hours aware (Yahoo includePrePost, tagged pre/reg/post per
 * point), and the line honours it: regular-session runs draw solid, pre/after
 * market runs draw faded — the after-hours move is on the chart, and reads as
 * what it is.
 */
function MiniChart({ series }: { series: PricePoint[] }) {
  const points = series.filter((p) => Number.isFinite(p.v));
  if (points.length < 2) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[#9CA3AF]">
        No chart data for this range.
      </div>
    );
  }

  const first = points[0].v;
  const last = points[points.length - 1].v;
  const up = last >= first;
  const color = up ? UP : DOWN;

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    if (p.v < lo) lo = p.v;
    if (p.v > hi) hi = p.v;
  }
  const vSpan = hi - lo || 1;

  // X runs over bar index, not clock time: sessions the market never traded —
  // nights, weekends, holidays — simply aren't on the axis, so a week closes
  // Friday and reopens Monday with no dead stretch between. Trading gaps of
  // any length cost exactly one bar-width.
  type IndexedPoint = { i: number; v: number; s?: ChartSession };
  const indexed: IndexedPoint[] = points.map((p, i) => ({ i, v: p.v, s: p.s }));
  const iSpan = indexed.length - 1 || 1;

  // 6…94: breathing room so the line never kisses the frame.
  const x = (i: number) => (i / iSpan) * 100;
  const y = (v: number) => 94 - ((v - lo) / vSpan) * 88;

  const toPath = (pts: IndexedPoint[]) =>
    pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join("");

  // Contiguous same-session runs, each seeded with the previous run's last
  // point so the line never breaks at a session boundary. Untagged points
  // (daily+ candles) count as regular.
  const segments: { session: ChartSession; pts: IndexedPoint[] }[] = [];
  for (const p of indexed) {
    const session: ChartSession = p.s ?? "reg";
    const prev = segments[segments.length - 1];
    if (prev && prev.session === session) {
      prev.pts.push(p);
    } else {
      segments.push({ session, pts: prev ? [prev.pts[prev.pts.length - 1], p] : [p] });
    }
  }

  const area = `${toPath(indexed)}L100,100L0,100Z`;
  const gradientId = up ? "peek-chart-up" : "peek-chart-down";

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.16} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <line
        x1="0"
        y1={y(first)}
        x2="100"
        y2={y(first)}
        stroke="#9CA3AF"
        strokeOpacity={0.35}
        strokeDasharray="1.5 2.5"
        vectorEffect="non-scaling-stroke"
      />
      {segments.map((seg, i) => (
        <path
          key={i}
          d={toPath(seg.pts)}
          fill="none"
          stroke={color}
          strokeOpacity={seg.session === "reg" ? 1 : 0.42}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

export default function StockPeekModal({
  entry,
  onClose,
}: {
  /** The stock to show; null keeps the modal closed. */
  entry: StockCatalogEntry | null;
  onClose: () => void;
}) {
  const open = entry != null;
  // The exit animation still needs a subject after `entry` goes null.
  const lastEntry = useRef<StockCatalogEntry | null>(null);
  if (entry) lastEntry.current = entry;
  const shown = entry ?? lastEntry.current;
  const symbol = shown?.symbol ?? "";

  const live = useLiveQuote(symbol, { enabled: open && symbol.length > 0 });

  // Sector comes off the overview's company profile — the only place it lives.
  const [sector, setSector] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !symbol) return;
    let cancelled = false;
    setSector(null);
    void getStockOverview(symbol, "1D")
      .then((data) => {
        if (!cancelled) setSector(data.company.sector?.trim() || null);
      })
      .catch(() => {
        /* identity strip just goes without the chip */
      });
    return () => {
      cancelled = true;
    };
  }, [open, symbol]);

  // Mini chart: fetched per range, kept per symbol so flipping back is instant.
  const [timeframe, setTimeframe] = useState<PeekTimeframe>("1D");
  const [series, setSeries] = useState<PricePoint[] | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const seriesCache = useRef<Map<string, PricePoint[]>>(new Map());
  useEffect(() => {
    if (open) {
      setTimeframe("1D");
      seriesCache.current.clear();
    }
  }, [open, symbol]);
  useEffect(() => {
    if (!open || !symbol) return;
    const key = `${symbol}:${timeframe}`;
    const cached = seriesCache.current.get(key);
    if (cached) {
      setSeries(cached);
      return;
    }
    let cancelled = false;
    setSeries(null);
    setChartLoading(true);
    void getStockChart(symbol, timeframe)
      .then((points) => {
        if (cancelled) return;
        seriesCache.current.set(key, points);
        setSeries(points);
      })
      .catch(() => {
        if (!cancelled) setSeries([]);
      })
      .finally(() => {
        if (!cancelled) setChartLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, symbol, timeframe]);

  // Held (paper book) + watchlist state, live against their own change events.
  const [heldSide, setHeldSide] = useState<PaperPositionSide>("flat");
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!open || !symbol) return;
    const read = () => {
      setHeldSide(positionSide(positionFor(readPaperAccount(), symbol)));
      setWatching(isFollowed(symbol));
    };
    read();
    const offPaper = subscribePaperAccount(read);
    const offWatch = subscribeWatchlist(read);
    return () => {
      offPaper();
      offWatch();
    };
  }, [open, symbol]);

  // Esc closes; the dashboard never scrolls underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const quote = live.quote;
  const dayUp = (quote?.change ?? 0) >= 0;
  const isLive = quote != null && quote.session !== "closed";

  const badges = useMemo(() => {
    const held = heldSide !== "flat";
    return { held, heldLabel: heldSide === "long" ? "Held · Long" : "Held · Short" };
  }, [heldSide]);

  return createPortal(
    <AnimatePresence>
      {open && shown && (
        <motion.div
          key="stock-peek"
          className="fixed inset-0 z-[80] flex items-center justify-center"
          initial={false}
          animate={{}}
          exit={{}}
        >
          {/* Backdrop — the dashboard blurs away behind the panel. */}
          <motion.div
            className="app-no-drag absolute inset-0 bg-black/10"
            style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.33, 1, 0.68, 1] }}
            onClick={onClose}
          />

          {/* Panel — the shared glass surface, the Insight panel's own size. */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`${shown.symbol} overview`}
            className="app-no-drag relative flex h-[70vh] w-[70vw] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            initial={{ opacity: 0, scale: 0.94, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={PANEL_TWEEN}
          >
            {/* Masthead doubles as the window drag strip while the panel is up. */}
            <motion.div
              className="app-drag-region flex items-center justify-between"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            >
              <span className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">
                STOCK
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="app-no-drag rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            </motion.div>

            {/* Identity + price strip. */}
            <motion.div
              className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12, duration: 0.34, ease: [0.4, 0, 0.2, 1] }}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#E3E3E0]">
                <StockIcon
                  symbol={shown.symbol}
                  companyName={shown.companyName}
                  size="md"
                  className="h-6 w-6 object-contain"
                />
              </span>

              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <h2 className="font-sans text-[22px] font-medium leading-none tracking-[-0.01em] text-[#1d1b1b]">
                    {shown.symbol}
                  </h2>
                  {badges.held ? (
                    <span className="rounded-full bg-[#16A34A]/10 px-2 py-0.5 text-[10.5px] font-medium tracking-[0.02em] text-[#15803D]">
                      {badges.heldLabel}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => toggleFollow({ ticker: shown.symbol, companyName: shown.companyName })}
                    aria-pressed={watching}
                    className={cn(
                      "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium tracking-[0.02em] transition-colors",
                      watching
                        ? "bg-[#1d1b1b]/[0.08] text-[#1d1b1b]"
                        : "text-[#9CA3AF] hover:bg-black/[0.04] hover:text-[#1d1b1b]",
                    )}
                  >
                    <Star
                      className="h-3 w-3"
                      strokeWidth={2}
                      fill={watching ? "currentColor" : "none"}
                      aria-hidden
                    />
                    {watching ? "Watching" : "Watch"}
                  </button>
                </div>
                <p className="mt-1 truncate text-[13px] text-[#6b7280]">
                  {shown.companyName}
                  {sector ? <span className="text-[#9CA3AF]"> · {sector}</span> : null}
                </p>
              </div>

              {/* Live price + the session's change, right-aligned off the identity. */}
              <div className="ml-auto text-right">
                {quote ? (
                  <>
                    <AnimateNumber
                      value={quote.price}
                      prefix="$"
                      format={PRICE_FORMAT}
                      duration={380}
                      blur={12}
                      className="font-sans text-[26px] font-medium leading-none tracking-[-0.01em] text-[#1d1b1b]"
                    />
                    <p
                      className={cn(
                        "mt-1 flex items-baseline justify-end gap-1.5 text-[12.5px] font-medium tabular-nums",
                        dayUp ? "text-[#16A34A]" : "text-[#DC2626]",
                      )}
                    >
                      <AnimateNumber value={quote.change} format={SIGNED_USD} duration={380} blur={8} />
                      <AnimateNumber
                        value={quote.changePercent}
                        format={SIGNED_PERCENT}
                        suffix="%"
                        duration={380}
                        blur={8}
                      />
                    </p>
                    <p className="mt-1 flex items-center justify-end gap-1.5">
                      <span
                        aria-hidden
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          isLive ? "bg-[#16A34A]" : "bg-[#D1D5DB]",
                          quote.session === "regular" && "animate-pulse",
                        )}
                      />
                      <span className="text-[10.5px] uppercase tracking-[0.1em] text-[#9CA3AF]">
                        {SESSION_LABEL[quote.session]}
                      </span>
                    </p>
                  </>
                ) : (
                  <p className="text-[13px] text-[#9CA3AF]">
                    {live.loading ? "Loading price…" : (live.error ?? "Price unavailable")}
                  </p>
                )}
              </div>
            </motion.div>

            {/* Mini chart: a day, a week, a month. */}
            <motion.div
              className="mt-5 flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.16, duration: 0.34, ease: [0.4, 0, 0.2, 1] }}
            >
              <div className="flex items-center justify-end gap-1">
                {PEEK_TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
                    aria-pressed={timeframe === tf}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                      timeframe === tf
                        ? "bg-white/70 text-[#1d1b1b] ring-1 ring-black/[0.06]"
                        : "text-[#6b7280] hover:text-[#1d1b1b]",
                    )}
                  >
                    {tf}
                  </button>
                ))}
              </div>
              <div className="mt-2 min-h-0 flex-1">
                {chartLoading ? (
                  <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[#9CA3AF]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Loading chart…
                  </div>
                ) : series ? (
                  <MiniChart series={series} />
                ) : null}
              </div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
