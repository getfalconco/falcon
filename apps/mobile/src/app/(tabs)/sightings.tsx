import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { anyClearsBar, cardStrength, type RippleCard } from "@falcon/ripple";
import { Reveal } from "@/components/Reveal";
import { TabScreen } from "@/components/TabScreen";
import { heldTickers } from "@/lib/holdings";
import { opportunityCards, portfolioCards, useSightings, weakOutsideCards } from "@/lib/sightings";
import { Segmented } from "@/features/sightings/Segmented";
import { SightingCard } from "@/features/sightings/SightingCard";
import {
  EmptyTitle,
  HelpButton,
  SampleTag,
  ScreenTitle,
  SectionHeader,
  SkeletonCard,
  WatchingSection,
} from "@/features/sightings/parts";

type Tab = "portfolio" | "opportunities";

/** Empty state when only cards Falcon is watching came in. */
const NOTHING_BACKED = "Nothing backed by evidence today";

const TABS = [
  { id: "portfolio", label: "Your Portfolio" },
  { id: "opportunities", label: "Opportunities" },
] as const satisfies readonly { id: Tab; label: string }[];

/** Splits cards into the ones with evidence behind them (measured, research) and the ones Falcon is only watching. */
function byEvidence(cards: readonly RippleCard[]): { evidence: RippleCard[]; watching: RippleCard[] } {
  const evidence: RippleCard[] = [];
  const watching: RippleCard[] = [];
  for (const card of cards) (cardStrength(card).level === "watching" ? watching : evidence).push(card);
  return { evidence, watching };
}

/**
 * Sightings: the full feed, split into what reaches the portfolio and what
 * reaches other companies; in each, the cards backed by evidence first and
 * the ones Falcon is only watching folded below.
 */
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

  // Cards with no evidence yet (Watch tier, or an older card without a tier) go last, folded under "Watching".
  const { cards, weak } = useMemo(() => {
    const all = sightings.feed?.cards ?? [];
    if (tab === "portfolio") {
      const split = byEvidence(portfolioCards(all, held));
      return { cards: split.evidence, weak: split.watching };
    }
    const split = byEvidence(opportunityCards(all, held, sightings.holdings?.sectors ?? []));
    const listed = new Set(split.watching.map((c) => c.id));
    const outside = weakOutsideCards(all, held).filter((c) => !listed.has(c.id));
    return { cards: split.evidence, weak: [...split.watching, ...outside] };
  }, [held, sightings.feed, sightings.holdings, tab]);

  const loading = sightings.status === "loading";
  const open = (id: string) => router.push({ pathname: "/sighting/[id]", params: { id } });
  const nothingCleared = sightings.status === "ready" && !anyClearsBar(sightings.feed?.cards ?? []);
  const emptyTitle =
    tab === "portfolio" && held.size === 0 && sightings.status === "ready"
      ? "No holdings added yet"
      : nothingCleared || (tab === "portfolio" && weak.length)
        ? NOTHING_BACKED
        : tab === "portfolio"
          ? "No sightings yet"
          : "No opportunities yet";

  return (
    <TabScreen onRefresh={sightings.refresh}>
      <Reveal order={0}>
        <ScreenTitle
          title="Sightings"
          right={
            <View style={styles.headerRight}>
              {sightings.sample && !loading ? <SampleTag /> : null}
              <HelpButton onPress={() => router.push("/how-to-read")} />
            </View>
          }
        />
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
      ) : (
        <View key={tab}>
          {cards.length === 0 ? (
            <Reveal order={0}>
              <EmptyTitle title={emptyTitle} />
            </Reveal>
          ) : (
            <View style={styles.cards}>
              <Reveal order={0}>
                <SectionHeader title="Backed by evidence" />
              </Reveal>
              {cards.map((card, i) => (
                <Reveal key={card.id} order={Math.min(i, 6)}>
                  <SightingCard card={card} held={held} onPress={() => open(card.id)} />
                </Reveal>
              ))}
            </View>
          )}
          <WatchingSection count={weak.length}>
            {weak.map((card) => (
              <SightingCard key={card.id} card={card} held={held} onPress={() => open(card.id)} />
            ))}
          </WatchingSection>
        </View>
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  segmented: { marginTop: 22 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  cards: { marginTop: 24, gap: 12 },
});
