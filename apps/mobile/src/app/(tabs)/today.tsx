import { useEffect, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { anyClearsBar } from "@falcon/ripple";
import { Reveal } from "@/components/Reveal";
import { TabScreen } from "@/components/TabScreen";
import { heldTickers } from "@/lib/holdings";
import { firstHowToRead } from "@/lib/howToRead";
import { buildToday, summaryLine, useSightings } from "@/lib/sightings";
import { DirectionRing } from "@/features/sightings/DirectionRing";
import { SightingCard } from "@/features/sightings/SightingCard";
import { longDate } from "@/features/sightings/format";
import {
  Avatar,
  EmptyTitle,
  HelpButton,
  SampleTag,
  ScreenTitle,
  SectionHeader,
  SkeletonCard,
} from "@/features/sightings/parts";
import { colors, fonts } from "@/theme";

const PORTFOLIO_CARDS = 3;
const OPPORTUNITY_CARDS = 2;

/** The guide opens this long after Today first shows, once the page has settled. */
const GUIDE_DELAY_MS = 700;

/**
 * Today: one line counting the day's Sightings, the daily Net direction
 * ring, one line on why, the events hitting the portfolio and a couple of
 * opportunities outside it. The first time, "How to read a Sighting" opens
 * over it.
 */
export default function Today() {
  const router = useRouter();
  const sightings = useSightings();
  const today = useMemo(() => buildToday(sightings.feed, sightings.holdings), [sightings.feed, sightings.holdings]);
  const held = useMemo(() => heldTickers(sightings.holdings), [sightings.holdings]);

  const loading = sightings.status === "loading";
  const empty = sightings.status === "unavailable";
  // Only Watch-tier cards (or none at all): nothing reaches the main sections.
  const nothingCleared = sightings.status === "ready" && !anyClearsBar(sightings.feed?.cards ?? []);
  const portfolio = today.portfolio.slice(0, PORTFOLIO_CARDS);
  const opportunities = today.opportunities.slice(0, OPPORTUNITY_CARDS);

  const summary = useMemo(
    () => summaryLine(sightings.feed?.cards ?? [], held),
    [sightings.feed, held],
  );

  // First launch after sign-in: explain the cards once.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    void firstHowToRead().then((first) => {
      if (first && live) timer = setTimeout(() => router.push("/how-to-read"), GUIDE_DELAY_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  const open = (id: string) => router.push({ pathname: "/sighting/[id]", params: { id } });
  const seeAll = (tab: "portfolio" | "opportunities") => router.navigate({ pathname: "/sightings", params: { tab } });

  let order = 4;
  const next = () => order++;

  return (
    <TabScreen onRefresh={sightings.refresh}>
      <Reveal order={0}>
        <ScreenTitle
          kicker={longDate(new Date())}
          title="Today"
          right={
            <View style={styles.headerButtons}>
              <HelpButton onPress={() => router.push("/how-to-read")} />
              <Avatar onPress={() => router.navigate("/you")} />
            </View>
          }
        />
        {sightings.sample && !loading ? (
          <View style={styles.sampleRow}>
            <SampleTag />
          </View>
        ) : null}
      </Reveal>

      <Reveal order={1}>
        <Text style={styles.summary}>{loading || empty ? " " : summary}</Text>
      </Reveal>

      <Reveal order={2} style={styles.ring}>
        <DirectionRing value={loading ? null : today.metric.value} label={today.metric.label} pending={loading} />
      </Reveal>

      <Reveal order={3}>
        <Text style={styles.why}>{loading || empty || nothingCleared ? " " : today.why}</Text>
      </Reveal>

      {loading ? (
        <View style={[styles.section, styles.cards]}>
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : empty ? (
        <Reveal order={4}>
          <EmptyTitle title="No sightings yet" />
        </Reveal>
      ) : nothingCleared || (portfolio.length === 0 && opportunities.length === 0) ? (
        <Reveal order={4}>
          <EmptyTitle title={nothingCleared ? "Nothing backed by evidence today" : "Nothing is hitting your portfolio today"} />
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
  headerButtons: { flexDirection: "row", alignItems: "center", gap: 10 },
  summary: { marginTop: 14, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, color: colors.body },
  ring: { marginTop: 30 },
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
