import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { supabase } from "@/lib/supabase";
import { isApproved } from "@/lib/auth";
import { needsOnboarding } from "@/lib/user-preferences";
import { PRODUCT } from "@/theme";

/**
 * Signed-in shell. The tab bar is Apple's own: `NativeTabs` mounts a real
 * UITabBarController, so on iOS 26 the bar is the system Liquid Glass one —
 * its morph, press response, haptics and scroll-edge behaviour come from
 * UIKit rather than being rebuilt in JS. The hand-built floating bar this
 * replaced could carry the material (expo-glass-effect is a thin wrapper over
 * UIGlassEffect) but never the behaviour.
 *
 * Recent, Watchlist, Portfolio, Analysis and Agents are the bar; Settings,
 * Brokers, Events and Graph stay drill-in screens.
 *
 * The icons are the same SF Symbols the bar used to name directly, handed over
 * as raster art instead. UIKit draws an `sf=` symbol at a size of its own
 * choosing and neither NativeTabs nor react-native-screens exposes a knob for
 * it, whereas an item made from an image is drawn at that image's own point
 * size — which is how these come out smaller than the 25pt standard.
 * scripts/render-tab-icons.swift regenerates them: change the size there, not
 * here. Both slots of a two-state icon are images, which is what keeps
 * react-native-screens from rejecting the pair as mismatched types.
 *
 * The bar cannot be made to minimize on scroll here, so do not reach for
 * `minimizeBehavior`: UIKit only collapses a tab bar it has been handed a
 * scroll view for, via `setContentScrollView:forEdge:`, and react-native-screens
 * only makes that call from its gamma path (`RNS_GAMMA_ENABLED`), which is
 * compiled out of the runtimes we ship against — the selector is absent from
 * the Expo Go binary entirely. The prop is accepted and then does nothing.
 */
export default function AppLayout() {
  // "pending" = has a session but is not an approved member; such users must not
  // reach the product surface (which reads the signal/event/graph feed). Gate on
  // approval, not merely the presence of a session.
  const [gate, setGate] = useState<"checking" | "in" | "out" | "pending" | "onboarding">(
    "checking",
  );

  useEffect(() => {
    let cancelled = false;
    const classify = (session: { user: Parameters<typeof isApproved>[0] } | null) => {
      if (!session) return "out";
      if (!isApproved(session.user)) return "pending";
      if (needsOnboarding(session.user)) return "onboarding";
      return "in";
    };

    void (async () => {
      const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
      if (!cancelled) setGate(classify(data.session));
    })();

    const sub = supabase?.auth.onAuthStateChange((_e, next) => {
      if (!cancelled) setGate(classify(next));
    });

    return () => {
      cancelled = true;
      sub?.data.subscription.unsubscribe();
    };
  }, []);

  if (gate === "checking") {
    return (
      <View style={styles.gate}>
        <ActivityIndicator color={PRODUCT.fgMuted} />
      </View>
    );
  }

  if (gate === "out") return <Redirect href="/login" />;
  if (gate === "pending") return <Redirect href="/status" />;
  if (gate === "onboarding") return <Redirect href="/onboarding" />;

  return (
    <NativeTabs
      // At rest the bar reads as supporting text; the tab you are on — and the
      // one the selection glass is sitting over — comes forward to the ink the
      // rest of the product is set in. UIKit renders tab icons as templates,
      // so the colour has to come from here — a baked-in one is ignored.
      iconColor={{ default: PRODUCT.fgMuted, selected: PRODUCT.fg }}
      labelStyle={{
        default: { color: PRODUCT.fgMuted },
        selected: { color: PRODUCT.fg },
      }}
      tintColor={PRODUCT.fg}
    >
      <NativeTabs.Trigger name="insight">
        <NativeTabs.Trigger.Icon
          src={require("../../assets/tabs/discover.png")}
        />
        <NativeTabs.Trigger.Label>Discover</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon
          src={require("../../assets/tabs/watchlist.png")}
        />
        <NativeTabs.Trigger.Label>Watchlist</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="dashboard">
        <NativeTabs.Trigger.Icon
          src={require("../../assets/tabs/portfolio.png")}
        />
        <NativeTabs.Trigger.Label>Portfolio</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>



      {/* Reachable by pushing, never shown in the bar. */}
      <NativeTabs.Trigger name="analyze">
        <NativeTabs.Trigger.Icon src={require("../../assets/tabs/analysis.png")} />
        <NativeTabs.Trigger.Label>Analysis</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="agents-home">
        <NativeTabs.Trigger.Icon src={require("../../assets/tabs/agents.png")} />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings" hidden />
      <NativeTabs.Trigger name="brokers" hidden />
    </NativeTabs>
  );
}

const styles = StyleSheet.create({
  gate: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: PRODUCT.bg,
  },
});
