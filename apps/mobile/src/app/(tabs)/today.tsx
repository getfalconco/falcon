import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Reveal } from "@/components/Reveal";
import { TabScreen } from "@/components/TabScreen";
import { heldTickers } from "@/lib/holdings";
import { buildToday, useSightings } from "@/lib/sightings";
import { DirectionRing } from "@/features/sightings/DirectionRing";
import { SightingCard } from "@/features/sightings/SightingCard";
import { longDate } from "@/features/sightings/format";
import { Avatar, EmptyTitle, SampleTag, ScreenTitle, SectionHeader, SkeletonCard } from "@/features/sightings/parts";
import { colors, fonts } from "@/theme";

const PORTFOLIO_CARDS = 3;
const OPPORTUNITY_CARDS = 2;

/**
 * Today: the daily Net direction ring, one line on why, the events hitting
 * the portfolio and a couple of opportunities outside it.
 */
export default function Today() {
  const router = useRouter();
  const sightings = useSightings();
  const today = useMemo(() => buildToday(sightings.feed, sightings.holdings), [sightings.feed, sightings.holdings]);
  const held = useMemo(() => heldTickers(sightings.holdings), [sightings.holdings]);

  const loading = sightings.status === "loading";
  const empty =
    sightings.status === "unavailable" || (sightings.status === "ready" && (sightings.feed?.cards.length ?? 0) === 0);
  const portfolio = today.portfolio.slice(0, PORTFOLIO_CARDS);
  const opportunities = today.opportunities.slice(0, OPPORTUNITY_CARDS);

  const open = (id: string) => router.push({ pathname: "/sighting/[id]", params: { id } });
  const seeAll = (tab: "portfolio" | "opportunities") => router.navigate({ pathname: "/sightings", params: { tab } });

  let order = 3;
  const next = () => order++;

  return (
    <TabScreen onRefresh={sightings.refresh}>
      <Reveal order={0}>
        <ScreenTitle
          kicker={longDate(new Date())}
          title="Today"
          right={<Avatar onPress={() => router.navigate("/you")} />}
        />
        {sightings.sample && !loading ? (
          <View style={styles.sampleRow}>
            <SampleTag />
          </View>
        ) : null}
      </Reveal>

      <Reveal order={1} style={styles.ring}>
        <DirectionRing value={loading ? null : today.metric.value} label={today.metric.label} pending={loading} />
      </Reveal>

      <Reveal order={2}>
        <Text style={styles.why}>{loading || empty ? " " : today.why}</Text>
      </Reveal>

      {loading ? (
        <View style={[styles.section, styles.cards]}>
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : empty ? (
        <Reveal order={3}>
          <EmptyTitle title="No sightings yet" />
        </Reveal>
      ) : (
        <>
          {portfolio.length > 0 ? (
            <View style={styles.section}>
              <Reveal order={next()}>
                <SectionHeader
                  title="Hitting your portfolio"
                  action={
                    today.portfolio.length > portfolio.length
                      ? { label: "See all", onPress: () => seeAll("portfolio") }
                      : undefined
                  }
                />
              </Reveal>
              <View style={styles.cards}>
                {portfolio.map((card) => (
                  <Reveal key={card.id} order={next()}>
                    <SightingCard card={card} held={held} onPress={() => open(card.id)} />
                  </Reveal>
                ))}
              </View>
            </View>
          ) : null}

          {opportunities.length > 0 ? (
            <View style={styles.section}>
              <Reveal order={next()}>
                <SectionHeader
                  title="Opportunities"
                  action={
                    today.opportunities.length > opportunities.length
                      ? { label: "See all", onPress: () => seeAll("opportunities") }
                      : undefined
                  }
                />
              </Reveal>
              <View style={styles.cards}>
                {opportunities.map((card) => (
                  <Reveal key={card.id} order={next()}>
                    <SightingCard card={card} held={held} onPress={() => open(card.id)} />
                  </Reveal>
                ))}
              </View>
            </View>
          ) : null}
        </>
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  sampleRow: { marginTop: 10 },
  ring: { marginTop: 36 },
  why: {
    marginTop: 26,
    alignSelf: "center",
    maxWidth: 300,
    textAlign: "center",
    fontFamily: fonts.sans,
    fontSize: 15.5,
    lineHeight: 23,
    color: colors.body,
  },
  section: { marginTop: 44 },
  cards: { gap: 12 },
});
