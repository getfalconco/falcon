import { View } from "react-native";
import { Screen } from "@/components/product-ui";

/**
 * Watchlist — deliberately empty, like Analysis and Agents. The tracking-agent
 * screen that used to live here is gone; the route stays so the tab has
 * somewhere to land.
 */
export default function WatchlistScreen() {
  return (
    <Screen>
      <View />
    </Screen>
  );
}
