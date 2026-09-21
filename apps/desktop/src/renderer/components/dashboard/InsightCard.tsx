import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type {
  PropagationDirection,
  PropagationRun,
  PropagationRunListItem,
  PropagationTarget,
} from "../../../shared/propagation-run-types";
import InsightDetailModal from "./InsightDetailModal";
import SelectionGloss from "./SelectionGloss";
import {
  buildCalendar,
  buildDemoCalendar,
  cardTargets,
  pricedInColor,
  formatPricedIn,
  pricedInDetail,
  dayColor,
  dayLabel,
  LEGEND_COLORS,
  monthTicks,
  orderRuns,
  stamp,
  targetExplain,
  WEEKDAY_TICKS,
  type DayCell,
} from "../../lib/second-order-card";
import { livePricedIn, targetPricedIn } from "../../../shared/propagation-progress";
import { mulberry32, useDemoMode } from "../../lib/demo-mode";
import StockIcon from "../stock/StockIcon";
import { getLiveQuote, getStockQuote } from "../../lib/stock-api";
import { cn } from "../../lib/utils";
import { STOCK_OPEN_EVENT } from "../../lib/stock-open";

/**
 * Editorial card: the day's most consequential propagation event in the
 * engine's own words, over a field of dots — one per day, leaning green where
 * the network hasn't absorbed the day's events yet and pink where it has.
 */

/** Today sits at the right edge and the field runs back from there. How far
 *  back is the card's width to decide: these are the pre-measurement default
 *  and the bounds the measured count is held between. */
/** Four and a half months, and never more than a year. */
const MIN_WEEKS = 19;
const MAX_WEEKS = 52;
/** One week across, and the cell drawn inside it. */
const PITCH = 13;
const CELL = 10;
/** GitHub's cells are barely rounded — enough to soften, not enough to read
 *  as dots. */
const RADIUS = 2;
/** Room for the weekday column on the left and the month row on top. */
const GUTTER = 20;
const BAND = 13;
const LABEL = "#9CA3AF";
const LABEL_FONT = "Geist Mono, ui-monospace, monospace";
/** The hover card reads as a line of copy now, so it needs room — and the
 *  clamp that keeps it on the card has to know half of that room. */
const POPUP_MAX = 260;
const POPUP_ROWS = 6;

function Calendar({ columns, pitch }: { columns: DayCell[][]; pitch: number }) {
  // Pixel offsets inside the wrapper, measured from the hovered cell itself —
  // the SVG renders at its natural size, so viewBox percentages no longer map
  // onto the wrapper and would drift the popup sideways.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ cell: DayCell; x: number; y: number } | null>(null);
  const gridW = columns.length * pitch;
  const gridH = 7 * pitch;
  const width = GUTTER + gridW;
  const height = BAND + gridH;
  const months = monthTicks(columns);

  return (
    <div ref={wrapRef} className="relative">
      {/* Cells keep their natural size — the card's width decides how far
          back the field runs, and the pitch takes up the remainder so the
          grid lands flush on both edges instead of stretching the squares. */}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block h-auto max-w-full"
        role="img"
        aria-label="Propagation days"
      >
        {/* Months across the top, weekdays down the left — the two axes that
            make a heatmap readable as a calendar. */}
        {months.map((tick) => (
          <text
            key={`${tick.column}-${tick.label}`}
            x={GUTTER + tick.column * pitch}
            y={BAND - 4}
            fontSize={8}
            fontFamily={LABEL_FONT}
            fill={LABEL}
          >
            {tick.label}
          </text>
        ))}
        {WEEKDAY_TICKS.map((tick) => (
          <text
            key={tick.label}
            x={GUTTER - 5}
            y={BAND + tick.row * pitch + pitch / 2 + 2.8}
            fontSize={8}
            fontFamily={LABEL_FONT}
            fill={LABEL}
            textAnchor="end"
          >
            {tick.label}
          </text>
        ))}
        {columns.map((column, w) =>
          column.map((cell, d) => (
            <rect
              key={cell.date}
              x={GUTTER + w * pitch + (pitch - CELL) / 2}
              y={BAND + d * pitch + (pitch - CELL) / 2}
              width={CELL}
              height={CELL}
              rx={RADIUS}
              fill={dayColor(cell)}
              onMouseEnter={(e) => {
                // Empty days have nothing to show — no frame.
                const wrap = wrapRef.current;
                if (cell.items.length === 0 || !wrap) {
                  setHover(null);
                  return;
                }
                const box = e.currentTarget.getBoundingClientRect();
                const host = wrap.getBoundingClientRect();
                setHover({
                  cell,
                  // Clamped so a first- or last-column popup can't bleed past
                  // the card: the popup is centred on x, so it needs half its
                  // width on each side — or the card's whole width, when the
                  // card is the narrower of the two.
                  x: Math.min(
                    Math.max(box.left + box.width / 2 - host.left, Math.min(POPUP_MAX / 2, host.width / 2)),
                    Math.max(host.width - POPUP_MAX / 2, host.width / 2),
                  ),
                  y: box.top - host.top,
                });
              }}
              onMouseLeave={() => setHover(null)}
            />
          )),
        )}
      </svg>
      {/* Hover: the day's line, and under it what actually propagated that
          day — one row per run, its tone as a square, then the company and
          the event in the engine's own words. Springs open from the cell. */}
      <AnimatePresence>
        {hover && (
          /* Two layers on purpose: the outer one owns position (the CSS
             -translate-x-1/2/-translate-y-full anchor) and animates only
             opacity, because framer writes its scale/y as an inline transform
             that would clobber that anchor — which is exactly how the popup
             used to drift below-right of the cell. */
          <motion.div
            key={hover.cell.date}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full"
            style={{ left: hover.x, top: hover.y - 6 }}
          >
          <motion.div
            initial={{ scale: 0.92, y: 4 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.6 }}
            className="w-max origin-bottom rounded-2xl border border-white/60 bg-white/40 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_24px_64px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            style={{ maxWidth: POPUP_MAX }}
          >
            <div className="pb-1.5 text-[10.5px] leading-none text-[#6b7280]">
              {dayLabel(hover.cell)}
            </div>
            <ul className="flex flex-col gap-1.5" aria-label={dayLabel(hover.cell)}>
              {hover.cell.items.slice(0, POPUP_ROWS).map((item, i) => (
                <motion.li
                  key={item.run_id}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.025 * i, duration: 0.18, ease: "easeOut" }}
                  className="flex items-center gap-1.5"
                >
                  <span
                    aria-hidden
                    className="block h-[9px] w-[9px] shrink-0 rounded-[2px]"
                    style={{ backgroundColor: pricedInColor(item.priced_in) }}
                  />
                  {item.root_ticker ? (
                    <span className="shrink-0 text-[11px] font-semibold leading-none text-[#1d1b1b]">
                      {item.root_ticker}
                    </span>
                  ) : null}
                  <span className="truncate text-[11px] leading-none text-[#4b5563]">
                    {item.event_label}
                  </span>
                </motion.li>
              ))}
              {hover.cell.items.length > POPUP_ROWS ? (
                <li className="pl-[15px] text-[10.5px] leading-none text-[#9CA3AF]">
                  +{hover.cell.items.length - POPUP_ROWS} more
                </li>
              ) : null}
            </ul>
          </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const NAME_ROWS = 4;
/** The detail panel's rail is taller than the card — it shows more of them. */
const PANEL_ROWS = 12;

type RelatedQuote = { price: number; changePercent: number | null };

/** Live price + day change for the related names — the same extended-hours
 *  print the rest of the dashboard values the book at. */
function useRelatedQuotes(symbolsKey: string): Record<string, RelatedQuote> {
  const [quotes, setQuotes] = useState<Record<string, RelatedQuote>>({});
  useEffect(() => {
    const list = symbolsKey ? symbolsKey.split(",").filter(Boolean) : [];
    if (list.length === 0) {
      setQuotes({});
      return;
    }
    let cancelled = false;
    const quoteOf = async (s: string): Promise<readonly [string, RelatedQuote] | null> => {
      try {
        const live = await getLiveQuote(s);
        if (live.ok && Number.isFinite(live.quote.price) && live.quote.price > 0) {
          return [
            s,
            {
              price: live.quote.price,
              changePercent: Number.isFinite(live.quote.changePercent) ? live.quote.changePercent : null,
            },
          ] as const;
        }
      } catch {
        /* fall through */
      }
      try {
        const q = await getStockQuote(s);
        return [s, { price: q.price, changePercent: Number.isFinite(q.changePercent) ? q.changePercent : null }] as const;
      } catch {
        return null;
      }
    };
    const load = () => {
      void Promise.all(list.map(quoteOf)).then((entries) => {
        if (cancelled) return;
        const next: Record<string, RelatedQuote> = {};
        for (const e of entries) if (e && e[1].price > 0) next[e[0]] = e[1];
        setQuotes(next);
      });
    };
    load();
    // The same beat as the Assets card and the headline (useLivePrices): a
    // price that sits still for a minute beside one that moves every few
    // seconds reads as a broken feed, and the priced-in share below is
    // computed off this price, so it would lag too.
    const id = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [symbolsKey]);
  return quotes;
}

function fmtPrice(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The names the event reaches, under the calendar: logo, ticker, live price
 * and day change on the left; on the right one square in the calendar's own
 * ramp — green while the move is open, pink once it is priced in — and the
 * priced-in percentage.
 */
/** The expected move reads in the dashboard's own gain/loss colours; a call
 *  with no direction stays neutral rather than borrowing one. */
const EXPECTED_COLOR: Record<PropagationDirection, string> = {
  positive: "#16A34A",
  negative: "#DC2626",
  mixed: "#6b7280",
  unclear: "#6b7280",
};

function RelatedNames({ targets, run }: { targets: PropagationTarget[]; run: PropagationRun }) {
  const symbolsKey = useMemo(
    () =>
      targets
        .map((t) => (t.ticker ?? "").toUpperCase())
        .filter(Boolean)
        .sort()
        .join(","),
    [targets],
  );
  const quotes = useRelatedQuotes(symbolsKey);
  // Hover explains the row: why the event reaches this name and what the
  // engine expects of it. Anchored above the row it belongs to, spanning the
  // list so the sentences never have to be clamped sideways.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{
    target: PropagationTarget;
    top: number;
    /** The row's own chip value, so the panel quotes the same number. */
    pricedIn: number | null;
  } | null>(null);
  if (targets.length === 0) return null;
  return (
    <div ref={listRef} className="relative mt-4">
      <ul className="flex flex-col gap-[6px]" aria-label="Related names">
        {targets.map((t) => {
          const ticker = (t.ticker ?? "").toUpperCase();
          const q = quotes[ticker];
          // Live where the quote allows it, the engine's last sweep otherwise.
          const pricedIn = livePricedIn(t, q?.price) ?? targetPricedIn(t);
          const chg = q?.changePercent ?? null;
          return (
            <li
              key={t.target}
              className="flex items-center gap-2"
              onMouseEnter={(e) => {
                const list = listRef.current;
                if (!list) return;
                const box = e.currentTarget.getBoundingClientRect();
                setHover({ target: t, top: box.top - list.getBoundingClientRect().top, pricedIn });
              }}
              onMouseLeave={() => setHover(null)}
            >
              <StockIcon symbol={ticker} companyName={t.label} size="sm" className="h-[18px] w-[18px] shrink-0" />
              <span className="text-[12.5px] font-semibold leading-none text-[#1d1b1b]">{ticker}</span>
              <span className="ml-1 text-[12px] leading-none tabular-nums text-[#374151]">
                {q ? fmtPrice(q.price) : "—"}
              </span>
              {chg != null && (
                <span
                  className={cn(
                    "text-[11.5px] font-semibold leading-none tabular-nums",
                    chg > 0 ? "text-[#16A34A]" : chg < 0 ? "text-[#DC2626]" : "text-[#6b7280]",
                  )}
                >
                  {chg >= 0 ? "↑" : "↓"} {Math.abs(chg).toFixed(2)}%
                </span>
              )}
              {/* The share of the called move this name has travelled: green
                  at nothing, red while it goes the other way, blue as the call
                  lands — and past 100% when it overshoots. */}
              {/* No title here: the row's hover panel carries the measurement,
                  and a native tooltip on top of it just fights with it. */}
              <span className="ml-auto flex items-center gap-2">
                <span
                  role="img"
                  aria-label={`${ticker} ${formatPricedIn(pricedIn)} of the called move`}
                  className="block h-[10px] w-[10px] rounded-[2px]"
                  style={{ backgroundColor: pricedInColor(pricedIn) }}
                />
                <span className="w-[42px] text-right font-['Geist_Mono'] text-[10.5px] tabular-nums text-[#6b7280]">
                  {formatPricedIn(pricedIn)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {/* Why this name is here, in the engine's own reading: the link, the
          mechanism, what it should do and where the tape already is. */}
      <AnimatePresence>
        {hover && (
          <motion.div
            key={hover.target.target}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="pointer-events-none absolute inset-x-0 z-30 -translate-y-full"
            style={{ top: hover.top - 8 }}
          >
            <motion.div
              initial={{ scale: 0.96, y: 4 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.6 }}
              className="origin-bottom rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_24px_64px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            >
              {(() => {
                const x = targetExplain(hover.target, run, hover.pricedIn);
                return (
                  <>
                    <p className="line-clamp-6 text-[12px] font-medium leading-relaxed text-[#1d1b1b]">
                      {x.why}
                    </p>
                    <p
                      className="mt-2 text-[12px] font-medium leading-snug"
                      style={{ color: EXPECTED_COLOR[x.direction] }}
                    >
                      {x.expected}
                    </p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-[#6b7280]">{x.tape}</p>
                    <p className="mt-1.5 line-clamp-3 font-['Geist_Mono'] text-[10px] leading-relaxed text-[#9CA3AF]">
                      {pricedInDetail(hover.target)}
                    </p>
                  </>
                );
              })()}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function InsightCard() {
  const [runs, setRuns] = useState<PropagationRunListItem[]>([]);
  const [run, setRun] = useState<PropagationRun | null>(null);
  /** Which run the arrow has walked to; null means the best one. */
  const [cursorId, setCursorId] = useState<string | null>(null);
  // Fail closed: if the status call errors, the flag stays off. Latching this
  // to true would surface propagation content the flag says to hide.
  const [surfacing, setSurfacing] = useState(false);
  // The detail panel this card's CTA opens — an empty glass surface for now.
  const [detailOpen, setDetailOpen] = useState(false);
  // Ctrl+P: a full field of dots for presentations — the headline stays live.
  const demo = useDemoMode();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void (async () => {
        try {
          // Settled, not all: a status outage must not also blank the list.
          const [list, status] = await Promise.allSettled([
            window.meridian?.listPropagationRuns?.({ currentOnly: true, limit: 200 }),
            window.meridian?.getPropagationStatus?.(),
          ]);
          if (cancelled) return;
          if (list.status === "fulfilled" && list.value?.ok) setRuns(list.value.runs);
          setSurfacing(
            status.status === "fulfilled" && status.value?.ok
              ? status.value.status.surfacing_enabled
              : false,
          );
        } catch {
          /* card falls back to its resting copy */
        }
      })();
    };
    load();
    // A packaged build's main process finishes bootstrapping its engines a few
    // seconds after the window opens; a minute is a long time to show an empty
    // card for that. Two quick early re-asks, then the steady cadence.
    const early = [window.setTimeout(load, 3_000), window.setTimeout(load, 10_000)];
    const id = window.setInterval(load, 60_000);
    // Runs pulled from the server land after boot; re-list the moment they do.
    const unsubscribe = window.meridian?.onPropagationRunsChanged?.(load);
    return () => {
      cancelled = true;
      early.forEach((t) => window.clearTimeout(t));
      window.clearInterval(id);
      unsubscribe?.();
    };
  }, []);

  // The arrow walks this list; the card opens on its head. The cursor is kept
  // by run id, not by index, so a refresh that reorders the list doesn't jump
  // the reader to a different event.
  const ordered = useMemo(() => orderRuns(runs), [runs]);
  const cursor = useMemo(() => {
    const at = ordered.findIndex((r) => r.run_id === cursorId);
    return at >= 0 ? at : 0;
  }, [ordered, cursorId]);
  const headline = ordered[cursor] ?? null;

  /** A name in the panel's rail opens that stock — the view the search bar
   *  opens too. Sent as a window event: the card is nested well below the
   *  page that owns the view state. */
  const openTicker = useCallback((ticker: string) => {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol) return;
    setDetailOpen(false);
    window.dispatchEvent(new CustomEvent(STOCK_OPEN_EVENT, { detail: { ticker: symbol } }));
  }, []);

  const nextRun = useCallback(() => {
    if (ordered.length < 2) return;
    setCursorId(ordered[(cursor + 1) % ordered.length].run_id);
  }, [ordered, cursor]);

  // The same ring the other way. `+ length` before the modulo because JS keeps
  // the sign on a negative remainder, so stepping back from the first event
  // would land on -1 rather than the last one.
  const prevRun = useCallback(() => {
    if (ordered.length < 2) return;
    setCursorId(ordered[(cursor - 1 + ordered.length) % ordered.length].run_id);
  }, [ordered, cursor]);

  // The full run carries the event's own words; the list row only summarises.
  useEffect(() => {
    if (!headline) {
      setRun(null);
      return;
    }
    let cancelled = false;
    void window.meridian
      ?.getPropagationRun?.(headline.run_id)
      .then((res) => {
        if (!cancelled && res?.ok) setRun(res.run);
      })
      .catch(() => {
        /* keep the last good run */
      });
    return () => {
      cancelled = true;
    };
  }, [headline?.run_id]);

  // The field fills whatever width the card gives it: as many whole weeks of
  // natural-sized cells as fit, then the pitch absorbs the remainder so the
  // last column lands on the right edge. Measured, because the card is a
  // flex child and its width is not knowable up front.
  const [calWidth, setCalWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef<number | null>(null);
  const calElRef = useRef<HTMLDivElement | null>(null);
  const calRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const take = (w: number) => {
      if (w > 0) setCalWidth(w);
    };
    // `clientWidth`, not `getBoundingClientRect`: the card lives inside a
    // framer layout animation, and a rect measured mid-flight carries that
    // transform's scale. Reading the transformed width is what left the field
    // stuck at its fallback span in a card twice that wide (Kuzey,
    // 2026-08-25). `contentRect` is layout-sized for the same reason.
    calElRef.current = el;
    take(el.clientWidth);
    const frame = requestAnimationFrame(() => take(el.clientWidth));
    const ro = new ResizeObserver(([entry]) => take(entry.contentRect.width));
    ro.observe(el);
    observerRef.current = ro;
    frameRef.current = frame;
  }, []);

  // A second way in. The card's width follows the window's, and a
  // ResizeObserver that never fires (a hidden or non-compositing window) would
  // otherwise leave the field frozen at whatever it measured on mount.
  useEffect(() => {
    const onResize = () => {
      const w = calElRef.current?.clientWidth ?? 0;
      if (w > 0) setCalWidth(w);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // As many whole weeks as fit at the cells' natural size, never fewer than
  // MIN_WEEKS. The pitch then takes up the remainder so the last column lands
  // flush on the right edge — the cells keep their size, the gaps absorb it.
  const measured = calWidth > GUTTER + PITCH;
  const weeks = measured
    ? Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, Math.floor((calWidth - GUTTER) / PITCH)))
    : MIN_WEEKS;
  const pitch = measured ? (calWidth - GUTTER) / weeks : PITCH;

  // One dot per day. Rebuilt when the runs change, and keyed on the local
  // date so it rolls over at midnight rather than at UTC.
  //
  // The field is part of the card, not part of the event: it draws in every
  // state, including the resting one, so the card keeps its shape while the
  // network is quiet or the runs are still on their way.
  //
  // It is also the one thing here the surfacing flag does not gate. The flag
  // holds back the *content* — which event the card speaks for, the names it
  // reaches — and the field carries none of that: no ticker, no headline,
  // only how busy the network was on a day and how far it has travelled
  // since (Kuzey, 2026-08-25).
  const columns = useMemo(
    () =>
      demo
        ? buildDemoCalendar(
            mulberry32(demo.seed ^ 0x5eed),
            new Date(),
            weeks,
            Object.keys(demo.account.positions),
          )
        : buildCalendar(runs, new Date(), weeks),
    [runs, demo, weeks],
  );

  const live = surfacing && run != null;
  const headlineText =
    live && run
      ? `${run.root_ticker.toUpperCase()} ${run.event.label}`
      : "Nothing has moved through the network";

  // The names under the calendar follow the live run, demo or not.
  const related = useMemo(() => (live && run ? cardTargets(run, NAME_ROWS) : []), [live, run]);
  // The panel's rail has room for more of them, in the same priority order.
  const panelTargets = useMemo(() => (live && run ? cardTargets(run, PANEL_ROWS) : []), [live, run]);

  // What the detail panel needs to fetch (or commission) its write-up. Null
  // until there is a real run to explain — the demo field has nothing to say.
  const detailRequest = useMemo(
    () =>
      live && run && headlineText
        ? {
            run_id: run.run_id,
            headline: headlineText,
            root_ticker: run.root_ticker,
            event_type: run.event.type,
            event_direction: run.event.direction,
            event_materiality: run.event.materiality,
            targets: related.slice(0, 8).map((t) => ({
              ticker: (t.ticker ?? "").toUpperCase(),
              label: t.label,
              mechanism: t.mechanism,
            })),
          }
        : null,
    [live, run, headlineText, related],
  );

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      {/* Masthead — the label is set like every other card heading here,
          not as a filled pill. */}
      <div className="flex items-center justify-between">
        <span className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">
          INSIGHT
        </span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={run?.run_id ?? "resting"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="select-none font-['Geist_Mono'] text-[11px] tracking-[0.06em] text-[#9CA3AF]"
          >
            {live && run ? stamp(run.produced_at) : ""}
          </motion.span>
        </AnimatePresence>
      </div>

      <div className="flex flex-1 flex-col pt-5">
        {/* The headline explains itself: highlight a term and the market
            sense of it opens underneath. The three-line box is held open so
            stepping between events doesn't shunt the calendar up and down. */}
        <SelectionGloss ticker={run?.root_ticker} context={headlineText}>
          <div className="min-h-[92px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.h2
                // Keyed on the run, not the words: two 8-K item events share a
                // label, and an identical key would skip the transition.
                key={run?.run_id ?? "resting"}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ type: "spring", stiffness: 460, damping: 38, mass: 0.7 }}
                className="line-clamp-3 font-sans text-[24px] font-medium leading-[1.28] tracking-[-0.01em] text-[#1d1b1b]"
              >
                {headlineText}
              </motion.h2>
            </AnimatePresence>
          </div>
        </SelectionGloss>

        {columns.length > 0 && (
          <div className="mt-6">
            <div ref={calRef} className="flex justify-center">
              <Calendar columns={columns} pitch={pitch} />
            </div>
            {/* Centred legend: red = going the other way, blank = nothing yet,
                blue = the called move is in the price. */}
            <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-[#6b7280]">
              <span>Wrong way</span>
              <span className="flex items-center gap-1">
                {LEGEND_COLORS.map((color) => (
                  <span
                    key={color}
                    className="h-[8px] w-[8px] rounded-[2px] ring-1 ring-inset ring-black/[0.07]"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </span>
              <span>Priced in</span>
            </div>
          </div>
        )}

        {/* The cast, or why there isn't one. A live event with a blank space
            under it reads as a broken card; it is usually a run whose names
            the judge vetoed or the pricing layer cannot follow. */}
        {related.length > 0 && run ? (
          <RelatedNames targets={related} run={run} />
        ) : live ? (
          <p className="mt-4 text-[12px] leading-[1.5] text-[#9CA3AF]">
            No tracked counterparty carries this one.
          </p>
        ) : null}

        <div className="mt-auto flex items-stretch gap-2">
          {/* Steps back through the same ring the arrow on the right steps
              forward through. Both flank the CTA so the pair reads as one
              control, and both dim together when there is only one event. */}
          <button
            type="button"
            onClick={prevRun}
            disabled={!live || ordered.length < 2}
            aria-label="Previous propagation"
            title="Previous propagation"
            className="glass-cta app-no-drag flex w-[42px] shrink-0 items-center justify-center disabled:pointer-events-none disabled:border-white/10 disabled:bg-[#1d1b1b]/40 disabled:text-white/75 disabled:shadow-none"
          >
            <ArrowLeft size={15} strokeWidth={2} />
          </button>
          {/* Own door, own switch: this one opens the card's detail panel in
              place rather than a detail view, so it stays live. */}
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className="glass-cta app-no-drag flex-1 py-2 text-center font-sans text-[12.5px] font-medium"
          >
            View Details
          </button>
          {/* Not a dashboard CTA: this opens nothing, it steps the card to the
              next event. It stays live while the doors to the detail views are
              shut, and dims only when there is no next event to step to. */}
          <button
            type="button"
            onClick={nextRun}
            disabled={!live || ordered.length < 2}
            aria-label="Next propagation"
            title="Next propagation"
            className="glass-cta app-no-drag flex w-[42px] shrink-0 items-center justify-center disabled:pointer-events-none disabled:border-white/10 disabled:bg-[#1d1b1b]/40 disabled:text-white/75 disabled:shadow-none"
          >
            <ArrowRight size={15} strokeWidth={2} />
          </button>
        </div>
      </div>

      <InsightDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        headline={headlineText}
        request={detailRequest}
        rootTicker={live && run ? run.root_ticker : undefined}
        targets={panelTargets}
        onPickTicker={openTicker}
      />
    </div>
  );
}
