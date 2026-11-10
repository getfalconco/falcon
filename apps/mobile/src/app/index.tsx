import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { FUNNEL_TEST_MODE } from "@/lib/env";
import { getSupabase } from "@/lib/supabase";
import { EASE_CALM, colors } from "@/theme";

/** Must match the expo-splash-screen plugin's imageWidth in app.json. */
const SPLASH_LOGO_SIZE = 64;
/** How long the logo rests before the app moves on. */
const HOLD_MS = 650;
const FADE_MS = 240;

/**
 * The loading screen: white, the Falcon mark small and centered, nothing
 * else. Drawn exactly like the native launch screen, which it replaces the
 * moment it has laid out; then it fades the mark and hands off.
 */
export default function Splash() {
  const router = useRouter();
  const opacity = useSharedValue(1);
  const target = useRef<"/login" | "/welcome">("/login");
  const hidden = useRef(false);

  useEffect(() => {
    // Funnel test mode keeps no session, so it always starts at the login.
    if (FUNNEL_TEST_MODE) return;
    const supabase = getSupabase();
    if (!supabase) return;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (data.session) target.current = "/welcome";
      })
      .catch(() => {});
  }, []);

  const go = useCallback(() => router.replace(target.current), [router]);

  const onLayout = useCallback(() => {
    if (hidden.current) return;
    hidden.current = true;
    void SplashScreen.hideAsync().catch(() => {});
    opacity.value = withDelay(
      HOLD_MS,
      withTiming(0, { duration: FADE_MS, easing: EASE_CALM }, (finished) => {
        if (finished) scheduleOnRN(go);
      }),
    );
  }, [go, opacity]);

  const logoStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <View style={styles.screen} onLayout={onLayout}>
      <Animated.Image
        source={require("../../assets/splash-icon.png")}
        style={[styles.logo, logoStyle]}
        resizeMode="contain"
        accessibilityLabel="Falcon"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.splash },
  logo: { width: SPLASH_LOGO_SIZE, height: SPLASH_LOGO_SIZE },
});
