import { Children, isValidElement, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { colors, fonts } from "@/theme";

/** A small mono label over a group of rows. */
export function GroupLabel({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={styles.labelRow}>
      <Text style={styles.label} accessibilityRole="header">
        {children}
      </Text>
      {right}
    </View>
  );
}

/** Rows on one white surface, with hairlines between them (iOS inset grouped). */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[styles.group, style]}>
      {rows.map((row, i) => (
        <View key={row.key ?? i}>
          {i > 0 ? <View style={styles.divider} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

/** One settings row: a title, a quiet value or any accessory on the right, and a chevron when it opens something. */
export function Row({
  title,
  value,
  accessory,
  onPress,
  chevron = onPress !== undefined,
  tone = "default",
  accessibilityLabel,
  disabled = false,
}: {
  title: string;
  value?: string;
  accessory?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  tone?: "default" | "destructive";
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  const body = (pressed: boolean) => (
    <View style={[styles.row, pressed ? styles.rowPressed : null]}>
      <Text style={[styles.title, tone === "destructive" ? styles.destructive : null]} numberOfLines={1}>
        {title}
      </Text>
      {value ? (
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {accessory}
      {chevron ? <ChevronRight size={17} strokeWidth={1.8} color={colors.placeholder} /> : null}
    </View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (value ? `${title}, ${value}` : title)}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

export const listStyles = StyleSheet.create({
  surface: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.065)",
    backgroundColor: "#ffffff",
  },
});

const styles = StyleSheet.create({
  labelRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.45)",
  },
  group: { ...listStyles.surface, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth * 2, marginLeft: 16, backgroundColor: colors.divider },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 16, paddingRight: 12 },
  rowPressed: { backgroundColor: "rgba(0, 0, 0, 0.03)" },
  title: { flex: 1, fontFamily: fonts.sans, fontSize: 16, lineHeight: 21, color: colors.ink },
  destructive: { color: "#b23a2e" },
  value: { flexShrink: 1, maxWidth: "62%", fontFamily: fonts.sans, fontSize: 15, lineHeight: 20, color: colors.muted },
});
