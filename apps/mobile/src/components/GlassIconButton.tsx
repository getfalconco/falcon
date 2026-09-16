import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import { PRODUCT } from "@/theme";

/**
 * Round icon button in Apple's own Liquid Glass — `UIGlassEffect` through
 * expo-glass-effect, not a blur dressed up as one, so the lensing and the
 * press response are UIKit's.
 *
 * Both availability checks, not just the first: `isLiquidGlassAvailable()`
 * only says the OS is on the Liquid Glass design, while some iOS 26 betas ship
 * without the `UIGlassEffect` class itself (expo/expo#40911). The native view
 * declines to apply the effect there and renders nothing, so a button behind
 * one check alone would simply vanish. Everywhere else this falls back to a
 * plain card-coloured disc.
 */
const LIQUID_GLASS = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

export default function GlassIconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 40,
  style,
  glassEffectStyle = "regular",
}: {
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  /**
   * "regular" is the frosted material with the specular rim — the one that
   * still reads as glass on a flat canvas. "clear" is a bare lens: over the
   * app's uniform #eaeae6 background it has nothing to refract and disappears,
   * so reserve it for buttons that float over imagery or scrolling content.
   */
  glassEffectStyle?: "regular" | "clear";
}) {
  const disc = { width: size, height: size, borderRadius: size / 2 };
  const glyph = <Feather name={icon} size={Math.round(size * 0.45)} color={PRODUCT.fg} />;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={style}
    >
      {LIQUID_GLASS ? (
        // The glyph is a child of the glass view rather than a sibling above
        // it: expo-glass-effect mounts children into the effect view's own
        // contentView, which is what lets `isInteractive` see the touch.
        <GlassView
          style={[styles.disc, disc]}
          glassEffectStyle={glassEffectStyle}
          // The app is single-theme light; without this the material follows
          // the system scheme and turns smoked on a dark-mode phone.
          colorScheme="light"
          isInteractive
        >
          {glyph}
        </GlassView>
      ) : (
        <View style={[styles.disc, styles.fallback, disc]}>{glyph}</View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  disc: { overflow: "hidden", alignItems: "center", justifyContent: "center" },
  fallback: {
    backgroundColor: PRODUCT.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.borderStrong,
  },
});
