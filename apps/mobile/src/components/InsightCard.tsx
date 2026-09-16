import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import Svg, { Rect, Text as SvgText } from "react-native-svg";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import GlassPanel from "@/components/GlassPanel";
import PressableScale from "@/components/PressableScale";
import StockIcon from "@/components/StockIcon";
import {
  getPropagationRun,
  isEngineEnabled,
  isPropagationSurfacing,
  listPropagationRuns,
} from "@/lib/engine";
import {
  buildCalendar,
  cardTargets,
  dayColor,
  formatPricedIn,
  LEGEND_COLORS,
  livePricedIn,
  monthTicks,
  orderRuns,
  pricedInColor,
  targetPricedIn,
  WEEKDAY_TICKS,
  type PropagationRun,
  type PropagationRunListItem,
  type PropagationTarget,
} from "@/lib/propagation-runs";
import { timeAgo } from "@/lib/signals";
import { formatStockPrice, getStockQuote } from "@/lib/stock-quote";
import { FONTS, PRODUCT, PTYPE, RADIUS } from "@/theme";

/**
 * Editorial card: the most consequential propagation the engine has run, in
 * its own words, over a field of dots — one per day, red where the called move
 * went the wrong way and blue where the market has taken it in.
 *
 * Both clients read the same runs from the same box: the always-on engine
 * service (apps/falcon-engine on Railway). The desktop asks its main process,
 * which forwards to the service; the phone asks the service directly over
 * HTTP with the user's own Supabase token — see @/lib/engine. The selection
 * and the calendar are the desktop's own functions, ported in
 * @/lib/propagation-runs, so the two cards cannot disagree about which event
 * leads or what a day's colour means (docs/PLATFORM_PARITY.md §4–5).
 */

/** Field geometry, verbatim from the desktop card so a day reads the same
 *  size on both — one week across, the cell drawn inside it, and corners
 *  barely rounded (enough to soften, not enough to read as dots). */
const PITCH = 13;
const CELL = 10;
const CELL_RADIUS = 2;
/** Room for the weekday column on the left and the month row on top. */
const GUTTER = 20;
const BAND = 13;
const LABEL = "#9CA3AF";
/** 8pt is what the desktop uses, and it is also the largest that keeps "Wed"
 *  inside the gutter. */
const LABEL_SIZE = 8;
/** Four and a half months, and never more than a year. A phone is narrower
 *  than the desk card, so it lands near the floor rather than the ceiling. */
const MIN_WEEKS = 19;
const MAX_WEEKS = 52;

/** Names under the headline — the desktop card's NAME_ROWS. */
const NAME_ROWS = 4;

/** The engine's own cadence is minutes; a minute is close enough to live. */
const REFRESH_MS = 60_000;

/**
 * Stepping to the next event is a move, not a swap: how far the event travels
 * as it leaves and arrives, and the desktop card's own spring
 * (AnimatePresence mode="wait" — one leaves before the next arrives, rather
 * than the two crossfading through each other).
 */
const STEP_X = 16;
const STEP_OUT_MS = 130;
const STEP_IN_MS = 160;
const STEP_SPRING = { stiffness: 460, damping: 38, mass: 0.7 } as const;

export default function InsightCard({ minHeight = 0 }: { minHeight?: number }) {
  const router = useRouter();
  const [runs, setRuns] = useState<PropagationRunListItem[] | null>(null);
  const [run, setRun] = useState<PropagationRun | null>(null);
  /** Which run the arrow has walked to; null means the best one. */
  const [cursorId, setCursorId] = useState<string | null>(null);
  // Fail closed: while the flag is unread the card stays at rest, because
  // latching it on would surface what the flag exists to hold back.
  const [surfacing, setSurfacing] = useState(false);
  const [fieldWidth, setFieldWidth] = useState(0);

  // Full runs kept by id: the arrow walks back and forth over the same few
  // events, and each one is a round trip.
  const runCache = useRef(new Map<string, PropagationRun>());

  useEffect(() => {
    if (!isEngineEnabled()) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      // Settled, not all: a status outage must not also blank the field.
      void Promise.allSettled([listPropagationRuns(200), isPropagationSurfacing()]).then(
        ([list, flag]) => {
          if (cancelled) return;
          // A newer list means newer pricing on every run, so what was
          // fetched against the last one is stale. The event on screen keeps
          // its words; the prefetch above refills for the next step.
          if (list.status === "fulfilled") runCache.current.clear();
          setRuns(list.status === "fulfilled" ? list.value : []);
          setSurfacing(flag.status === "fulfilled" ? flag.value : false);
        },
      );
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // The arrow walks this list; the card opens on its head. The cursor is kept
  // by run id, not by index, so a refresh that reorders the list doesn't jump
  // the reader to a different event.
  const ordered = useMemo(() => orderRuns(runs ?? []), [runs]);
  const cursor = useMemo(() => {
    const at = ordered.findIndex((r) => r.run_id === cursorId);
    return at >= 0 ? at : 0;
  }, [ordered, cursorId]);
  const headline = ordered[cursor] ?? null;

  // The full run carries the event's own words; the list row only summarises.
  useEffect(() => {
    if (!headline) {
      setRun(null);
      return;
    }
    const cached = runCache.current.get(headline.run_id);
    if (cached) {
      setRun(cached);
      return;
    }
    let cancelled = false;
    void getPropagationRun(headline.run_id)
      .then((next) => {
        if (cancelled || !next) return;
        runCache.current.set(next.run_id, next);
        setRun(next);
      })
      .catch(() => {
        /* keep the last good run */
      });
    return () => {
      cancelled = true;
    };
  }, [headline?.run_id]);

  // The event the arrow would go to, fetched before it is asked for. Without
  // this the step waits on a round trip and the tap reads as a dropped one:
  // the words only leave once the next event's have arrived.
  useEffect(() => {
    if (ordered.length < 2) return;
    const next = ordered[(cursor + 1) % ordered.length]!;
    if (runCache.current.has(next.run_id)) return;
    let cancelled = false;
    void getPropagationRun(next.run_id)
      .then((full) => {
        if (!cancelled && full) runCache.current.set(full.run_id, full);
      })
      .catch(() => {
        /* the step falls back to fetching on demand */
      });
    return () => {
      cancelled = true;
    };
  }, [ordered, cursor]);

  // What is actually on screen. It trails `run` by one step: when the reader
  // walks to another event, the current one leaves first and this only becomes
  // the new one once it has gone, so the words never change mid-flight.
  const [shown, setShown] = useState<PropagationRun | null>(null);
  const pending = useRef<PropagationRun | null>(null);
  const fade = useSharedValue(1);
  const slide = useSharedValue(0);

  const commitPending = useCallback(() => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setShown(next);
    // Placed off to the right, then sprung home — the arrival half of the step.
    slide.value = STEP_X;
    fade.value = withTiming(1, { duration: STEP_IN_MS });
    slide.value = withSpring(0, STEP_SPRING);
  }, [fade, slide]);

  useEffect(() => {
    if (!run) {
      setShown(null);
      return;
    }
    // The first event, or the same one read again: nothing to travel.
    if (!shown || shown.run_id === run.run_id) {
      setShown(run);
      return;
    }
    pending.current = run;
    fade.value = withTiming(0, { duration: STEP_OUT_MS });
    slide.value = withTiming(-STEP_X, { duration: STEP_OUT_MS }, (finished) => {
      "worklet";
      if (finished) runOnJS(commitPending)();
    });
  }, [run, shown, commitPending, fade, slide]);

  /** The event block travels; the field below it belongs to the card, not to
   *  any one event, so it stays put. */
  const stepStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ translateX: slide.value }],
  }));
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  // As many whole weeks as fit at the cells' natural size; the pitch then
  // takes up the remainder so the grid lands flush on both edges instead of
  // stretching the squares — the desktop card measures itself the same way.
  const measured = fieldWidth > GUTTER + PITCH;
  const weeks = measured
    ? Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, Math.floor((fieldWidth - GUTTER) / PITCH)))
    : MIN_WEEKS;
  const pitch = measured ? (fieldWidth - GUTTER) / weeks : PITCH;

  // The field is part of the card, not part of the event: it draws in every
  // state, and it is the one thing the surfacing flag does not gate — it
  // carries no ticker and no headline, only how busy the network was on a day
  // and how far it has travelled since.
  const columns = useMemo(
    () => (runs && measured ? buildCalendar(runs, new Date(), weeks) : []),
    [runs, measured, weeks],
  );
  const months = useMemo(() => monthTicks(columns), [columns]);

  const live = surfacing && shown != null;
  const headlineText = live && shown
    ? `${shown.root_ticker.toUpperCase()} ${shown.event.label}`
    : runs === null
      ? "Reading the network\u2026"
      : "Nothing has moved through the network";

  const related = useMemo(
    () => (live && shown ? cardTargets(shown, NAME_ROWS) : []),
    [live, shown],
  );

  const nextRun = useCallback(() => {
    if (ordered.length < 2) return;
    setCursorId(ordered[(cursor + 1) % ordered.length]!.run_id);
  }, [ordered, cursor]);

  const onField = (e: LayoutChangeEvent) => {
    const w = Math.floor(e.nativeEvent.layout.width);
    if (w > 0 && w !== fieldWidth) setFieldWidth(w);
  };

  return (
    <GlassPanel
      style={[styles.panel, minHeight > 0 && { minHeight }]}
      fill={minHeight > 0}
    >
      <View style={styles.masthead}>
        <Text style={styles.label}>INSIGHT</Text>
        <Animated.Text style={[styles.stamp, fadeStyle]}>
          {live && shown ? timeAgo(shown.produced_at) : ""}
        </Animated.Text>
      </View>

      <Animated.Text style={[styles.headline, stepStyle]} numberOfLines={3}>
        {headlineText}
      </Animated.Text>

      <View style={styles.field} onLayout={onField}>
        {columns.length > 0 ? (
          <Svg
            width={GUTTER + columns.length * pitch}
            height={BAND + 7 * pitch}
            accessibilityRole="image"
            accessibilityLabel="Propagation days"
          >
            {/* Months across the top, weekdays down the left — the two axes
                that make a heatmap readable as a calendar. */}
            {months.map((tick) => (
              <SvgText
                key={`${tick.column}-${tick.label}`}
                x={GUTTER + tick.column * pitch}
                y={BAND - 4}
                fontSize={LABEL_SIZE}
                fontFamily={FONTS.mono}
                fill={LABEL}
              >
                {tick.label}
              </SvgText>
            ))}
            {WEEKDAY_TICKS.map((tick) => (
              <SvgText
                key={tick.label}
                x={GUTTER - 5}
                y={BAND + tick.row * pitch + pitch / 2 + 2.8}
                fontSize={LABEL_SIZE}
                fontFamily={FONTS.mono}
                fill={LABEL}
                textAnchor="end"
              >
                {tick.label}
              </SvgText>
            ))}
            {columns.map((column, w) =>
              column.map((cell, d) => (
                <Rect
                  key={cell.date}
                  x={GUTTER + w * pitch + (pitch - CELL) / 2}
                  y={BAND + d * pitch + (pitch - CELL) / 2}
                  width={CELL}
                  height={CELL}
                  rx={CELL_RADIUS}
                  fill={dayColor(cell)}
                />
              )),
            )}
          </Svg>
        ) : null}
      </View>

      {columns.length > 0 ? (
        <View style={styles.legend}>
          <Text style={styles.legendText}>Wrong way</Text>
          <View style={styles.legendSwatches}>
            {LEGEND_COLORS.map((color) => (
              <View key={color} style={[styles.swatch, { backgroundColor: color }]} />
            ))}
          </View>
          <Text style={styles.legendText}>Priced in</Text>
        </View>
      ) : null}

      {/* The cast, or why there isn't one. A live event with a blank space
          under it reads as a broken card; it is usually a run whose names the
          judge vetoed or the pricing layer cannot follow. */}
      {live ? (
        <Animated.View style={stepStyle}>
          {related.length > 0 ? (
            <RelatedNames targets={related} />
          ) : (
            <Text style={styles.noCast}>No tracked counterparty carries this one.</Text>
          )}
        </Animated.View>
      ) : null}

      <View style={styles.footer}>
        {/* The desktop opens a detail panel in place; the phone opens the
            Insight tab instead. Not gated on a run: the page stands on its
            own, so this stays a door even while the network is quiet. */}
        <PressableScale
          onPress={() =>
            router.push(
              shown
                ? { pathname: "/insight", params: { run: shown.run_id } }
                : "/insight",
            )
          }
          style={styles.cta}
          pressedStyle={styles.ctaHeld}
        >
          <Text style={styles.ctaText}>View Details</Text>
        </PressableScale>
        {/* This opens nothing — it steps the card to the next event, and dims
            only when there is no next one to step to. */}
        <PressableScale
          onPress={nextRun}
          disabled={!live || ordered.length < 2}
          style={[styles.next, (!live || ordered.length < 2) && styles.ctaOff]}
          pressedStyle={styles.ctaHeld}
          accessibilityLabel="Next propagation"
        >
          <Feather name="arrow-right" size={15} color={PRODUCT.ctaFg} />
        </PressableScale>
      </View>
    </GlassPanel>
  );
}

type RelatedQuote = { price: number; changePercent: number | null };

/**
 * Live price + day change for the related names. The desktop refreshes these
 * every 5 seconds off its own live-quote channel; the phone's quote helper
 * caches for a minute and the rest of this dashboard beats at the same rate,
 * so asking faster here would only re-read the same cache.
 */
function useRelatedQuotes(symbolsKey: string): Record<string, RelatedQuote> {
  const [quotes, setQuotes] = useState<Record<string, RelatedQuote>>({});

  useEffect(() => {
    const list = symbolsKey ? symbolsKey.split(",").filter(Boolean) : [];
    if (list.length === 0) {
      setQuotes({});
      return;
    }
    let cancelled = false;

    const load = () => {
      void Promise.all(
        list.map(async (s) => {
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
        }),
      ).then((entries) => {
        if (cancelled) return;
        const next: Record<string, RelatedQuote> = {};
        for (const e of entries) if (e && e[1].price > 0) next[e[0]] = e[1];
        setQuotes(next);
      });
    };

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbolsKey]);

  return quotes;
}

/**
 * The names the event reaches: logo, ticker, live price and day change on the
 * left; on the right a bar that fills with the share of the called move the
 * name has travelled. It takes its colour from the calendar's own ramp: red
 * while the name goes the other way, deepening blue as the call lands. The
 * bar caps at full — an overshoot has nowhere further to go, and the exact
 * figure stays in the row's accessibility label.
 *
 * The desktop explains a row on hover (`targetExplain`). A phone has no
 * hover, so the row is a door instead: it opens that name's relationship
 * graph.
 */
/**
 * How full the bar reads. A name that has moved a little must not read as a
 * name that has not moved at all, so anything non-zero keeps a visible sliver;
 * an overshoot has nowhere past full to go.
 */
function barFill(pricedIn: number | null | undefined): number {
  if (pricedIn == null || !Number.isFinite(pricedIn) || pricedIn === 0) return 0;
  return Math.max(0.06, Math.min(1, Math.abs(pricedIn)));
}

function RelatedNames({ targets }: { targets: PropagationTarget[] }) {
  const router = useRouter();
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
  if (targets.length === 0) return null;

  return (
    <View style={styles.cast} accessibilityLabel="Related names">
      {targets.map((t) => {
        const ticker = (t.ticker ?? "").toUpperCase();
        const q = quotes[ticker];
        // Live where the quote allows it, the engine's last sweep otherwise.
        const pricedIn = livePricedIn(t, q?.price) ?? targetPricedIn(t);
        const chg = q?.changePercent ?? null;
        const chgColor =
          chg == null || chg === 0 ? PRODUCT.fgMuted : chg > 0 ? PRODUCT.gain : PRODUCT.loss;
        return (
          <Pressable
            key={t.target}
            onPress={() => router.push(`/graph/${ticker}`)}
            style={({ pressed }) => [styles.nameRow, pressed && styles.nameRowPressed]}
            accessibilityRole="button"
            accessibilityLabel={`${ticker}, ${formatPricedIn(pricedIn)} of the called move`}
          >
            <StockIcon symbol={ticker} size={18} />
            <Text style={styles.nameTicker}>{ticker}</Text>
            <Text style={styles.namePrice}>{q ? formatStockPrice(q.price) : "—"}</Text>
            {chg != null ? (
              <Text style={[styles.nameChange, { color: chgColor }]}>
                {chg >= 0 ? "↑" : "↓"} {Math.abs(chg).toFixed(2)}%
              </Text>
            ) : null}
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.barFill,
                  {
                    width: `${barFill(pricedIn) * 100}%`,
                    backgroundColor: pricedInColor(pricedIn),
                  },
                ]}
              />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Desktop `.glass-cta`: fill, hairline highlight, drop, and the black ring. */
const CTA_INK = "#1d1b1b";
/** Same step down COLORS.inkButton takes to inkButtonHover under a press. */
const CTA_INK_HELD = "#0f0d0b";
const CTA_SHADOW = [
  { offsetX: 0, offsetY: 1, blurRadius: 0, color: "rgba(255,255,255,0.20)", inset: true },
  { offsetX: 0, offsetY: 1, blurRadius: 3, color: "rgba(0,0,0,0.14)" },
  { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 1, color: "rgba(0,0,0,0.06)" },
];

const styles = StyleSheet.create({
  // No outer margin: the module stack sets the gap between cards, and a
  // margin inside the context menu's host is measured away by SwiftUI.
  panel: {},
  masthead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { ...PTYPE.microLabel },
  stamp: { fontFamily: FONTS.mono, fontSize: 11, color: PRODUCT.fgSubtle },
  headline: {
    fontFamily: FONTS.sansMedium,
    fontSize: 21,
    lineHeight: 27,
    letterSpacing: -0.2,
    color: PRODUCT.fg,
    marginTop: 16,
  },
  field: { marginTop: 20, alignItems: "center" },
  legend: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  legendText: { fontFamily: FONTS.sans, fontSize: 11, color: PRODUCT.fgMuted },
  legendSwatches: { flexDirection: "row", alignItems: "center", gap: 3 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  cast: { marginTop: 16, gap: 6 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: RADIUS.control },
  nameRowPressed: { opacity: 0.6 },
  nameTicker: { fontFamily: FONTS.sansMedium, fontSize: 12.5, color: PRODUCT.fg },
  namePrice: { fontFamily: FONTS.sans, fontSize: 12, color: PRODUCT.fgBody, marginLeft: 2 },
  nameChange: { fontFamily: FONTS.sansMedium, fontSize: 11.5 },
  barTrack: {
    marginLeft: "auto",
    width: 56,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(0,0,0,0.07)",
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: 3 },
  noCast: { ...PTYPE.small, marginTop: 16 },
  footer: { flexDirection: "row", gap: 8, marginTop: "auto", paddingTop: 20 },
  /**
   * The desktop's `.glass-cta`, ported (renderer/globals.css). The fill is
   * #1d1b1b — the ink the headline is set in, so the buttons read as the same
   * family as the type. What makes it glass rather than a flat slab is the
   * edge: a hairline white border with an inner top highlight, over a black
   * ring, so it catches light the way the card frames do.
   */
  cta: {
    flex: 1,
    height: 40,
    borderRadius: RADIUS.control,
    borderCurve: "continuous",
    backgroundColor: CTA_INK,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    boxShadow: CTA_SHADOW,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaOff: { opacity: 0.4 },
  /** Held: the fill steps down, the way the onboarding CTA's does. */
  ctaHeld: { backgroundColor: CTA_INK_HELD },
  ctaText: { fontFamily: FONTS.sansMedium, fontSize: 12.5, color: "#ffffff" },
  next: {
    width: 44,
    height: 40,
    borderRadius: RADIUS.control,
    borderCurve: "continuous",
    backgroundColor: CTA_INK,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    boxShadow: CTA_SHADOW,
    alignItems: "center",
    justifyContent: "center",
  },
});
