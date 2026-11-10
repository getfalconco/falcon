import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import PhoneFrame from "@/components/PhoneFrame";

export default function RootLayout() {
  return (
    <PhoneFrame>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#ffffff" } }} />
    </PhoneFrame>
  );
}
