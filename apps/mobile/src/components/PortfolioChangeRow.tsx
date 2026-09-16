import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import GlassIconButton from "@/components/GlassIconButton";
import {
  CHANGE_PERIODS,
  usePortfolioChange,
  type ChangePeriod,
} from "@/lib/use-portfolio-change";
import { FONTS, PRODUCT } from "@/theme";

const MASK = "$*****";

function fmtUsd(v: number): string {
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : v > 0 ? "+" : ""}$${s}`;
}

function tone(v: number): string {
  if (v > 0) return PRODUCT.gain;
  if (v < 0) return PRODUCT.loss;
  return PRODUCT.fgMuted;
}

/**
 * The headline's change line: how much the book moved over one window, in
 * gain/loss colour, with the window itself as the control. Tapping the label
 * rotates Daily -> Weekly -> All -> Daily; the mirrored triangles are the
 * affordance that it rotates.
 */
export default function PortfolioChangeRow({ masked = false }: { masked?: boolean }) {
  const [index, setIndex] = useState(0);
  const period: ChangePeriod = CHANGE_PERIODS[index]!;
  const { change, ready } = usePortfolioChange(period);

  const next = () => setIndex((i) => (i + 1) % CHANGE_PERIODS.length);
  const color = tone(change?.amount ?? 0);

  return (
    <View style={styles.row}>
      {ready && change ? (
        <>
          <Text style={[styles.amount, { color: masked ? PRODUCT.fgMuted : color }]}>
            {masked ? MASK : fmtUsd(change.amount)}
          </Text>
          {!masked ? (
            <Text style={[styles.pct, { color }]}>
              ({change.pct >= 0 ? "+" : "-"}
              {Math.abs(change.pct).toFixed(2)}%)
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={[styles.amount, styles.pending]}>—</Text>
      )}

      <Pressable
        onPress={next}
        hitSlop={10}
        style={styles.switch}
        accessibilityRole="button"
        accessibilityLabel={`Change window: ${period}. Tap for ${
          CHANGE_PERIODS[(index + 1) % CHANGE_PERIODS.length]
        }.`}
      >
        <Text style={styles.period}>{period}</Text>
        <View style={styles.carets}>
          <View style={styles.caretUp} />
          <View style={styles.caretDown} />
        </View>
      </Pressable>

      {/* The same button the waitlist screen carries — one component, so the
          material, the size and the press response cannot drift apart.
          TODO: wire onPress to chart mode. */}
      <GlassIconButton
        icon="trending-up"
        onPress={() => {}}
        accessibilityLabel="Open chart"
        style={styles.chartBtn}
      />
    </View>
  );
}

/**
 * Round button that will open chart mode. Liquid Glass where the OS has it
 * (iOS 26+), a plain card-coloured disc everywhere else — expo-glass-effect
 * renders a bare View below iOS 26, which would leave no button at all.
 *
 * TODO: wire onPress to chart mode.
 */
const CARET = 4;

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 18,
  },
  amount: { fontFamily: FONTS.sansMedium, fontSize: 15, lineHeight: 20 },
  pct: { fontFamily: FONTS.sans, fontSize: 15, lineHeight: 20 },
  pending: { color: PRODUCT.fgSubtle },
  switch: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 },
  period: { fontFamily: FONTS.sans, fontSize: 15, lineHeight: 20, color: PRODUCT.fgMuted },
  carets: { alignItems: "center", justifyContent: "center", gap: 2 },
  chartBtn: { marginLeft: "auto" },
  caretUp: {
    width: 0,
    height: 0,
    borderLeftWidth: CARET,
    borderRightWidth: CARET,
    borderBottomWidth: CARET + 1,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: PRODUCT.fgSubtle,
  },
  caretDown: {
    width: 0,
    height: 0,
    borderLeftWidth: CARET,
    borderRightWidth: CARET,
    borderTopWidth: CARET + 1,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: PRODUCT.fgSubtle,
  },
});
