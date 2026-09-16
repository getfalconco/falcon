import { useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  type StyleProp,
  type ViewStyle,
} from "react-native";

/**
 * The onboarding CTA's press motion, lifted out so the product's dark buttons
 * answer a finger the same way the Continue button does: the surface takes a
 * step back under the touch and comes back when it is let go.
 *
 * The numbers are GetStartedButton's, unchanged — same dip, same durations,
 * same curve — so a press feels identical on both sides of the sign-in. That
 * button reaches for Reanimated; this one uses React Native's own Animated,
 * because Reanimated's `createAnimatedComponent` types resolve against the
 * React 18 types pnpm gives it, which this app's React 19 does not satisfy.
 * The same mismatch is why `Screen` avoids SafeAreaView.
 *
 * The Pressable itself is what animates rather than a view wrapped around it:
 * these buttons carry layout of their own (`flex: 1` in the insight card's
 * footer, for one), and an extra box in the middle would be what stretched.
 */

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const PRESSED_SCALE = 0.98;
const IN_MS = 120;
const OUT_MS = 180;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function PressableScale({
  children,
  onPress,
  disabled = false,
  style,
  /** Applied while held — for dark buttons, the slightly deeper fill. */
  pressedStyle,
  accessibilityLabel,
  hitSlop,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  hitSlop?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const [held, setHeld] = useState(false);

  const to = (value: number, duration: number) =>
    Animated.timing(scale, {
      toValue: value,
      duration,
      easing: EASE,
      useNativeDriver: true,
    }).start();

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled}
      onPressIn={() => {
        if (disabled) return;
        setHeld(true);
        to(PRESSED_SCALE, IN_MS);
      }}
      onPressOut={() => {
        setHeld(false);
        to(1, OUT_MS);
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={hitSlop}
      style={[style, { transform: [{ scale }] }, held && !disabled ? pressedStyle : null]}
    >
      {children}
    </AnimatedPressable>
  );
}
