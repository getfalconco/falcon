import { useCallback, useRef, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { router, type Href } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { FUNNEL_TEST_MODE } from "@/lib/env";
import { signedInRoute } from "@/lib/home";
import { getSupabase } from "@/lib/supabase";
import { EASE_SOFT, colors } from "@/theme";

/** Must match the expo-splash-screen plugin's imageWidth in app.json. */
const SPLASH_LOGO_SIZE = 64;
/** How long the logo rests before it fades. */
const HOLD_MS = 700;
const FADE_MS = 600;

/** Where a member with a saved session goes instead of the landing, or null. */
async function returningMemberRoute(): Promise<Href | null> {
  // Funnel test mode keeps no session, so it always starts at the landing.
  if (FUNNEL_TEST_MODE) return null;
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return null;
  } catch {
    return null;
  }
  // The home tabs (HOME_ROUTE in lib/home.ts) once the funnel is done, else /welcome.
  return signedInRoute();
}

/**
 * The loading screen, drawn over the app: white with the Falcon mark small
 * and centered, exactly like the native launch screen, which it replaces the
 * moment it has laid out. After a short rest the whole layer fades out and
 * the landing screen underneath shows through.
 */
export function SplashOverlay() {
  const opacity = useSharedValue(1);
  const [done, setDone] = useState(false);
  const started = useRef(false);

  const finish = useCallback(() => setDone(true), []);

  const onLayout = useCallback(() => {
    if (started.current) return;
    started.current = true;
    void SplashScreen.hideAsync().catch(() => {});
    const destination = returningMemberRoute().catch(() => null);
    const rested = new Promise((resolve) => setTimeout(resolve, HOLD_MS - 100));
    // While the splash still covers the screen, a returning member skips the
    // landing; the fade waits for that check (it fails soft within seconds).
    void Promise.all([destination, rested]).then(([route]) => {
      if (route) router.replace(route);
      opacity.value = withDelay(
        100,
        withTiming(0, { duration: FADE_MS, easing: EASE_SOFT }, (finished) => {
          if (finished) scheduleOnRN(finish);
        }),
      );
    });
  }, [finish, opacity]);

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
