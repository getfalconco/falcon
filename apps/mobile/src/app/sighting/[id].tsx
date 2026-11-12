import { useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";
import { ArrowUpRight as LinkArrow } from "lucide-react-native";
import type { LinkEvidence, RippleHit } from "@falcon/ripple";
import { BackButton } from "@/components/Buttons";
import { Reveal } from "@/components/Reveal";
import { haptics } from "@/lib/haptics";
import { heldTickers } from "@/lib/holdings";
import { orderedHits, useSightingCard } from "@/lib/sightings";
import { ConnectionGraph } from "@/features/sightings/ConnectionGraph";
import { ConfidenceBars, DirectionIcon, HistoryLine, cardStyles } from "@/features/sightings/SightingCard";
import {
  CONFIDENCE,
  DIRECTION,
  EVENT_KIND,
  RELATION,
  directionColor,
  directionSoft,
  shortDate,
  timeAgo,
} from "@/features/sightings/format";
import { EmptyTitle, SkeletonCard } from "@/features/sightings/parts";
import { GUTTER, colors, fonts } from "@/theme";

/** The phone frame's width in the browser preview; the real width on the phone. */
const PREVIEW_WIDTH = 393;

function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  haptics.select();
  void WebBrowser.openBrowserAsync(url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET }).catch(
    () => {},
  );
}

function Quote({ evidence }: { evidence: LinkEvidence }) {
  const filed = shortDate(evidence.filedAt);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${evidence.form} filing${filed ? `, filed ${filed}` : ""}`}
      onPress={() => openLink(evidence.url)}
    >
      {({ pressed }) => (
        <View style={[styles.quote, pressed ? styles.pressed : null]}>
          <Text style={styles.quoteText}>{`“${evidence.quote}”`}</Text>
          <View style={styles.quoteSource}>
            <Text style={styles.quoteForm}>{evidence.form}</Text>
            {filed ? <Text style={styles.quoteMeta}>Filed {filed}</Text> : null}
            <LinkArrow size={13} strokeWidth={1.8} color={colors.faint} />
          </View>
        </View>
      )}
    </Pressable>
  );
}

function HitBlock({ hit, held }: { hit: RippleHit; held: boolean }) {
  const relation = RELATION[hit.relation] ?? hit.relation;
  return (
    <View>
      <View style={styles.hitTop}>
        <View style={styles.hitName}>
          <View style={styles.hitTickerRow}>
            <Text style={styles.hitTicker}>{hit.ticker}</Text>
            {held ? <Text style={styles.heldTag}>Held</Text> : null}
          </View>
          <Text style={styles.hitCompany} numberOfLines={1}>
            {hit.companyName}
          </Text>
        </View>
        <View style={[styles.direction, { backgroundColor: directionSoft(hit.direction) }]}>
          <DirectionIcon direction={hit.direction} size={14} />
          <Text style={[styles.directionText, { color: directionColor(hit.direction) }]}>
            {DIRECTION[hit.direction]}
          </Text>
        </View>
      </View>

      <View style={styles.hitMeta}>
        <Text style={styles.metaText}>{hit.degree === 2 && hit.via ? `${relation} via ${hit.via}` : relation}</Text>
        <Text style={styles.metaDot}>·</Text>
        <ConfidenceBars confidence={hit.confidence} />
        <Text style={styles.metaText}>{CONFIDENCE[hit.confidence]}</Text>
        <Text style={styles.metaDot}>·</Text>
        <Text style={styles.metaText}>{hit.window}</Text>
      </View>

      <Text style={styles.mechanism}>{hit.mechanism}</Text>
      {hit.history ? <HistoryLine history={hit.history} /> : null}
      {hit.evidence.length > 0 ? (
        <View style={styles.quotes}>
          {hit.evidence.map((evidence, i) => (
            <Quote key={`${evidence.url}-${i}`} evidence={evidence} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** One Sighting in full: the event, its source, its connections and the filings behind each link. */
export default function SightingDetail() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { card, status, holdings } = useSightingCard(id);
  const held = useMemo(() => heldTickers(holdings), [holdings]);
  const scroll = useRef<ScrollViewInstance>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [hitsTop, setHitsTop] = useState(0);

  const screenW = Platform.OS === "web" ? Math.min(window.width, PREVIEW_WIDTH) : window.width;
  const graphW = screenW - GUTTER * 2 - 2;
  const hits = card ? orderedHits(card, held) : [];

  const back = () => {
    haptics.select();
    if (router.canGoBack()) router.back();
    else router.replace("/today");
  };

  const jumpTo = (hit: RippleHit) => {
    const y = offsets[hit.ticker];
    if (y === undefined) return;
    haptics.select();
    scroll.current?.scrollTo({ y: Math.max(0, hitsTop + y - 12), animated: true });
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <BackButton onPress={back} />
      </View>

      <ScrollView
        ref={scroll}
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        {!card ? (
          status === "loading" ? (
            <SkeletonCard />
          ) : (
            <EmptyTitle title="Sighting not found" />
          )
        ) : (
          <>
            <Reveal order={0}>
              <Text style={styles.kicker}>
                {card.event.ticker} · {EVENT_KIND[card.event.kind] ?? "Event"} · {timeAgo(card.event.occurredAt)}
              </Text>
              <Text style={styles.headline} accessibilityRole="header">
                {card.event.headline}
              </Text>
              <Text style={styles.summary}>{card.event.summary}</Text>
            </Reveal>

            <Reveal order={1}>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`Source: ${card.event.source.title}`}
                onPress={() => openLink(card.event.source.url)}
              >
                {({ pressed }) => (
                  <View style={[styles.source, pressed ? styles.pressed : null]}>
                    <View style={styles.sourceText}>
                      <Text style={styles.sourcePublisher}>{card.event.source.publisher}</Text>
                      <Text style={styles.sourceTitle} numberOfLines={2}>
                        {card.event.source.title}
                      </Text>
                    </View>
                    <LinkArrow size={16} strokeWidth={1.8} color={colors.muted} />
                  </View>
                )}
              </Pressable>
            </Reveal>

            {hits.length > 0 ? (
              <Reveal order={2} style={styles.graphCard}>
                <ConnectionGraph card={card} held={held} width={graphW} onSelect={jumpTo} />
              </Reveal>
            ) : null}

            <View style={styles.hits} onLayout={(e) => setHitsTop(e.nativeEvent.layout.y)}>
              {hits.map((hit, i) => (
                <View
                  key={`${hit.ticker}-${hit.relation}`}
                  style={i > 0 ? styles.hitDivider : null}
                  onLayout={(e) => {
                    const y = e.nativeEvent.layout.y;
                    setOffsets((prev) => (prev[hit.ticker] === y ? prev : { ...prev, [hit.ticker]: y }));
                  }}
                >
                  <Reveal order={3 + Math.min(i, 5)}>
                    <HitBlock hit={hit} held={held.has(hit.ticker.toUpperCase())} />
                  </Reveal>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    height: 56,
    justifyContent: "center",
    paddingHorizontal: GUTTER - 4,
    backgroundColor: colors.background,
    zIndex: 1,
  },
  content: { paddingHorizontal: GUTTER, paddingTop: 8 },
  pressed: { opacity: 0.6 },
  kicker: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.5)",
  },
  headline: {
    marginTop: 12,
    fontFamily: fonts.serif,
    fontSize: 26,
    lineHeight: 35,
    letterSpacing: -0.3,
    color: colors.ink,
  },
  summary: { marginTop: 14, fontFamily: fonts.sans, fontSize: 16, lineHeight: 24, color: colors.body },
  source: {
    marginTop: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.divider,
  },
  sourceText: { flex: 1 },
  sourcePublisher: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: colors.faint,
  },
  sourceTitle: { marginTop: 3, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 20, color: colors.ink },
  graphCard: { ...cardStyles.surface, marginTop: 28, paddingVertical: 8, alignItems: "center", overflow: "hidden" },
  hits: { marginTop: 32 },
  hitDivider: { marginTop: 28, paddingTop: 28, borderTopWidth: 1, borderTopColor: colors.divider },
  hitTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  hitName: { flexShrink: 1 },
  hitTickerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  hitTicker: { fontFamily: fonts.mono, fontSize: 16, color: colors.ink },
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
  hitCompany: { marginTop: 3, fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
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
  hitMeta: { marginTop: 14, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  metaText: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.muted },
  metaDot: { fontFamily: fonts.sans, fontSize: 13, color: colors.placeholder },
  mechanism: { marginTop: 12, fontFamily: fonts.sans, fontSize: 15.5, lineHeight: 23, color: colors.ink },
  quotes: { marginTop: 16, gap: 14 },
  quote: { borderLeftWidth: 2, borderLeftColor: "rgba(0, 0, 0, 0.12)", paddingLeft: 14, paddingVertical: 2 },
  quoteText: { fontFamily: fonts.serif, fontSize: 14.5, lineHeight: 23, color: colors.body },
  quoteSource: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  quoteForm: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.6, color: colors.ink },
  quoteMeta: { fontFamily: fonts.sans, fontSize: 12.5, color: colors.faint },
});
