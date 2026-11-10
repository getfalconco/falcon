import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { colors } from "@/theme";

/**
 * Apple's Liquid Glass (UIGlassEffect, iOS 26+) through expo-glass-effect.
 * Checked once: the API exists only on iOS 26 builds made with Xcode 26.
 */
const LIQUID_GLASS =
  Platform.OS === "ios" &&
  (() => {
    try {
      return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
    } catch {
      return false;
    }
  })();

/**
 * A round button. On iOS 26 it is a real Liquid Glass view; elsewhere (the
 * browser preview, older iOS) a plain light circle with a hairline border.
 */
export function GlassButton({
  size = 44,
  onPress,
  accessibilityLabel,
  children,
}: {
  size?: number;
  onPress: () => void;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  const shape = { width: size, height: size, borderRadius: size / 2 };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [shape, !LIQUID_GLASS && pressed ? styles.pressed : null]}
    >
      {LIQUID_GLASS ? (
        <GlassView glassEffectStyle="regular" isInteractive style={[shape, styles.center]}>
          {children}
        </GlassView>
      ) : (
        <View style={[shape, styles.center, styles.plain]}>{children}</View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  plain: {
    backgroundColor: "#f5f5f4",
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.hairline,
  },
  pressed: { opacity: 0.7 },
});
