import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { STRENGTH, SIGNAL_LABEL, type Direction } from "@falcon/ripple";
import { PrimaryButton } from "@/components/Buttons";
import { SheetScreen, type CloseSheet } from "@/components/Sheet";
import { haptics } from "@/lib/haptics";
import { SHEET_DETENTS } from "@/lib/sheets";
import { DirectionIcon, StrengthBadge } from "@/features/sightings/SightingCard";
import { directionColor, directionSoft } from "@/features/sightings/format";
import { colors, fonts } from "@/theme";

const QUESTIONS: { title: string; text: string }[] = [
  { title: "What happened", text: "The event in plain words, with the numbers from the filing." },
  { title: "Why it matters", text: "Why this kind of event can affect the stock." },
  { title: "After similar events", text: "What stocks did on average after past events like it." },
  { title: "Keep in mind", text: "The limits of the reading and what to check." },
];

const SIGNALS: { direction: Direction; label: string; text: string }[] = [
  { direction: "up", label: SIGNAL_LABEL.positive, text: "Followed, on average, by the stock rising compared with the market." },
  { direction: "down", label: SIGNAL_LABEL.negative, text: "Followed, on average, by the stock falling compared with the market." },
  { direction: "unclear", label: SIGNAL_LABEL.unclear, text: "The news could point either way." },
];

/** "How to read a Sighting": what a card is and what each part of it means. */
export default function HowToReadSheet() {
  return <SheetScreen detent={SHEET_DETENTS.howToRead[0]}>{(close) => <HowToRead close={close} />}</SheetScreen>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function HowToRead({ close }: { close: CloseSheet }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title} accessibilityRole="header">
        How to read a Sighting
      </Text>
      <Text style={styles.lead}>
        A Sighting is a public event, mostly a filing with the SEC, that may move a stock. Falcon reads the filings every
        day and explains each one in plain words.
      </Text>

      <Section title="Every card answers four questions">
        {QUESTIONS.map((q, i) => (
          <View key={q.title} style={[styles.row, i > 0 ? styles.rowDivider : null]}>
            <Text style={styles.number}>{i + 1}</Text>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{q.title}</Text>
              <Text style={styles.rowBody}>{q.text}</Text>
            </View>
          </View>
        ))}
      </Section>

      <Section title="How strong is the evidence">
        {(["measured", "research", "watching"] as const).map((level, i) => (
          <View key={level} style={[styles.stack, i > 0 ? styles.rowDivider : null]}>
            <StrengthBadge strength={STRENGTH[level]} />
            <Text style={styles.rowBody}>{STRENGTH[level].detail}</Text>
          </View>
        ))}
      </Section>

      <Section title="Which way it points">
        {SIGNALS.map((s, i) => (
          <View key={s.direction} style={[styles.stack, i > 0 ? styles.rowDivider : null]}>
            <View style={[styles.pill, { backgroundColor: directionSoft(s.direction) }]}>
              <DirectionIcon direction={s.direction} size={14} />
              <Text style={[styles.pillText, { color: directionColor(s.direction) }]}>{s.label}</Text>
            </View>
            <Text style={styles.rowBody}>{s.text}</Text>
          </View>
        ))}
        <Text style={styles.note}>
          The news has, on average, been followed by moves in that direction. Many cases did not.
        </Text>
      </Section>

      <Section title="Your portfolio and Opportunities">
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Your portfolio</Text>
            <Text style={styles.rowBody}>Sightings about the stocks you added.</Text>
          </View>
        </View>
        <View style={[styles.row, styles.rowDivider]}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Opportunities</Text>
            <Text style={styles.rowBody}>
              Sightings about other companies, only the ones backed by evidence.
            </Text>
          </View>
        </View>
      </Section>

      <Text style={styles.disclaimer}>For information only, not investment advice.</Text>
      <PrimaryButton
        label="Got it"
        onPress={() => {
          haptics.select();
          close();
        }}
        style={styles.done}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 6 },
  title: { fontFamily: fonts.serif, fontSize: 24, lineHeight: 32, letterSpacing: -0.3, color: colors.ink },
  lead: { marginTop: 10, fontFamily: fonts.sans, fontSize: 16, lineHeight: 24, color: colors.body },
  section: { marginTop: 30 },
  sectionTitle: {
    marginBottom: 4,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: colors.muted,
  },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 12 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  number: { width: 16, fontFamily: fonts.mono, fontSize: 13, lineHeight: 21, color: colors.faint },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: fonts.sansMedium, fontSize: 15, lineHeight: 21, color: colors.ink },
  rowBody: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.body },
  stack: { alignItems: "flex-start", gap: 8, paddingVertical: 12 },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, height: 26, paddingLeft: 8, paddingRight: 11, borderRadius: 13 },
  pillText: { fontFamily: fonts.sansMedium, fontSize: 13 },
  note: { marginTop: 4, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, color: colors.muted },
  disclaimer: {
    marginTop: 30,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
    textAlign: "center",
  },
  done: { marginTop: 14 },
});
