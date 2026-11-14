import { Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { cardExplain, cardPricedIn, type CardStrength, type Direction, type RippleCard, type RippleHit } from "@falcon/ripple";
import { orderedHits } from "@/lib/sightings";
import { EASE_CALM, colors, fonts } from "@/theme";
import { directionColor, directionSoft, hitSignalLabel, isSelfHit, timeAgo } from "./format";

/** Four chips fit one line; with more, three and a "+N" so it stays one line. */
const MAX_CHIPS = 4;

export function DirectionIcon({ direction, size = 14 }: { direction: Direction; size?: number }) {
  const color = directionColor(direction);
  if (direction === "up") return <ArrowUpRight size={size} strokeWidth={2} color={color} />;
  if (direction === "down") return <ArrowDownRight size={size} strokeWidth={2} color={color} />;
  return <Minus size={size} strokeWidth={2} color={color} />;
}

/** The small "May be priced in" label: the move since the event already went past half its usual reaction. */
export function PricedInTag() {
  return (
    <View style={styles.priced}>
      <Text style={styles.pricedText}>May be priced in</Text>
    </View>
  );
}

/**
 * How much evidence stands behind a card: "Measured by Falcon" (filled,
 * strongest), "Backed by research" (subtle fill), "Watching" (faint outline).
 */
export function StrengthBadge({ strength }: { strength: CardStrength }) {
  const box =
    strength.level === "measured" ? styles.badgeMeasured : strength.level === "research" ? styles.badgeResearch : styles.badgeWatching;
  const text =
    strength.level === "measured"
      ? styles.badgeMeasuredText
      : strength.level === "research"
        ? styles.badgeResearchText
        : styles.badgeWatchingText;
  return (
    <View style={[styles.badge, box]}>
      <Text style={[styles.badgeText, text]} numberOfLines={1}>
        {strength.label}
      </Text>
    </View>
  );
}

/** "↑ Positive signal for KGS": the one company an own-firm card is about. */
export function SignalPill({ hit }: { hit: RippleHit }) {
  return (
    <View style={[styles.pill, { backgroundColor: directionSoft(hit.direction) }]}>
      <DirectionIcon direction={hit.direction} size={14} />
      <Text style={[styles.pillText, { color: directionColor(hit.direction) }]} numberOfLines={1}>
        {hitSignalLabel(hit.direction)} for {hit.ticker}
      </Text>
    </View>
  );
}

function TickerChip({ hit, held }: { hit: RippleHit; held: boolean }) {
  return (
    <View style={[styles.chip, held ? styles.chipHeld : null]}>
      <Text style={styles.chipTicker}>{hit.ticker}</Text>
      <DirectionIcon direction={hit.direction} size={13} />
    </View>
  );
}

/** Whether every hit on the card is the event company itself (insider buying, a late filing). */
export function selfOnly(card: RippleCard): boolean {
  return card.hits.length > 0 && card.hits.every((h) => isSelfHit(h, card.event.ticker));
}

/**
 * One Sighting in plain words: what kind of event, a short headline, why it
 * matters, which companies it points at and which way, and what happened
 * after similar events. Held tickers come first and read darker.
 */
export function SightingCard({ card, held, onPress }: { card: RippleCard; held: Set<string>; onPress: () => void }) {
  const press = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: 1 - press.value * 0.015 }] }));

  const ex = cardExplain(card);
  const hits = orderedHits(card, held);
  const self = selfOnly(card);
  const shown = hits.slice(0, hits.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS);
  const more = hits.length - shown.length;
  const pricedIn = cardPricedIn(card);
  const when = timeAgo(card.event.occurredAt);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ex.kicker}, ${card.event.ticker}. ${ex.title}. ${ex.whyShort} ${ex.strength.label}.`}
      onPress={onPress}
      onPressIn={() => (press.value = withTiming(1, { duration: 120, easing: EASE_CALM }))}
      onPressOut={() => (press.value = withTiming(0, { duration: 220, easing: EASE_CALM }))}
    >
      {({ pressed }) => (
        <Animated.View style={[styles.card, pressed ? styles.cardPressed : null, animated]}>
          <View style={styles.top}>
            <View style={styles.topLeft}>
              <Text style={[styles.kicker, styles.kickerShrink]} numberOfLines={1}>
                {ex.kicker}
              </Text>
              <Text style={[styles.kicker, styles.dot]}>·</Text>
              <Text style={[styles.kicker, styles.fixed]} numberOfLines={1}>
                {card.event.ticker}
              </Text>
              {when ? (
                <Text style={[styles.time, styles.fixed]} numberOfLines={1}>
                  {when}
                </Text>
              ) : null}
            </View>
            <StrengthBadge strength={ex.strength} />
          </View>
          <Text style={styles.headline}>{ex.title}</Text>
          <Text style={styles.why}>{ex.whyShort}</Text>

          {self && hits[0] ? (
            <View style={styles.chips}>
              <SignalPill hit={hits[0]} />
              {pricedIn ? <PricedInTag /> : null}
            </View>
          ) : shown.length > 0 ? (
            <View style={styles.chips}>
              {shown.map((hit) => (
                <TickerChip key={`${hit.ticker}-${hit.relation}`} hit={hit} held={held.has(hit.ticker.toUpperCase())} />
              ))}
              {more > 0 ? (
                <View style={[styles.chip, styles.chipMore]}>
                  <Text style={styles.chipMoreText}>+{more}</Text>
                </View>
              ) : null}
              {pricedIn ? <PricedInTag /> : null}
            </View>
          ) : null}

          {ex.pastShort ? <Text style={styles.past}>{ex.pastShort}</Text> : null}
        </Animated.View>
      )}
    </Pressable>
  );
}

export const cardStyles = StyleSheet.create({
  surface: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.065)",
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 32px -18px rgba(0, 0, 0, 0.18)",
  },
});

const styles = StyleSheet.create({
  card: { ...cardStyles.surface, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 16 },
  cardPressed: { backgroundColor: "#fbfbfa" },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  topLeft: { flexShrink: 1, flexDirection: "row", alignItems: "baseline" },
  kicker: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.5)",
  },
  kickerShrink: { flexShrink: 1 },
  fixed: { flexShrink: 0 },
  dot: { flexShrink: 0, marginHorizontal: 3, letterSpacing: 0 },
  time: { marginLeft: 6, fontFamily: fonts.sans, fontSize: 11.5, color: colors.faint },
  badge: { flexShrink: 0, height: 22, paddingHorizontal: 7, borderRadius: 11, justifyContent: "center", borderWidth: 1 },
  badgeText: { fontFamily: fonts.sansMedium, fontSize: 11, lineHeight: 14 },
  badgeMeasured: { backgroundColor: colors.primary, borderColor: colors.primary },
  badgeMeasuredText: { color: colors.primaryText },
  badgeResearch: { backgroundColor: "rgba(0, 0, 0, 0.055)", borderColor: "transparent" },
  badgeResearchText: { color: colors.ink },
  badgeWatching: { backgroundColor: "transparent", borderColor: "rgba(0, 0, 0, 0.10)" },
  badgeWatchingText: { color: colors.faint },
  priced: {
    height: 28,
    justifyContent: "center",
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.12)",
  },
  pricedText: { fontFamily: fonts.sans, fontSize: 12, color: colors.body },
  headline: { marginTop: 10, fontFamily: fonts.serif, fontSize: 17, lineHeight: 25, color: colors.ink },
  why: { marginTop: 6, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.muted },
  chips: { marginTop: 14, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 28,
    paddingLeft: 8,
    paddingRight: 11,
    borderRadius: 14,
    flexShrink: 1,
  },
  pillText: { fontFamily: fonts.sansMedium, fontSize: 13 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 28,
    paddingLeft: 10,
    paddingRight: 8,
    borderRadius: 8,
    backgroundColor: "rgba(0, 0, 0, 0.035)",
  },
  chipHeld: { backgroundColor: "rgba(0, 0, 0, 0.075)" },
  chipTicker: { fontFamily: fonts.mono, fontSize: 12.5, color: colors.ink },
  chipMore: { paddingRight: 10, backgroundColor: "transparent", borderWidth: 1, borderColor: "rgba(0, 0, 0, 0.07)" },
  chipMoreText: { fontFamily: fonts.mono, fontSize: 12, color: colors.muted },
  past: { marginTop: 12, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 17, color: colors.body },
});
