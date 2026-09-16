import { useEffect } from "react";
import { Image, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { supabase } from "@/lib/supabase";
import { postAuthHref } from "@/lib/post-auth";
import { COLORS, EASE_OUT_BEZIER } from "@/theme";

/** Minimum time the mark stays up, so the brand beat isn't a flicker. */
const HOLD_MS = 1400;
const FADE_IN_MS = 700;

export default function SplashScreenRoute() {
  const router = useRouter();
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(8);

  useEffect(() => {
    const easing = Easing.bezier(...EASE_OUT_BEZIER);
    opacity.value = withTiming(1, { duration: FADE_IN_MS, easing });
    translateY.value = withTiming(0, { duration: FADE_IN_MS, easing });
  }, [opacity, translateY]);

  // Decide where to land while the mark is showing: approved members go
  // straight into the product, everyone else into onboarding.
  useEffect(() => {
    let cancelled = false;

    const decide = async () => {
      let target = "/intro";
      try {
        const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
        const user = data.session?.user ?? null;
        if (user) target = postAuthHref(user);
      } catch {
        // Fall through to onboarding — never trap the user on the splash.
      }

      const wait = new Promise((r) => setTimeout(r, HOLD_MS));
      await wait;
      if (!cancelled) router.replace(target as never);
    };

    void decide();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const markStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View style={styles.root}>
      <Animated.View style={markStyle}>
        <Image
          source={require("../assets/falcon-mark.png")}
          style={styles.mark}
          resizeMode="contain"
          accessibilityLabel="Falcon"
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.bg,
  },
  mark: { width: 56, height: 56 },
});
