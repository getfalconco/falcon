import { View } from "react-native";
import { Screen } from "@/components/product-ui";

/**
 * Agents — deliberately empty, like Analysis. The route is `agents-home`
 * rather than `agents` because that name already belongs to the watchlist
 * screen behind the Watchlist tab.
 */
export default function AgentsHomeScreen() {
  return (
    <Screen>
      <View />
    </Screen>
  );
}
