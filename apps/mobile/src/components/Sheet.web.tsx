import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaFrame } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { SHEET_CORNER_RADIUS } from "@/lib/sheets";
import { EASE_CALM, EASE_SOFT } from "@/theme";
import { GRABBER_SPACE, type CloseSheet } from "./sheetShared";

export type { CloseSheet } from "./sheetShared";

const OPEN_MS = 380;
const CLOSE_MS = 260;
const RADIUS = SHEET_CORNER_RADIUS;

/**
 * Web preview stand-in for the iOS form sheet: the route is a transparent
 * modal, and this draws the dimmed backdrop and a sheet that slides up from
 * the bottom of the iPhone frame to `detent` of its height, with a grabber.
 */
export function SheetScreen({ detent, children }: { detent: number; children: (close: CloseSheet) => ReactNode }) {
  const router = useRouter();
  const frame = useSafeAreaFrame();
  const height = Math.round(frame.height * detent);
  const progress = useSharedValue(0);
  const closing = useRef(false);
  const after = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    progress.value = withTiming(1, { duration: OPEN_MS, easing: EASE_CALM });
  }, [progress]);

  const finish = useCallback(() => {
    if (router.canGoBack()) router.back();
    after.current?.();
  }, [router]);

  const close = useCallback<CloseSheet>(
    (then) => {
      if (closing.current) return;
      closing.current = true;
      after.current = then;
      progress.value = withTiming(0, { duration: CLOSE_MS, easing: EASE_SOFT }, (done) => {
        if (done) scheduleOnRN(finish);
      });
    },
    [finish, progress],
  );

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * height }] }));

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={() => close()} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { height }, sheetStyle]}>
        <View style={styles.grabber} />
        <View style={styles.content}>{children(close)}</View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0, 0, 0, 0.22)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: RADIUS,
    borderTopRightRadius: RADIUS,
    backgroundColor: "#ffffff",
    boxShadow: "0 -8px 30px rgba(0, 0, 0, 0.08)",
    overflow: "hidden",
  },
  // The system grabber: 36 x 5, 5pt below the top edge.
  grabber: {
    position: "absolute",
    top: 5,
    alignSelf: "center",
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "rgba(60, 60, 67, 0.3)",
  },
  content: { flex: 1, paddingTop: GRABBER_SPACE },
});
