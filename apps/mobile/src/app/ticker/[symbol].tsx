import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { analystsFor, analystsLabel, type Relation } from "@falcon/ripple";
import { PushedScreen } from "@/components/PushedScreen";
import { Reveal } from "@/components/Reveal";
import { useConnections, type Connection } from "@/lib/connections";
import { currentUserId } from "@/lib/home";
import { syncFocusList } from "@/lib/focusList";
import { haptics } from "@/lib/haptics";
import { addHolding, heldTickers } from "@/lib/holdings";
import { TICKER_PATTERN, tickerNames } from "@/lib/onboarding";
import { cardsForTicker, tickerDirection, useSightings } from "@/lib/sightings";
import { Quote } from "@/features/sightings/Evidence";
import { DirectionIcon, SightingCard, cardStyles } from "@/features/sightings/SightingCard";
import { DIRECTION, directionColor, directionSoft } from "@/features/sightings/format";
import { EmptyTitle, SectionHeader, SkeletonCard } from "@/features/sightings/parts";
import { colors, fonts } from "@/theme";

/** Connections shown before "Show all". */
const FIRST_CONNECTIONS = 8;

const GROUPS: { relation: Relation | null; title: string }[] = [
  { relation: "customer", title: "Customers" },
  { relation: "supplier", title: "Suppliers" },
  { relation: "competitor", title: "Competitors" },
  { relation: "peer", title: "Peers" },
  { relation: null, title: "Other links" },
];

function ConnectionBlock({ connection, onOpen }: { connection: Connection; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = connection.evidence;
  return (
    <View>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${connection.ticker}, ${connection.name}`}
        onPress={onOpen}
        hitSlop={6}
        style={({ pressed }) => [styles.connectionName, pressed ? styles.pressed : null]}
      >
        <Text style={styles.connectionTicker}>{connection.ticker}</Text>
        {connection.name && connection.name !== connection.ticker ? (
          <Text style={styles.connectionCompany} numberOfLines={1}>
            {connection.name}
          </Text>
        ) : null}
      </Pressable>
      {first ? (
        <View style={styles.quotes}>
          <Quote evidence={first} lines={open ? undefined : 5} />
          {open ? rest.map((evidence, i) => <Quote key={`${evidence.url}-${i}`} evidence={evidence} />) : null}
          {rest.length > 0 && !open ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                haptics.select();
                setOpen(true);
              }}
              hitSlop={8}
            >
              {({ pressed }) => (
                <Text style={[styles.more, pressed ? styles.pressed : null]}>
                  {rest.length === 1 ? "1 more filing" : `${rest.length} more filings`}
                </Text>
              )}
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One company: today's Sightings that reach it and its filing-backed
 * connections (customers, suppliers, competitors) with the quotes behind them.
 */
export default function TickerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ symbol: string }>();
  const ticker = String(params.symbol ?? "").toUpperCase();
  const sightings = useSightings();
  const allCards = useMemo(() => sightings.feed?.cards ?? [], [sightings.feed]);
  const cards = useMemo(() => cardsForTicker(allCards, ticker), [allCards, ticker]);
  const held = useMemo(() => heldTickers(sightings.holdings), [sightings.holdings]);
  const isHeld = held.has(ticker);
  const direction = tickerDirection(allCards, ticker);
  const analysts = analystsFor(allCards, ticker);
  const graph = useConnections(ticker, allCards);
  const [showAll, setShowAll] = useState(false);
  const [secName, setSecName] = useState<string | null>(null);

  // The name: the focus list's, then today's cards', then the graph's, then the SEC list.
  const heldName = sightings.holdings?.stocks.find((s) => s.ticker === ticker)?.name || null;
  const cardName =
    cards.find((c) => c.event.ticker.toUpperCase() === ticker)?.event.companyName ??
    cards.flatMap((c) => c.hits).find((h) => h.ticker.toUpperCase() === ticker)?.companyName ??
    null;
  const knownName = heldName || cardName || graph.name;
  const name = knownName || secName;

  useEffect(() => {
    if (knownName || !TICKER_PATTERN.test(ticker)) return;
    let live = true;
    void tickerNames([ticker]).then((names) => {
      if (live && names[ticker]) setSecName(names[ticker]);
    });
    return () => {
      live = false;
    };
  }, [knownName, ticker]);

  const ordered = useMemo(() => {
    const rank = (r: Relation | null) => GROUPS.findIndex((g) => g.relation === r);
    return [...graph.connections].sort((a, b) => rank(a.relation) - rank(b.relation));
  }, [graph.connections]);
  const visible = showAll ? ordered : ordered.slice(0, FIRST_CONNECTIONS);
  const groups = GROUPS.map((g) => ({ ...g, items: visible.filter((c) => c.relation === g.relation) })).filter(
    (g) => g.items.length > 0,
  );

  const open = (symbol: string) => {
    haptics.select();
    router.push({ pathname: "/ticker/[symbol]", params: { symbol } });
  };

  const add = async () => {
    if (addHolding({ ticker, name: name ?? "" }, await currentUserId())) {
      haptics.success();
      syncFocusList();
    }
  };

  const loading = sightings.status === "loading";

  return (
    <PushedScreen
      right={
        !isHeld && sightings.holdings !== undefined && TICKER_PATTERN.test(ticker) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Add ${ticker} to your portfolio`}
            onPress={() => void add()}
            hitSlop={8}
            style={({ pressed }) => [styles.addButton, pressed ? styles.addPressed : null]}
          >
            <Text style={styles.addText}>Add</Text>
          </Pressable>
        ) : null
      }
    >
      <Reveal order={0}>
        {/* The ticker over the name, unless the name is the ticker itself. */}
        {name && name.toUpperCase() !== ticker ? (
          <View style={styles.kickerRow}>
            <Text style={styles.kicker}>{ticker}</Text>
            {isHeld ? <Text style={styles.heldTag}>Held</Text> : null}
          </View>
        ) : isHeld ? (
          <View style={styles.kickerRow}>
            <Text style={styles.heldTag}>Held</Text>
          </View>
        ) : null}
        <Text style={styles.title} accessibilityRole="header">
          {name || ticker}
        </Text>
        {analysts !== null ? <Text style={styles.analysts}>{analystsLabel(analysts)}</Text> : null}
        {!loading && cards.length > 0 ? (
          <View style={styles.today}>
            {direction ? (
              <View style={[styles.direction, { backgroundColor: directionSoft(direction) }]}>
                <DirectionIcon direction={direction} size={14} />
                <Text style={[styles.directionText, { color: directionColor(direction) }]}>{DIRECTION[direction]}</Text>
              </View>
            ) : null}
            <Text style={styles.todayText}>
              {cards.length} {cards.length === 1 ? "sighting" : "sightings"}
            </Text>
          </View>
        ) : null}
      </Reveal>

      <View style={styles.section}>
        <Reveal order={1}>
          <SectionHeader title="Sightings" />
        </Reveal>
        {loading ? (
          <SkeletonCard />
        ) : cards.length === 0 ? (
          <Reveal order={2} style={styles.emptyBox}>
            <Text style={styles.emptyText}>No sightings yet</Text>
          </Reveal>
        ) : (
          <View style={styles.cards}>
            {cards.map((card, i) => (
              <Reveal key={card.id} order={2 + Math.min(i, 4)}>
                <SightingCard
                  card={card}
                  held={held}
                  onPress={() => router.push({ pathname: "/sighting/[id]", params: { id: card.id } })}
                />
              </Reveal>
            ))}
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Reveal order={3}>
          <SectionHeader title="Connections" />
        </Reveal>
        {graph.status === "loading" ? (
          <SkeletonCard />
        ) : groups.length === 0 ? (
          <EmptyTitle title="No filing links yet" />
        ) : (
          <Reveal order={4}>
            {groups.map((group, gi) => (
              <View key={group.title} style={gi > 0 ? styles.groupGap : null}>
                <Text style={styles.groupLabel}>{group.title}</Text>
                {group.items.map((connection, i) => (
                  <View key={connection.ticker} style={i > 0 ? styles.connectionDivider : styles.connectionFirst}>
                    <ConnectionBlock connection={connection} onOpen={() => open(connection.ticker)} />
                  </View>
                ))}
              </View>
            ))}
            {ordered.length > visible.length ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  haptics.select();
                  setShowAll(true);
                }}
                style={({ pressed }) => [styles.showAll, pressed ? styles.showAllPressed : null]}
              >
                <Text style={styles.showAllText}>Show all {ordered.length}</Text>
              </Pressable>
            ) : null}
          </Reveal>
        )}
      </View>
    </PushedScreen>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  addButton: {
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  addPressed: { opacity: 0.85 },
  addText: { fontFamily: fonts.sans, fontSize: 14, color: colors.primaryText },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  analysts: { marginTop: 4, fontFamily: fonts.sans, fontSize: 13, color: colors.faint },
  kicker: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.5)",
  },
  heldTag: {
    fontFamily: fonts.mono,
    fontSize: 9.5,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: colors.muted,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    overflow: "hidden",
    backgroundColor: "rgba(0, 0, 0, 0.05)",
  },
  title: {
    marginTop: 10,
    fontFamily: fonts.serif,
    fontSize: 30,
    lineHeight: 39,
    letterSpacing: -0.4,
    color: colors.ink,
  },
  today: { marginTop: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  direction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 28,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: 14,
  },
  directionText: { fontFamily: fonts.sansMedium, fontSize: 13 },
  todayText: { fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  section: { marginTop: 40 },
  cards: { gap: 12 },
  emptyBox: { ...cardStyles.surface, boxShadow: "none", paddingVertical: 22, alignItems: "center" },
  emptyText: { fontFamily: fonts.serif, fontSize: 16, lineHeight: 24, color: colors.muted },
  groupGap: { marginTop: 30 },
  groupLabel: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.45)",
  },
  connectionFirst: { marginTop: 14 },
  connectionDivider: { marginTop: 20, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.divider },
  connectionName: { flexDirection: "row", alignItems: "baseline", gap: 10, alignSelf: "flex-start", maxWidth: "100%" },
  connectionTicker: { fontFamily: fonts.mono, fontSize: 15, color: colors.ink },
  connectionCompany: { flexShrink: 1, fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  quotes: { marginTop: 12, gap: 14 },
  more: { fontFamily: fonts.sans, fontSize: 13.5, color: colors.muted, paddingLeft: 16 },
  showAll: {
    marginTop: 28,
    height: 46,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  showAllPressed: { backgroundColor: "rgba(0, 0, 0, 0.03)" },
  showAllText: { fontFamily: fonts.sans, fontSize: 14.5, color: colors.ink },
});
