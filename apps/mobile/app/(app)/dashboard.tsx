import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Screen, useNavClearance } from "@/components/product-ui";
import HoldingsPanel from "@/components/HoldingsPanel";
import InsightCard from "@/components/InsightCard";
import ModuleCard from "@/components/ModuleCard";
import PortfolioChangeRow from "@/components/PortfolioChangeRow";
import { useDashboardModules } from "@/lib/dashboard-modules";
import { supabase } from "@/lib/supabase";
import { formatNetworth, usePortfolioBalance } from "@/lib/use-portfolio-balance";
import { FONTS, PRODUCT, PTYPE } from "@/theme";

function greetingFor(d: Date): "morning" | "afternoon" | "evening" {
  const h = d.getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

const MASK = "$*****";

export default function DashboardScreen() {
  const [firstName, setFirstName] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [holdingsRefresh, setHoldingsRefresh] = useState(0);
  // The insight card runs to the floating nav: the scroll viewport now reaches
  // the bottom edge of the screen, so the card's height is that viewport minus
  // wherever it starts, minus the nav's own room.
  const [viewport, setViewport] = useState(0);
  const [insightTop, setInsightTop] = useState(0);
  const { balance, balanceReady } = usePortfolioBalance();
  const { hidden, hide } = useDashboardModules();
  const navClearance = useNavClearance();

  const [now] = useState(() => new Date());

  const load = useCallback(async () => {
    setHoldingsRefresh((n) => n + 1);
    try {
      const { data } = await supabase!.auth.getUser();
      const full = (data.user?.user_metadata?.full_name as string | undefined) ?? "";
      setFirstName(full.trim().split(/\s+/)[0] ?? "");
    } catch {
      // The greeting falls back to the bare time of day; nothing else on this
      // screen depends on the profile, so a failed lookup is not worth an error.
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const timeGreeting = (() => {
    const g = greetingFor(now);
    return g.charAt(0).toUpperCase() + g.slice(1);
  })();
  const shown = balanceReady ? balance : 0;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: navClearance }]}
        scrollIndicatorInsets={{ bottom: navClearance }}
        onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
            tintColor={PRODUCT.fgSubtle}
          />
        }
      >
        <Text
          style={[PTYPE.greetingTime, styles.greeting]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
        >
          {firstName ? `${timeGreeting}, ${firstName}` : timeGreeting}
        </Text>

        {/* The balance is its own privacy control — tap it to mask, tap again
            to show. Nothing else on the screen carries a number this large, so
            it does not need a separate eye button to explain itself. */}
        <Pressable
          onPress={() => setPrivacyMode((v) => !v)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={privacyMode ? "Show balances" : "Hide balances"}
        >
          <Text
            style={[PTYPE.heroNumeral, styles.hero]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.45}
          >
            {privacyMode ? MASK : formatNetworth(shown)}
          </Text>
        </Pressable>

        <PortfolioChangeRow masked={privacyMode} />

        {/* Each card is a module: long-press offers to delete it. The gap
            between them lives here rather than inside the cards. */}
        {!hidden.includes("insight") ? (
          <View
            style={styles.module}
            onLayout={(e) => setInsightTop(e.nativeEvent.layout.y)}
          >
            <ModuleCard title="Insight" onDelete={() => hide("insight")}>
              <InsightCard
                minHeight={
                  viewport > 0 && insightTop > 0
                    ? Math.max(0, viewport - insightTop - navClearance)
                    : 0
                }
              />
            </ModuleCard>
          </View>
        ) : null}

        {!hidden.includes("holdings") ? (
          <View style={styles.module}>
            <ModuleCard title="Assets" onDelete={() => hide("holdings")}>
              <HoldingsPanel
                masked={privacyMode}
                onToggleMasked={() => setPrivacyMode((v) => !v)}
                refreshKey={holdingsRefresh}
                onPaperCreated={() => setHoldingsRefresh((n) => n + 1)}
              />
            </ModuleCard>
          </View>
        ) : null}

      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // `paddingBottom` comes from useNavClearance() at render time.
  scroll: { paddingHorizontal: 20, paddingTop: 12 },
  greeting: { marginBottom: 18 },
  module: { marginBottom: 12 },
  hero: { marginBottom: 6 },
});
