import { useEffect, useMemo } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams } from "expo-router";
import Svg, { Line, Path, Text as SvgText } from "react-native-svg";
import type { BacktestResult, CurveMetrics, StrategyMetrics } from "@falcon/backtest";
import { describeStrategy } from "@falcon/backtest/describe";
import { eventStudyFromHistory, hasNoHistorySource, strategyFromSighting, type HistoryStudy } from "@falcon/backtest/sighting";
import { SecondaryButton } from "@/components/Buttons";
import { PushedScreen } from "@/components/PushedScreen";
import { Reveal } from "@/components/Reveal";
import { useBacktest } from "@/lib/backtest";
import { useSightingCard } from "@/lib/sightings";
import { EmptyTitle, SkeletonCard } from "@/features/sightings/parts";
import { cardStyles } from "@/features/sightings/SightingCard";
import { GUTTER, colors, fonts } from "@/theme";

/** The phone frame's width in the browser preview; the real width on the phone. */
const PREVIEW_WIDTH = 393;
const SPY_COLOR = "#a3a39e";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

const isStrategy = (m: StrategyMetrics | CurveMetrics): m is StrategyMetrics => "tradeCount" in m;

const ROWS: { label: string; value: (m: StrategyMetrics | CurveMetrics) => string }[] = [
  { label: "Total return", value: (m) => pct(m.totalReturnPct) },
  { label: "Annual return", value: (m) => pct(m.annualizedReturnPct) },
  { label: "Sharpe", value: (m) => (m.sharpe === null ? "n/a" : m.sharpe.toFixed(2)) },
  { label: "Max drawdown", value: (m) => (m.maxDrawdownPct > 0 ? `-${m.maxDrawdownPct.toFixed(1)}%` : "0.0%") },
  { label: "Win rate", value: (m) => (isStrategy(m) ? (m.winRatePct === null ? "n/a" : `${m.winRatePct.toFixed(0)}%`) : "-") },
  { label: "Trades", value: (m) => (isStrategy(m) ? String(m.tradeCount) : "-") },
];

/** Percent return of the strategy and of SPY, as two SVG paths on one axis. */
function Curve({ result, width }: { result: BacktestResult; width: number }) {
  const height = 150;
  const pad = { top: 8, bottom: 20, left: 0, right: 0 };
  const geo = useMemo(() => {
    const eq = result.equity;
    const s0 = result.metrics.strategy.startValue || 1;
    const b0 = result.metrics.benchmark.startValue || 1;
    const sv = eq.map((p) => (p.strategy / s0 - 1) * 100);
    const bv = eq.map((p) => (p.benchmark / b0 - 1) * 100);
    let lo = 0;
    let hi = 0;
    for (const v of [...sv, ...bv]) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo || 10;
    lo -= span * 0.05;
    hi += span * 0.05;
    const n = eq.length;
    const plotH = height - pad.top - pad.bottom;
    const x = (i: number) => pad.left + (n > 1 ? (i / (n - 1)) * (width - pad.left - pad.right) : 0);
    const y = (v: number) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;
    const stride = Math.max(1, Math.floor(n / (width * 1.5)));
    const path = (vals: number[]) => {
      let d = "";
      for (let i = 0; i < n; i += stride) d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(vals[i]!).toFixed(1)}`;
      if ((n - 1) % stride !== 0) d += `L${x(n - 1).toFixed(1)},${y(vals[n - 1]!).toFixed(1)}`;
      return d;
    };
    return { s: path(sv), b: path(bv), zero: y(0), first: eq[0]?.date ?? "", last: eq[n - 1]?.date ?? "" };
  }, [result, width, pad.bottom, pad.left, pad.right, pad.top]);

  return (
    <Svg width={width} height={height} accessibilityLabel="Equity curve of the rules and of SPY">
      <Line x1={0} x2={width} y1={geo.zero} y2={geo.zero} stroke="rgba(0,0,0,0.14)" strokeWidth={1} />
      <Path d={geo.b} stroke={SPY_COLOR} strokeWidth={1.5} fill="none" strokeLinejoin="round" />
      <Path d={geo.s} stroke={colors.ink} strokeWidth={2} fill="none" strokeLinejoin="round" />
      <SvgText x={0} y={height - 4} fontSize={10.5} fill={colors.placeholder} fontFamily={fonts.mono}>
        {geo.first.slice(0, 4)}
      </SvgText>
      <SvgText x={width} y={height - 4} fontSize={10.5} fill={colors.placeholder} fontFamily={fonts.mono} textAnchor="end">
        {geo.last.slice(0, 4)}
      </SvgText>
    </Svg>
  );
}

function Results({ result, width, notes }: { result: BacktestResult; width: number; notes: string[] }) {
  const s = result.metrics.strategy;
  const b = result.metrics.benchmark;
  return (
    <>
      <Reveal order={2} style={styles.card}>
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: colors.ink }]} />
            <Text style={styles.legendText}>These rules {pct(s.totalReturnPct)}</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: SPY_COLOR }]} />
            <Text style={styles.legendText}>SPY {pct(b.totalReturnPct)}</Text>
          </View>
        </View>
        <View style={styles.curve}>
          <Curve result={result} width={width - 36} />
        </View>
      </Reveal>

      <Reveal order={3} style={[styles.card, styles.table]}>
        <View style={styles.row}>
          <Text style={[styles.cell, styles.head, styles.labelCell]} />
          <Text style={[styles.cell, styles.head]}>These rules</Text>
          <Text style={[styles.cell, styles.head]}>SPY</Text>
        </View>
        {ROWS.map((r) => (
          <View key={r.label} style={[styles.row, styles.rowDivider]}>
            <Text style={[styles.cell, styles.labelCell]}>{r.label}</Text>
            <Text style={[styles.cell, styles.value]}>{r.value(s)}</Text>
            <Text style={[styles.cell, styles.value, styles.muted]}>{r.value(b)}</Text>
          </View>
        ))}
      </Reveal>

      <Reveal order={4}>
        <Text style={styles.period}>
          Historical simulation, {shortDate(result.period.start)} to {shortDate(result.period.end)}. Signals on the close, fills at the next open,{" "}
          {result.config.commissionBps} bps commission and {result.config.slippageBps} bps slippage per fill.
        </Text>
        {[...result.warnings, ...notes, ...result.caveats].map((line) => (
          <Text key={line} style={styles.note}>
            {line}
          </Text>
        ))}
      </Reveal>
    </>
  );
}

/** The card's own record as an event study: N past events, G separate dates, moves the implied way. */
function Measured({ studies, eventTicker }: { studies: HistoryStudy[]; eventTicker: string }) {
  return (
    <Reveal order={1} style={styles.card}>
      <Text style={styles.cardTitle}>Measured move (from the close before the news)</Text>
      {studies.map((s) => (
        <View key={s.ticker} style={styles.study}>
          <Text style={styles.studyLine}>
            In {s.wins} of {s.n} past {eventTicker} events, on {s.g} separate {s.g === 1 ? "date" : "dates"}, {s.ticker} moved {s.direction} against {s.benchmark} over {s.windowDays}{" "}
            {s.windowDays === 1 ? "session" : "sessions"}.
          </Text>
          <Text style={styles.studySub}>
            Average move vs {s.benchmark} {pct(s.meanAdjustedPct)}, median {pct(s.medianAdjustedPct)}
            {s.from && s.to ? `, ${shortDate(s.from)} to ${shortDate(s.to)}` : ""}.
          </Text>
        </View>
      ))}
      <Text style={styles.note}>A record of past events, not a probability for this one. Only companies listed today are measured.</Text>
    </Reveal>
  );
}

/** "Backtest this" on a Sighting: past events of its type on the companies it reaches, against SPY. */
export default function SightingBacktest() {
  const window = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { card, status } = useSightingCard(id);
  const built = useMemo(() => (card ? strategyFromSighting(card) : null), [card]);
  const studies = useMemo(() => (card ? eventStudyFromHistory(card) : []), [card]);
  const noSource = card ? !built?.hasHistory && hasNoHistorySource(card) : false;
  const { state, start } = useBacktest(card?.id, built?.strategy ?? null);
  const screenW = Platform.OS === "web" ? Math.min(window.width, PREVIEW_WIDTH) : window.width;
  const width = screenW - GUTTER * 2;

  useEffect(() => {
    if (built?.hasHistory && state.status === "idle") start();
  }, [built?.hasHistory, start, state.status]);

  const lines = useMemo(() => (built ? describeStrategy(built.strategy) : []), [built]);

  if (!card || !built) {
    return <PushedScreen>{status === "loading" ? <SkeletonCard /> : <EmptyTitle title="Sighting not found" />}</PushedScreen>;
  }

  return (
    <PushedScreen>
      <Reveal order={0}>
        <Text style={styles.kicker}>Backtest · {card.event.ticker}</Text>
        <Text style={styles.headline} accessibilityRole="header">
          {built.strategy.name}
        </Text>
        <View style={styles.rules}>
          {lines.map((l) => (
            <Text key={l} style={styles.ruleLine}>
              {l}
            </Text>
          ))}
        </View>
      </Reveal>

      {studies.length ? <Measured studies={studies} eventTicker={card.event.ticker} /> : null}

      {!built.hasHistory ? (
        studies.length ? null : (
          <Reveal order={1}>
            <Text style={styles.body}>
              {noSource
                ? `No history source yet for ${card.event.ticker} events of this type (such as monthly revenue reports), so there is nothing to measure. Earnings Sightings test against the full earnings record.`
                : `Past ${card.event.ticker} events of this type are not in the backtest data yet. Earnings Sightings test against the full earnings record.`}
            </Text>
          </Reveal>
        )
      ) : state.status === "running" || state.status === "idle" ? (
        <Reveal order={1} style={styles.loading}>
          <ActivityIndicator size="small" color={colors.muted} />
          <Text style={styles.loadingText}>{state.status === "running" && state.retrying ? "Still loading, trying again" : "Running on 10 years of daily prices"}</Text>
        </Reveal>
      ) : state.status === "error" ? (
        <Reveal order={1}>
          <Text style={styles.error}>{state.message}</Text>
          <SecondaryButton label="Try again" onPress={start} style={styles.retry} />
        </Reveal>
      ) : (
        <Results result={state.result} width={width} notes={built.notes} />
      )}
    </PushedScreen>
  );
}

const styles = StyleSheet.create({
  kicker: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.5)",
  },
  headline: {
    marginTop: 12,
    fontFamily: fonts.serif,
    fontSize: 24,
    lineHeight: 32,
    letterSpacing: -0.3,
    color: colors.ink,
  },
  rules: { marginTop: 14, gap: 6 },
  ruleLine: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.body },
  body: { marginTop: 24, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, color: colors.body },
  loading: { marginTop: 28, flexDirection: "row", alignItems: "center", gap: 10 },
  loadingText: { fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  error: { marginTop: 24, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.error },
  retry: { marginTop: 14, alignSelf: "flex-start" },
  card: { ...cardStyles.surface, marginTop: 24, paddingHorizontal: 18, paddingVertical: 16 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 12, height: 2, borderRadius: 1 },
  legendText: { fontFamily: fonts.mono, fontSize: 12, color: colors.ink },
  curve: { marginTop: 12 },
  table: { paddingVertical: 6 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 9 },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.divider },
  cell: { flex: 1, textAlign: "right", fontFamily: fonts.sans, fontSize: 13.5, color: colors.ink },
  labelCell: { flex: 1.3, textAlign: "left", color: colors.muted },
  head: { fontSize: 12, color: colors.muted },
  value: { fontFamily: fonts.mono, fontSize: 13 },
  muted: { color: colors.body },
  period: { marginTop: 20, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, color: colors.muted },
  note: { marginTop: 8, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, color: colors.faint },
  cardTitle: { fontFamily: fonts.sans, fontSize: 13, color: colors.muted },
  study: { marginTop: 10, gap: 4 },
  studyLine: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.ink },
  studySub: { fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, color: colors.muted },
});
