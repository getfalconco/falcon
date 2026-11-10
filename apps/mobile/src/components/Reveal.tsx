import { useEffect, type ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { EASE_CALM } from "@/theme";

export const ENTER_MS = 320;
export const STAGGER_MS = 45;
export const ENTER_Y = 12;

/**
 * Fades its children in on mount, rising `distance` points (negative comes
 * down from above), after `order` stagger steps. Calm ease, no overshoot.
 */
export function Reveal({
  children,
  order = 0,
  distance = ENTER_Y,
  style,
}: {
  children: ReactNode;
  order?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      reduceMotion ? 0 : order * STAGGER_MS,
      withTiming(1, { duration: reduceMotion ? 150 : ENTER_MS, easing: EASE_CALM }),
    );
  }, [order, progress, reduceMotion]);

  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: reduceMotion ? 0 : (1 - progress.value) * distance }],
  }));

  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}
