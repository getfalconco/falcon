import { useCallback, useEffect, useRef, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { FUNNEL_TEST_MODE } from "@/lib/env";
import { getSupabase } from "@/lib/supabase";
import { EASE_SOFT, colors } from "@/theme";

/** Must match the expo-splash-screen plugin's imageWidth in app.json. */
const SPLASH_LOGO_SIZE = 64;
/** How long the logo rests before it fades. */
const HOLD_MS = 700;
const FADE_MS = 600;

/**
 * The loading screen, drawn over the app: white with the Falcon mark small
 * and centered, exactly like the native launch screen, which it replaces the
 * moment it has laid out. After a short rest the whole layer fades out and
 * the landing screen underneath shows through.
 */
export function SplashOverlay() {
  const opacity = useSharedValue(1);
  const [done, setDone] = useState(false);
  const signedIn = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    // Funnel test mode keeps no session, so it always starts at the landing.
    if (FUNNEL_TEST_MODE) return;
    const supabase = getSupabase();
    if (!supabase) return;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        signedIn.current = Boolean(data.session);
      })
      .catch(() => {});
  }, []);

  // While the splash still covers the screen, a returning member skips the landing.
  const handOff = useCallback(() => {
    if (signedIn.current) router.replace("/welcome");
  }, []);

  const finish = useCallback(() => setDone(true), []);

  const onLayout = useCallback(() => {
    if (started.current) return;
    started.current = true;
    void SplashScreen.hideAsync().catch(() => {});
    opacity.value = withDelay(
      HOLD_MS,
      withTiming(0, { duration: FADE_MS, easing: EASE_SOFT }, (finished) => {
        if (finished) scheduleOnRN(finish);
      }),
    );
    setTimeout(handOff, HOLD_MS - 100);
  }, [finish, handOff, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (done) return null;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.screen, style]} onLayout={onLayout}>
      <View style={styles.center}>
        <Image
          source={require("../../assets/splash-icon.png")}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel="Falcon"
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.splash },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  logo: { width: SPLASH_LOGO_SIZE, height: SPLASH_LOGO_SIZE },
});
