import { NativeTabs } from "expo-router/native-tabs";
import { colors } from "@/theme";

/**
 * The home tabs on the phone: the system tab bar (Liquid Glass on iOS 26),
 * SF Symbols, the site's dark primary as the tint. The browser preview draws
 * its own bar instead (_layout.web.tsx).
 */
export default function TabsLayout() {
  return (
    <NativeTabs tintColor={colors.primary}>
      <NativeTabs.Trigger name="today">
        <NativeTabs.Trigger.Icon sf={{ default: "sunrise", selected: "sunrise.fill" }} />
        <NativeTabs.Trigger.Label>Today</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="sightings">
        <NativeTabs.Trigger.Icon sf={{ default: "binoculars", selected: "binoculars.fill" }} />
        <NativeTabs.Trigger.Label>Sightings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="portfolio">
        <NativeTabs.Trigger.Icon sf={{ default: "briefcase", selected: "briefcase.fill" }} />
        <NativeTabs.Trigger.Label>Portfolio</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="you">
        <NativeTabs.Trigger.Icon sf={{ default: "person.crop.circle", selected: "person.crop.circle.fill" }} />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
