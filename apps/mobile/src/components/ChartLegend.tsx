import { Pressable, StyleSheet, Text, View } from "react-native";
import { FONTS, PRODUCT } from "@/theme";

export type LegendState = { growth: boolean; sp500: boolean };

/** Match PortfolioChart stroke colors so the legend encodes which series is which. */
const SERIES = {
  value: PRODUCT.chart.value,
  growth: PRODUCT.chart.growth,
  sp500: PRODUCT.chart.sp500,
} as const;

const TOGGLES: Array<{ key: keyof LegendState; label: string; color: string }> = [
  { key: "growth", label: "Growth", color: SERIES.growth },
  { key: "sp500", label: "S&P 500", color: SERIES.sp500 },
];

/**
 * Portfolio chart legend — same toggles as desktop ChartLegend, pocket-sized.
 */
export default function ChartLegend({
  state,
  onToggle,
}: {
  state: LegendState;
  onToggle: (key: keyof LegendState) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.item}>
        <View style={[styles.dot, { backgroundColor: SERIES.value }]} />
        <Text style={styles.labelOn}>Value</Text>
      </View>
      {TOGGLES.map((item) => {
        const active = state[item.key];
        return (
          <Pressable
            key={item.key}
            onPress={() => onToggle(item.key)}
            hitSlop={8}
            style={styles.item}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <View
              style={[
                styles.dot,
                active
                  ? { backgroundColor: item.color }
                  : styles.dotHollow,
              ]}
            />
            <Text style={active ? styles.labelOn : styles.labelOff}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 14,
    marginBottom: 8,
  },
  item: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotHollow: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: PRODUCT.chart.axis,
  },
  labelOn: { fontFamily: FONTS.sans, fontSize: 12, color: PRODUCT.fg },
  labelOff: { fontFamily: FONTS.sans, fontSize: 12, color: PRODUCT.chart.axis },
});
