import { Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { Confidence, Direction, RippleCard, RippleHit, RippleHistory } from "@falcon/ripple";
import { orderedHits } from "@/lib/sightings";
import { EASE_CALM, colors, fonts } from "@/theme";
import { CONFIDENCE, EVENT_KIND, directionColor, signedPct, timeAgo } from "./format";

/** Four chips fit one line; with more, three and a "+N" so it stays one line. */
const MAX_CHIPS = 4;

export function DirectionIcon({ direction, size = 14 }: { direction: Direction; size?: number }) {
  const color = directionColor(direction);
  if (direction === "up") return <ArrowUpRight size={size} strokeWidth={2} color={color} />;
  if (direction === "down") return <ArrowDownRight size={size} strokeWidth={2} color={color} />;
  return <Minus size={size} strokeWidth={2} color={color} />;
}

/** Three small bars, filled up to the confidence level. */
export function ConfidenceBars({ confidence }: { confidence: Confidence }) {
  const level = confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
  return (
    <View style={styles.bars} aria-hidden>
      {[1, 2, 3].map((i) => (
        <View key={i} style={[styles.bar, { height: 4 + i * 2 }, i <= level ? styles.barOn : null]} />
      ))}
    </View>
  );
}

/**
 * "Moved the implied way 7 of 9 times, avg +2.1% vs market, 5 trading days".
 * The average keeps its own sign (vs SPY); the count is against the hit's direction.
 * On a list card, `ticker` names which company the line is about.
 */
export function HistoryLine({ history, ticker }: { history: RippleHistory; ticker?: string }) {
  const times = Math.round(history.hitRate * history.sample);
  const days = history.windowDays === 1 ? "1 trading day" : `${history.windowDays} trading days`;
  return (
    <Text style={styles.history}>
      {ticker ? `${ticker} moved` : "Moved"} the implied way {times} of {history.sample} times, avg{" "}
      {signedPct(history.avgMovePct)} vs market, {days}
    </Text>
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

/**
 * One Sighting: what happened, who it reaches and which way, how sure the
 * link is and over what window. Held tickers come first and read darker.
 */
export function SightingCard({ card, held, onPress }: { card: RippleCard; held: Set<string>; onPress: () => void }) {
  const press = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: 1 - press.value * 0.015 }] }));

  const hits = orderedHits(card, held);
  const lead = hits[0];
  const shown = hits.slice(0, hits.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS);
  const more = hits.length - shown.length;
  const kind = EVENT_KIND[card.event.kind] ?? "Event";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${card.event.headline}. ${hits.map((h) => `${h.ticker} ${h.direction}`).join(", ")}`}
      onPress={onPress}
      onPressIn={() => (press.value = withTiming(1, { duration: 120, easing: EASE_CALM }))}
      onPressOut={() => (press.value = withTiming(0, { duration: 220, easing: EASE_CALM }))}
    >
      {({ pressed }) => (
        <Animated.View style={[styles.card, pressed ? styles.cardPressed : null, animated]}>
          <View style={styles.top}>
            <Text style={styles.kicker} numberOfLines={1}>
              {card.event.ticker} · {kind}
            </Text>
            <Text style={styles.time}>{timeAgo(card.event.occurredAt)}</Text>
          </View>
          <Text style={styles.headline}>{card.event.headline}</Text>

          {shown.length > 0 ? (
            <View style={styles.chips}>
              {shown.map((hit) => (
                <TickerChip key={`${hit.ticker}-${hit.relation}`} hit={hit} held={held.has(hit.ticker.toUpperCase())} />
              ))}
              {more > 0 ? (
                <View style={[styles.chip, styles.chipMore]}>
                  <Text style={styles.chipMoreText}>+{more}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {lead ? (
            <View style={styles.meta}>
              <ConfidenceBars confidence={lead.confidence} />
              <Text style={styles.metaText}>{CONFIDENCE[lead.confidence]}</Text>
              <Text style={styles.metaDot}>·</Text>
              <Text style={styles.metaText} numberOfLines={1}>
                {lead.window}
              </Text>
            </View>
          ) : null}
          {lead?.history ? <HistoryLine history={lead.history} ticker={lead.ticker} /> : null}
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
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  kicker: {
    flexShrink: 1,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.5)",
  },
  time: { fontFamily: fonts.sans, fontSize: 12.5, color: colors.faint },
  headline: { marginTop: 8, fontFamily: fonts.serif, fontSize: 17, lineHeight: 25, color: colors.ink },
  chips: { marginTop: 14, flexDirection: "row", flexWrap: "wrap", gap: 6 },
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
  meta: { marginTop: 14, flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { flexShrink: 1, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 16, color: colors.muted },
  metaDot: { fontFamily: fonts.sans, fontSize: 12.5, color: colors.placeholder },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 10, marginRight: 2 },
  bar: { width: 3, borderRadius: 1, backgroundColor: "rgba(0, 0, 0, 0.12)" },
  barOn: { backgroundColor: colors.ink },
  history: { marginTop: 8, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 17, color: colors.body },
});
