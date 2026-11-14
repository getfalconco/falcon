import { useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRight, ArrowUpRight as LinkArrow } from "lucide-react-native";
import { cardExplain, recordCount, relationPhrase, shortCompany, type RippleHit } from "@falcon/ripple";
import { SecondaryButton } from "@/components/Buttons";
import { PushedScreen } from "@/components/PushedScreen";
import { Reveal } from "@/components/Reveal";
import { haptics } from "@/lib/haptics";
import { heldTickers } from "@/lib/holdings";
import { orderedHits, useSightingCard } from "@/lib/sightings";
import { ConnectionGraph } from "@/features/sightings/ConnectionGraph";
import { Quote, openLink } from "@/features/sightings/Evidence";
import { DirectionIcon, PricedInTag, StrengthBadge, cardStyles } from "@/features/sightings/SightingCard";
import {
  SIGNAL_WORD,
  directionColor,
  directionSoft,
  isSelfHit,
  shortDay,
  signedPct,
  timeAgo,
} from "@/features/sightings/format";
import { EmptyTitle, SectionHeader, SkeletonCard } from "@/features/sightings/parts";
import { GUTTER, colors, fonts } from "@/theme";

/** The phone frame's width in the browser preview; the real width on the phone. */
const PREVIEW_WIDTH = 393;

/** One of the four plain answers: a small heading and a paragraph. */
function Answer({ title, children }: { title: string; children: string }) {
  return (
    <View style={styles.answer}>
      <Text style={styles.answerTitle} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.answerText}>{children}</Text>
    </View>
  );
}

/** "Show the filing quote": the quotes behind a hit, folded until tapped. */
function Quotes({ hit }: { hit: RippleHit }) {
  const [open, setOpen] = useState(false);
  const n = hit.evidence.length;
  if (n === 0) return null;
  const label = n === 1 ? "Show the filing quote" : `Show the ${n} filing quotes`;
  return (
    <View style={styles.quotesBlock}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          haptics.select();
          setOpen((v) => !v);
        }}
        hitSlop={8}
      >
        {({ pressed }) => (
          <View style={[styles.toggle, pressed ? styles.pressed : null]}>
            <View style={open ? styles.chevronOpen : null}>
              <ChevronRight size={15} strokeWidth={2} color={colors.muted} />
            </View>
            <Text style={styles.toggleText}>{open ? (n === 1 ? "Hide the filing quote" : "Hide the filing quotes") : label}</Text>
          </View>
        )}
      </Pressable>
      {open ? (
        <View style={styles.quotes}>
          {hit.evidence.map((evidence, i) => (
            <Quote key={`${evidence.url}-${i}`} evidence={evidence} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function HitBlock({
  hit,
  held,
  self,
  eventCompany,
  onOpen,
}: {
  hit: RippleHit;
  held: boolean;
  self: boolean;
  eventCompany: string;
  onOpen: () => void;
}) {
  const relation = self ? null : relationPhrase(hit.relation, hit.degree === 2 && hit.via ? hit.via : eventCompany);
  const record = !self ? recordCount(hit.history) : null;
  return (
    <View>
      <View style={styles.hitTop}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${hit.ticker}, ${hit.companyName}`}
          onPress={onOpen}
          hitSlop={6}
          style={({ pressed }) => [styles.hitName, pressed ? styles.pressed : null]}
        >
          <View style={styles.hitTickerRow}>
            <Text style={styles.hitTicker}>{hit.ticker}</Text>
            {held ? <Text style={styles.heldTag}>Held</Text> : null}
          </View>
          <Text style={styles.hitCompany} numberOfLines={1}>
            {shortCompany(hit.companyName)}
          </Text>
        </Pressable>
        <View style={[styles.direction, { backgroundColor: directionSoft(hit.direction) }]}>
          <DirectionIcon direction={hit.direction} size={14} />
          <Text style={[styles.directionText, { color: directionColor(hit.direction) }]}>
            {SIGNAL_WORD[hit.direction]}
          </Text>
        </View>
      </View>

      {relation ? <Text style={styles.relation}>{relation.charAt(0).toUpperCase() + relation.slice(1)}</Text> : null}
      <Text style={styles.mechanism}>{hit.mechanism}</Text>
      <Text style={styles.meta}>Time frame: {hit.window}</Text>
      {record && hit.history ? (
        <Text style={styles.meta}>
          After {record.sample} similar past events, {hit.ticker} moved the expected way {record.wins} times (over{" "}
          {hit.history.windowDays} trading days, compared with the market).
        </Text>
      ) : null}
      {hit.sinceEvent ? (
        <Text style={styles.meta}>
          Since the event: {signedPct(hit.sinceEvent.movePct)} compared with the market ({hit.sinceEvent.benchmark}), as
          of the {shortDay(hit.sinceEvent.asOf)} close.
        </Text>
      ) : null}
      {hit.pricedIn ? (
        <View style={styles.pricedRow}>
          <PricedInTag />
        </View>
      ) : null}
      <Quotes hit={hit} />
    </View>
  );
}

function SourceRow({ label, title, url }: { label: string; title: string; url: string }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${label}: ${title}`} onPress={() => openLink(url)}>
      {({ pressed }) => (
        <View style={[styles.source, pressed ? styles.pressed : null]}>
          <View style={styles.sourceText}>
            <Text style={styles.sourcePublisher}>{label}</Text>
            <Text style={styles.sourceTitle} numberOfLines={2}>
              {title}
            </Text>
          </View>
          <LinkArrow size={16} strokeWidth={1.8} color={colors.muted} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * One Sighting in full, in plain words: what happened, why it matters, what
 * happened after similar events, what to keep in mind; then each company it
 * points at, the sources, and for linked cards the connection graph.
 */
export default function SightingDetail() {
  const router = useRouter();
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
  // Hits other than the event company itself: only these draw on the graph.
  const linked = card ? hits.filter((h) => !isSelfHit(h, card.event.ticker)) : [];
  const ex = card ? cardExplain(card) : null;
  const paper = card?.hits.find((h) => h.documentedBy?.citation)?.documentedBy;
  const eventCompany = card ? shortCompany(card.event.companyName) : "";

  const jumpTo = (hit: RippleHit) => {
    const y = offsets[hit.ticker];
    if (y === undefined) return;
    haptics.select();
    scroll.current?.scrollTo({ y: Math.max(0, hitsTop + y - 12), animated: true });
  };

  return (
    <PushedScreen scrollRef={scroll}>
      {!card || !ex ? (
        status === "loading" ? (
          <SkeletonCard />
        ) : (
          <EmptyTitle title="Sighting not found" />
        )
      ) : (
        <>
          <Reveal order={0}>
            <Text style={styles.kicker}>
              {ex.kicker} · {card.event.ticker}
              <Text style={styles.kickerTime}>{`  ${timeAgo(card.event.occurredAt)}`}</Text>
            </Text>
            <Text style={styles.headline} accessibilityRole="header">
              {ex.title}
            </Text>
            <View style={styles.strength}>
              <StrengthBadge strength={ex.strength} />
              <Text style={styles.strengthDetail}>{ex.strength.detail}</Text>
            </View>
          </Reveal>

          <Reveal order={1} style={styles.answers}>
            <Answer title="What happened">{ex.what}</Answer>
            <Answer title="Why it matters">{ex.why}</Answer>
            <Answer title="After similar events">{ex.past}</Answer>
            <Answer title="Keep in mind">{ex.caution}</Answer>
          </Reveal>

          <View style={styles.hits} onLayout={(e) => setHitsTop(e.nativeEvent.layout.y)}>
            <Reveal order={2}>
              <SectionHeader title={hits.length === 1 ? "Company affected" : "Companies affected"} />
            </Reveal>
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
                  <HitBlock
                    hit={hit}
                    held={held.has(hit.ticker.toUpperCase())}
                    self={isSelfHit(hit, card.event.ticker)}
                    eventCompany={eventCompany}
                    onOpen={() => {
                      haptics.select();
                      router.push({ pathname: "/ticker/[symbol]", params: { symbol: hit.ticker } });
                    }}
                  />
                </Reveal>
              </View>
            ))}
          </View>

          <Reveal order={4} style={styles.sources}>
            <SectionHeader title="Sources" />
            <SourceRow label={card.event.source.publisher} title={card.event.source.title} url={card.event.source.url} />
            {paper && /^https?:\/\//i.test(paper.url) ? (
              <SourceRow label="Published research" title={paper.citation} url={paper.url} />
            ) : null}
            <SecondaryButton
              label="Backtest this"
              onPress={() => {
                haptics.select();
                router.push({ pathname: "/backtest/[id]", params: { id: card.id } });
              }}
              style={styles.backtest}
            />
          </Reveal>

          {linked.length > 0 ? (
            <Reveal order={5} style={styles.graphCard}>
              <ConnectionGraph card={card} held={held} width={graphW} onSelect={jumpTo} />
            </Reveal>
          ) : null}
        </>
      )}
    </PushedScreen>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  kicker: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.5)",
  },
  kickerTime: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 0, textTransform: "none", color: colors.faint },
  headline: {
    marginTop: 12,
    fontFamily: fonts.serif,
    fontSize: 26,
    lineHeight: 35,
    letterSpacing: -0.3,
    color: colors.ink,
  },
  strength: { marginTop: 16, alignItems: "flex-start", gap: 8 },
  strengthDetail: { fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 19, color: colors.muted },
  answers: { marginTop: 26, gap: 22 },
  answer: { gap: 6 },
  answerTitle: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: colors.muted,
  },
  answerText: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 24, color: colors.body },
  hits: { marginTop: 40 },
  hitDivider: { marginTop: 24, paddingTop: 24, borderTopWidth: 1, borderTopColor: colors.divider },
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
  relation: { marginTop: 12, fontFamily: fonts.sansMedium, fontSize: 13.5, lineHeight: 19, color: colors.body },
  mechanism: { marginTop: 10, fontFamily: fonts.sans, fontSize: 15.5, lineHeight: 23, color: colors.ink },
  meta: { marginTop: 8, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.muted },
  pricedRow: { marginTop: 10, flexDirection: "row" },
  quotesBlock: { marginTop: 14 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  toggleText: { fontFamily: fonts.sans, fontSize: 14, color: colors.body },
  quotes: { marginTop: 12, gap: 14 },
  sources: { marginTop: 40 },
  source: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: 1,
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
  backtest: { marginTop: 16 },
  graphCard: { ...cardStyles.surface, marginTop: 32, paddingVertical: 8, alignItems: "center", overflow: "hidden" },
});
