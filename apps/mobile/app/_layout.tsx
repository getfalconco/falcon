import { useEffect } from "react";
import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import {
  LibreBaskerville_400Regular,
  LibreBaskerville_400Regular_Italic,
  LibreBaskerville_700Bold,
} from "@expo-google-fonts/libre-baskerville";
import { COLORS } from "@/theme";

// Hold the native splash until the fonts are ready — every screen is typeset
// in Libre Baskerville / Geist, so rendering before they load would flash
// the system font.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    LibreBaskerville_400Regular,
    LibreBaskerville_400Regular_Italic,
    LibreBaskerville_700Bold,
    "Geist-Regular": require("../assets/fonts/Geist-Regular.ttf"),
    "Geist-Medium": require("../assets/fonts/Geist-Medium.ttf"),
    "GeistMono-Regular": require("../assets/fonts/GeistMono-Regular.ttf"),
    "GeistMono-Medium": require("../assets/fonts/GeistMono-Medium.ttf"),
  });

  useEffect(() => {
    // Hide on error too, otherwise a missing font file would leave the user
    // staring at the splash forever.
    if (loaded || error) void SplashScreen.hideAsync();
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: COLORS.bg },
          // Default for the brand beats (splash → intro) and for the landings
          // the app routes to on its own.
          animation: "fade",
        }}
      >
        {/*
         * Screens the user actively walks into get the system push instead of
         * a cross-fade — two full-bleed pages dissolving into each other read
         * as a slideshow, not as moving forward through a flow. These are
         * reached with router.replace (no history to pop), so the replace has
         * to be told to animate forward rather than backward.
         */}
        <Stack.Screen
          name="login"
          options={{ animation: "slide_from_right", animationTypeForReplace: "push" }}
        />
        <Stack.Screen
          name="signup"
          options={{ animation: "slide_from_right", animationTypeForReplace: "push" }}
        />
      </Stack>
    </>
  );
}
