import { useId, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop, Circle } from "react-native-svg";
import { FONTS, PRODUCT } from "@/theme";

/**
 * 30-day signal-count sparkline — the mobile equivalent of the desktop's
 * "Signal flow" card. Area fill + emphasized endpoint, per the project's
 * charting conventions.
 */
export default function SignalFlow({
  values,
  height = 72,
}: {
  values: number[];
  height?: number;
}) {
  const [width, setWidth] = useState(0);
  const fillId = `flowFill-${useId().replace(/:/g, "")}`;

  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return (
      <View style={[styles.emptyBox, { height }]}>
        <Text style={styles.emptyText}>No signals in the last 30 days</Text>
      </View>
    );
  }

  const max = Math.max(...values, 1);
  const stepX = width > 0 ? width / Math.max(values.length - 1, 1) : 0;
  const y = (v: number) => height - (v / max) * (height - 8) - 4;

  const points = values.map((v, i) => [i * stepX, y(v)] as const);
  const line = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px},${py}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = points[points.length - 1];

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <View style={styles.head}>
        <Text style={styles.total}>{total}</Text>
        <Text style={styles.totalNote}>signals</Text>
      </View>

      {width > 0 ? (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={PRODUCT.fg} stopOpacity="0.22" />
              <Stop offset="1" stopColor={PRODUCT.fg} stopOpacity="0" />
            </LinearGradient>
          </Defs>
          <Path d={area} fill={`url(#${fillId})`} />
          <Path d={line} stroke={PRODUCT.fg} strokeWidth={1.5} fill="none" />
          {last ? <Circle cx={last[0]} cy={last[1]} r={3} fill={PRODUCT.fg} /> : null}
        </Svg>
      ) : (
        <View style={{ height }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "baseline", gap: 6, marginBottom: 8 },
  total: { fontFamily: FONTS.monoMedium, fontSize: 18, color: PRODUCT.fg },
  totalNote: { fontFamily: FONTS.sans, fontSize: 11, color: PRODUCT.fgFaint },
  emptyBox: { alignItems: "center", justifyContent: "center" },
  emptyText: { fontFamily: FONTS.sans, fontSize: 12, color: PRODUCT.fgFaint },
});
