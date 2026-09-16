import { Pressable, StyleSheet, Text } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { COLORS, FONTS } from "@/theme";

/**
 * The onboarding / auth CTA. Adapted from
 * apps/web/app/components/GetStartedButton.tsx — same dark surface and 45px
 * height, but without the site's marching pixel arrow: on the phone that
 * animation drew the eye away from the label it was meant to support.
 *
 * Site focus-stage size: h-[45px] w-[260px].
 */

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Site focus-stage is 260px centered; onboarding footers stretch. */
  fullWidth?: boolean;
};

export default function GetStartedButton({
  label,
  onPress,
  disabled = false,
  fullWidth = false,
}: Props) {
  const press = useSharedValue(1);
  const hoverEase = Easing.bezier(0.22, 1, 0.36, 1);

  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: press.value }],
  }));

  return (
    <Animated.View style={[pressStyle, fullWidth && styles.stretch]}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        onPressIn={() => {
          if (disabled) return;
          press.value = withTiming(0.98, { duration: 120, easing: hoverEase });
        }}
        onPressOut={() => {
          press.value = withTiming(1, { duration: 180, easing: hoverEase });
        }}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          styles.button,
          fullWidth && styles.fullWidth,
          disabled && styles.disabled,
          pressed && !disabled && styles.pressed,
        ]}
      >
        <Text style={[styles.label, disabled && styles.labelDisabled]}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stretch: { alignSelf: "stretch" },
  button: {
    height: 45,
    width: 260,
    borderRadius: 8,
    backgroundColor: COLORS.inkButton,
    flexDirection: "row",
    alignItems: "center",
    // The arrow used to hold the right edge; with only a label left, centring
    // it keeps the button from looking lopsided.
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  fullWidth: { width: "100%" },
  pressed: { backgroundColor: COLORS.inkButtonHover },
  disabled: { backgroundColor: COLORS.disabledBg },
  label: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    lineHeight: 20,
    color: COLORS.onInk,
  },
  labelDisabled: { color: COLORS.disabledText },
});
