import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { LibreBaskerville_400Regular } from "@expo-google-fonts/libre-baskerville/400Regular";
import { PlayfairDisplay_400Regular } from "@expo-google-fonts/playfair-display/400Regular";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import PhoneFrame from "@/components/PhoneFrame";
import { colors, fonts } from "@/theme";

// The native launch screen stays up until the JS splash (app/index) has drawn
// the same logo in the same place, so the hand-off is invisible.
void SplashScreen.preventAutoHideAsync().catch(() => {});

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
        <Stack.Screen name="index" options={{ contentStyle: { backgroundColor: colors.splash } }} />
        <Stack.Screen name="login" options={{ contentStyle: { backgroundColor: "#fbfbf9" } }} />
        <Stack.Screen name="welcome" />
      </Stack>
    </PhoneFrame>
  );
}
