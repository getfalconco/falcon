import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Reveal } from "@/components/Reveal";
import { TabScreen } from "@/components/TabScreen";
import { heldTickers } from "@/lib/holdings";
import { opportunityCards, portfolioCards, useSightings } from "@/lib/sightings";
import { Segmented } from "@/features/sightings/Segmented";
import { SightingCard } from "@/features/sightings/SightingCard";
import { EmptyTitle, SampleTag, ScreenTitle, SkeletonCard } from "@/features/sightings/parts";

type Tab = "portfolio" | "opportunities";

const TABS = [
  { id: "portfolio", label: "Your Portfolio" },
  { id: "opportunities", label: "Opportunities" },
] as const satisfies readonly { id: Tab; label: string }[];

/** Sightings: the full feed, split into what reaches the portfolio and what reaches other companies. */
export default function Sightings() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === "opportunities" ? "opportunities" : "portfolio");
  const sightings = useSightings();
  const held = useMemo(() => heldTickers(sightings.holdings), [sightings.holdings]);

  // "See all" on Today opens a given tab.
  useEffect(() => {
    if (params.tab !== "portfolio" && params.tab !== "opportunities") return;
    setTab(params.tab);
    // Cleared so the next "See all" with the same tab applies again.
    router.setParams({ tab: undefined });
  }, [params.tab, router]);

  const cards = useMemo(() => {
    const all = sightings.feed?.cards ?? [];
    return tab === "portfolio"
      ? portfolioCards(all, held)
      : opportunityCards(all, held, sightings.holdings?.sectors ?? []);
  }, [held, sightings.feed, sightings.holdings, tab]);

  const loading = sightings.status === "loading";
  const emptyTitle =
    tab === "portfolio" && held.size === 0 && sightings.status === "ready"
      ? "No holdings added yet"
      : tab === "portfolio"
        ? "No sightings yet"
        : "No opportunities yet";

  return (
    <TabScreen onRefresh={sightings.refresh}>
      <Reveal order={0}>
        <ScreenTitle title="Sightings" right={sightings.sample && !loading ? <SampleTag /> : undefined} />
      </Reveal>
      <Reveal order={1} style={styles.segmented}>
        <Segmented options={TABS} value={tab} onChange={setTab} />
      </Reveal>

      {loading ? (
        <View style={styles.cards}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : cards.length === 0 ? (
        <Reveal key={`empty-${tab}`} order={0}>
          <EmptyTitle title={emptyTitle} />
        </Reveal>
      ) : (
        <View key={tab} style={styles.cards}>
          {cards.map((card, i) => (
            <Reveal key={card.id} order={Math.min(i, 6)}>
              <SightingCard
                card={card}
                held={held}
                onPress={() => router.push({ pathname: "/sighting/[id]", params: { id: card.id } })}
              />
            </Reveal>
          ))}
        </View>
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  segmented: { marginTop: 22 },
  cards: { marginTop: 20, gap: 12 },
});
