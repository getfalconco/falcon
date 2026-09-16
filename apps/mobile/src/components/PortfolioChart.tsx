import { useEffect, useMemo, useState } from "react";
import {
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Line, Rect } from "react-native-svg";
import {
  usePortfolioBalance,
  useRecordedSeries,
  type SeriesPoint,
} from "@/lib/use-portfolio-balance";
import { demoValueSeries, useDemoMode } from "@/lib/demo-mode";
import { FONTS, PRODUCT, PTYPE } from "@/theme";

export const TIMEFRAMES = ["Day", "Week", "Month", "Quarter", "Year"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const TIMEFRAME_DAYS: Record<Timeframe, number> = {
  Day: 1,
  Week: 7,
  Month: 30,
  Quarter: 90,
  Year: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const BUCKET_MS: Record<Timeframe, number> = {
  Day: 60_000,
  Week: 15 * 60_000,
  Month: 60 * 60_000,
  Quarter: 6 * 60 * 60_000,
  Year: DAY_MS,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_BARS = 52;
const MAX_X_LABELS = 5;
const CHART_H = 200;
const PAD_TOP = 16;
const PAD_BOTTOM = 8;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const BAR_GAP = 0.18;
const X_AXIS_H = 22;

function domainStartFor(timeframe: Timeframe, now: number): number {
  if (timeframe === "Day") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - TIMEFRAME_DAYS[timeframe] * DAY_MS;
}

function niceStep(range: number): number {
  const raw = range / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const norm = raw / mag;
  const mult = norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1;
  return mult * mag;
}

function fmtTick(v: number, fine = false): string {
  if (Math.abs(v) < 1e-9) return "0";
  const trim = (n: number) => n.toFixed(fine ? 2 : 1).replace(/\.?0+$/, "");
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(v / 1_000)}k`;
  return `${Math.round(v)}`;
}

function fmtBarLabel(t: number, timeframe: Timeframe): string {
  const d = new Date(t);
  if (timeframe === "Day") {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (timeframe === "Week") {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Keep endpoints; thin middle so phones stay readable. */
function downsample(points: SeriesPoint[], max: number): SeriesPoint[] {
  if (points.length <= max) return points;
  const out: SeriesPoint[] = [];
  const last = points.length - 1;
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i / (max - 1)) * last);
    out.push(points[idx]);
  }
  return out;
}

type BarGeom = {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  value: number;
  t: number;
  label: string;
};

export function TimeframeControls({
  value,
  onChange,
}: {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
}) {
  return (
    <View style={styles.tfRow}>
      {TIMEFRAMES.map((tf) => {
        const active = tf === value;
        return (
          <Pressable key={tf} onPress={() => onChange(tf)} hitSlop={8} style={styles.tfBtn}>
            <Text style={[styles.tfLabel, active && styles.tfLabelActive]}>{tf}</Text>
            {active ? <View style={styles.tfUnderline} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Home portfolio chart — vertical bar chart (visx demo look) via react-native-svg.
 * Full-width via onLayout; scrub updates hero networth.
 */
export default function PortfolioChart({
  timeframe,
  masked = false,
  refreshKey: _refreshKey = 0,
  onScrub,
  // Kept for dashboard API compat; bar view uses a single series.
  showGrowth: _showGrowth = true,
  showSp500: _showSp500 = true,
}: {
  timeframe: Timeframe;
  showGrowth?: boolean;
  showSp500?: boolean;
  masked?: boolean;
  refreshKey?: number;
  onScrub?: (value: number | null) => void;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [layoutW, setLayoutW] = useState(0);

  const { balance, balanceReady } = usePortfolioBalance();
  const { history, intraday, cloudSnaps } = useRecordedSeries();
  const demo = useDemoMode();

  const series = useMemo<SeriesPoint[]>(() => {
    // Desktop Ctrl+P: fake growth curve ending at the live demo balance.
    if (demo && balanceReady && Number.isFinite(balance)) {
      return downsample(
        demoValueSeries(demo.seed, TIMEFRAME_DAYS[timeframe], balance),
        MAX_BARS,
      );
    }

    const now = Date.now();
    const domainStart = domainStartFor(timeframe, now);
    const bucket = BUCKET_MS[timeframe];
    const byBucket = new Map<number, SeriesPoint>();

    for (const p of history) {
      const t = new Date(`${p.date}T12:00:00`).getTime();
      if (Number.isFinite(t) && t >= domainStart && t <= now) {
        byBucket.set(Math.floor(t / bucket), { t, value: p.value });
      }
    }
    for (const snap of cloudSnaps) {
      const t = new Date(snap.ts).getTime();
      if (!Number.isFinite(t) || t < domainStart) continue;
      byBucket.set(Math.floor(t / bucket), { t, value: snap.value });
    }
    for (const p of intraday) {
      if (p.t >= domainStart) byBucket.set(Math.floor(p.t / bucket), p);
    }
    if (balanceReady && Number.isFinite(balance)) {
      byBucket.set(Math.floor(now / bucket), { t: now, value: balance });
    }

    const out = [...byBucket.values()].sort((a, b) => a.t - b.t);
    if (out.length > 0 && out[0].t > domainStart) {
      out.unshift({ t: domainStart, value: out[0].value });
    }
    return downsample(out, MAX_BARS);
  }, [balance, balanceReady, timeframe, cloudSnaps, history, intraday, demo]);

  const chart = useMemo(() => {
    if (series.length === 0 || layoutW <= 0) return null;

    const innerW = Math.max(1, layoutW - PAD_LEFT - PAD_RIGHT);
    const innerH = CHART_H - PAD_TOP - PAD_BOTTOM;
    const n = series.length;
    const band = innerW / n;
    const gap = band * BAR_GAP;
    const barW = Math.max(1.5, band - gap);

    let min = Math.min(...series.map((p) => p.value));
    let max = Math.max(...series.map((p) => p.value));
    if (min === max) {
      min -= Math.abs(min) * 0.05 || 1;
      max += Math.abs(max) * 0.05 || 1;
    } else {
      const pad = (max - min) * 0.12;
      min = Math.max(0, min - pad * 0.25);
      max += pad;
    }
    const yAt = (v: number) =>
      PAD_TOP + innerH - ((v - min) / (max - min)) * innerH;

    const bars: BarGeom[] = series.map((p, i) => {
      const x = PAD_LEFT + i * band + gap / 2;
      const y = yAt(p.value);
      const h = Math.max(1, PAD_TOP + innerH - y);
      return {
        index: i,
        x,
        y,
        w: barW,
        h,
        cx: x + barW / 2,
        value: p.value,
        t: p.t,
        label: fmtBarLabel(p.t, timeframe),
      };
    });

    const step = niceStep(max - min);
    const fine = step < 100;
    const gridYs: Array<{ y: number; label: string }> = [];
    let lastLabel: string | null = null;
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
      const label = fmtTick(v, fine);
      if (label === lastLabel) continue;
      gridYs.push({ y: yAt(v), label });
      lastLabel = label;
    }

    const pickXLabels = (
      items: BarGeom[],
      maxLabels: number,
      minGap: number,
    ): Array<{ x: number; label: string }> => {
      if (items.length === 0) return [];
      if (items.length === 1) {
        return [{ x: items[0].cx, label: items[0].label }];
      }

      const slots = Math.min(maxLabels, items.length);
      const picked: BarGeom[] = [];
      for (let i = 0; i < slots; i++) {
        const idx = Math.round((i / (slots - 1)) * (items.length - 1));
        picked.push(items[idx]);
      }

      const out: Array<{ x: number; label: string }> = [];
      for (const b of picked) {
        const prev = out[out.length - 1];
        if (prev && prev.label === b.label) continue;
        if (prev && Math.abs(b.cx - prev.x) < minGap) continue;
        out.push({ x: b.cx, label: b.label });
      }

      return out;
    };

    const xLabels = pickXLabels(bars, MAX_X_LABELS, Math.max(48, layoutW / 7));

    return { bars, gridYs, xLabels, innerH };
  }, [series, layoutW, timeframe]);

  const snapHover = (locationX: number) => {
    if (!chart) return;
    let best = chart.bars[0];
    let bestDist = Infinity;
    for (const b of chart.bars) {
      const d = Math.abs(b.cx - locationX);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    setHoverIndex(best.index);
    onScrub?.(best.value);
  };

  const onTouch = (e: GestureResponderEvent) => {
    snapHover(e.nativeEvent.locationX);
  };

  if (!balanceReady) {
    return <View style={styles.loading} />;
  }

  if (series.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No portfolio history yet</Text>
      </View>
    );
  }

  const hover = hoverIndex != null && chart ? chart.bars[hoverIndex] : null;
  const someoneHovered = hoverIndex != null;

  return (
    <View style={styles.root}>
      <View
        style={styles.plot}
        onLayout={(e) => setLayoutW(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onTouch}
        onResponderMove={onTouch}
        onResponderRelease={() => {
          setHoverIndex(null);
          onScrub?.(null);
        }}
      >
        {layoutW > 0 && chart ? (
          <>
            <Svg width={layoutW} height={CHART_H}>
              {chart.gridYs.map((g, i) => (
                <Line
                  key={`g-${i}`}
                  x1={PAD_LEFT}
                  y1={g.y}
                  x2={layoutW - PAD_RIGHT}
                  y2={g.y}
                  stroke={PRODUCT.chart.axis}
                  strokeOpacity={0.28}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
              ))}

              {chart.bars.map((b) => {
                const faded = someoneHovered && b.index !== hoverIndex;
                return (
                  <Rect
                    key={b.index}
                    x={b.x}
                    y={b.y}
                    width={b.w}
                    height={b.h}
                    fill={PRODUCT.chart.value}
                    fillOpacity={faded ? 0.28 : 1}
                  />
                );
              })}

              {hover ? (
                <Line
                  x1={hover.cx}
                  y1={PAD_TOP}
                  x2={hover.cx}
                  y2={PAD_TOP + chart.innerH}
                  stroke="rgba(0,0,0,0.2)"
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
              ) : null}
            </Svg>

            <View style={[styles.xAxis, { width: layoutW, height: X_AXIS_H }]}>
              {chart.xLabels.map((tick) => (
                <Text
                  key={`${tick.label}@${Math.round(tick.x)}`}
                  numberOfLines={1}
                  style={[
                    styles.xTick,
                    {
                      left: tick.x,
                      transform: [{ translateX: -28 }],
                      width: 56,
                    },
                  ]}
                >
                  {tick.label}
                </Text>
              ))}
            </View>
          </>
        ) : (
          <View style={{ height: CHART_H + X_AXIS_H }} />
        )}

        {hover && !masked ? (
          <View
            pointerEvents="none"
            style={[
              styles.tooltip,
              {
                left: Math.min(Math.max(hover.cx - 56, 4), Math.max(4, layoutW - 116)),
                top: Math.max(4, hover.y - 44),
              },
            ]}
          >
            <Text style={styles.tooltipTitle}>{hover.label}</Text>
            <Text style={styles.tooltipValue}>{fmtTick(hover.value, true)}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: "100%",
  },
  tfRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  tfBtn: { alignItems: "center", paddingBottom: 4 },
  tfLabel: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    color: PRODUCT.chart.axis,
  },
  tfLabelActive: {
    fontFamily: FONTS.sansMedium,
    color: PRODUCT.fg,
  },
  tfUnderline: {
    marginTop: 4,
    height: 1,
    alignSelf: "stretch",
    backgroundColor: PRODUCT.fg,
  },
  plot: {
    width: "100%",
    position: "relative",
  },
  xAxis: {
    position: "relative",
    marginTop: 6,
  },
  xTick: {
    position: "absolute",
    top: 0,
    textAlign: "center",
    fontFamily: FONTS.sans,
    fontSize: 10,
    letterSpacing: 0.2,
    color: PRODUCT.chart.axis,
    opacity: 0.45,
  },
  tooltip: {
    position: "absolute",
    minWidth: 100,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: PRODUCT.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.border,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  tooltipTitle: {
    fontFamily: FONTS.sans,
    fontSize: 11,
    color: PRODUCT.fgMuted,
    marginBottom: 2,
  },
  tooltipValue: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    color: PRODUCT.fg,
  },
  loading: { height: CHART_H },
  empty: { height: 160, alignItems: "center", justifyContent: "center" },
  emptyText: { ...PTYPE.small },
});
