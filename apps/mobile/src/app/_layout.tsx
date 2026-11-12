import { Platform } from "react-native";
import { Stack, type NativeStackNavigationOptions } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { LibreBaskerville_400Regular } from "@expo-google-fonts/libre-baskerville/400Regular";
import { PlayfairDisplay_400Regular } from "@expo-google-fonts/playfair-display/400Regular";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import PhoneFrame from "@/components/PhoneFrame";
import { SplashOverlay } from "@/components/SplashOverlay";
import { SHEET_CORNER_RADIUS, SHEET_DETENTS } from "@/lib/sheets";
import { colors, fonts } from "@/theme";

// The native launch screen stays up until the JS splash (SplashOverlay) has
// drawn the same logo in the same place, so the hand-off is invisible.
void SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * A real iOS form sheet (system grabber, detents, corners, swipe down to
 * close). The web preview has none, so there the route is a transparent
 * modal and components/Sheet.web.tsx draws the sheet inside the phone frame.
 */
function sheet(detents: readonly number[]): NativeStackNavigationOptions {
  if (Platform.OS === "web") {
    return { presentation: "transparentModal", animation: "none", contentStyle: { backgroundColor: "transparent" } };
  }
  return {
    presentation: "formSheet",
    sheetGrabberVisible: true,
    sheetAllowedDetents: [...detents],
    sheetCornerRadius: SHEET_CORNER_RADIUS,
    gestureEnabled: true,
    contentStyle: { backgroundColor: "#ffffff" },
  };
}

export default function RootLayout() {
  // The website's own fonts: Geist (the `geist` package's TTFs) for text,
  // Libre Baskerville and Playfair Display (Google Fonts) for headlines, and
  // Inter (Google Fonts) for the login form's text.
  const [loaded, error] = useFonts({
    [fonts.sans]: require("../../assets/fonts/Geist-Regular.ttf"),
    [fonts.sansMedium]: require("../../assets/fonts/Geist-Medium.ttf"),
    [fonts.mono]: require("../../assets/fonts/GeistMono-Regular.ttf"),
    [fonts.serif]: LibreBaskerville_400Regular,
    [fonts.display]: PlayfairDisplay_400Regular,
    [fonts.inter]: Inter_400Regular,
  });

  if (!loaded && !error) return null;

  return (
    <PhoneFrame>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "fade",
          animationDuration: 280,
          gestureEnabled: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="login" options={{ contentStyle: { backgroundColor: "#fbfbf9" } }} />
        <Stack.Screen name="welcome" />
        <Stack.Screen name="sign-in" options={sheet(SHEET_DETENTS.signIn)} />
        <Stack.Screen name="language" options={sheet(SHEET_DETENTS.language)} />
        {/* The home tabs after the funnel, and a Sighting pushed over them. */}
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="sighting/[id]"
          options={{ animation: "slide_from_right", animationDuration: 320, gestureEnabled: true }}
        />
      </Stack>
      <SplashOverlay />
    </PhoneFrame>
  );
}
