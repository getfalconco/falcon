import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { colors, fonts } from "@/theme";

/** The site's dark primary button (#1c1917, 8px radius, Geist 13px). */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: loading }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.button,
        styles.primary,
        pressed && !off ? styles.primaryPressed : null,
        disabled && !loading ? styles.disabled : null,
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? <ActivityIndicator size="small" color={colors.primaryText} /> : null}
        <Text style={[styles.label, { color: colors.primaryText }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

/** The site's light outlined secondary button. */
export function SecondaryButton({
  label,
  onPress,
  disabled = false,
  style,
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        styles.secondary,
        pressed && !disabled ? styles.secondaryPressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      <View style={styles.row}>
        {icon}
        <Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

/** Icon-only round back button (the funnel's chevron). */
export function BackButton({
  onPress,
  disabled = false,
  hidden = false,
}: {
  onPress: () => void;
  disabled?: boolean;
  hidden?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      aria-hidden={hidden}
      onPress={onPress}
      disabled={disabled || hidden}
      hitSlop={8}
      style={({ pressed }) => [styles.back, pressed ? styles.backPressed : null, hidden ? styles.hidden : null]}
    >
      <ChevronLeft size={18} strokeWidth={1.75} color={colors.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 50,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 20 },
  primary: { backgroundColor: colors.primary },
  primaryPressed: { backgroundColor: "#0f0d0b", transform: [{ scale: 0.99 }] },
  secondary: { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.hairline, backgroundColor: "transparent" },
  secondaryPressed: { backgroundColor: "#efefec" },
  disabled: { opacity: 0.4 },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  backPressed: { backgroundColor: "rgba(0, 0, 0, 0.04)" },
  hidden: { opacity: 0 },
});
