import { Tabs } from "expo-router/tabs";
import { TabBar } from "@/components/TabBar";
import { colors } from "@/theme";

/**
 * Browser preview: the same four tabs with a drawn iOS 26 style floating
 * bar (components/TabBar.tsx), since the system bar exists only on the phone.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        animation: "fade",
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="today" options={{ title: "Today" }} />
      <Tabs.Screen name="sightings" options={{ title: "Sightings" }} />
      <Tabs.Screen name="portfolio" options={{ title: "Portfolio" }} />
      <Tabs.Screen name="you" options={{ title: "You" }} />
    </Tabs>
  );
}
