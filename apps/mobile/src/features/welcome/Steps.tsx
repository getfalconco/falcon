import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { Check, Lock } from "lucide-react-native";
import { Reveal } from "@/components/Reveal";
import { haptics } from "@/lib/haptics";
import { EASE_CALM, EASE_SOFT, colors, fonts } from "@/theme";

/**
 * The welcome funnel's building blocks, in the website's questionnaire style:
 * Libre Baskerville headlines, Geist text, Geist Mono labels, thin borders
 * that darken when chosen.
 */

export function MonoLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.monoLabel}>{children}</Text>;
}

/* ------------------------------------------------------------------ */
/* Single choice rows                                                  */
/* ------------------------------------------------------------------ */

export function ChoiceRows({
  options,
  value,
  onChange,
  confirming,
  firstOrder,
  maxStaggered = 4,
}: {
  options: readonly { id: string; label: string }[];
  value: string | undefined;
  onChange: (id: string) => void;
  /** The step is moving on: the chosen option settles darker. */
  confirming: boolean;
  /** Stagger order of the first option. */
  firstOrder: number;
  maxStaggered?: number;
}) {
  return (
    <View accessibilityRole="radiogroup" style={styles.rows}>
      {options.map((option, index) => {
        const selected = value === option.id;
        return (
          <Reveal key={option.id} order={firstOrder + Math.min(index, maxStaggered - 1)}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => {
                if (confirming) return;
                haptics.select();
                onChange(option.id);
              }}
              style={({ pressed }) => [
                styles.option,
                selected ? (confirming ? styles.optionConfirm : styles.optionOn) : null,
                pressed && !selected ? styles.optionPressed : null,
              ]}
            >
              <Text style={[styles.optionText, selected ? styles.optionTextOn : null]}>{option.label}</Text>
              {selected ? <Check size={16} strokeWidth={2} color={colors.ink} /> : null}
            </Pressable>
          </Reveal>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Chips                                                               */
/* ------------------------------------------------------------------ */

export function Chips({
  options,
  value,
  onToggle,
  confirming,
}: {
  options: readonly { id: string; label: string }[];
  value: readonly string[];
  onToggle: (id: string) => void;
  confirming: boolean;
}) {
  return (
    <View style={styles.chips}>
      {options.map((option) => {
        const on = value.includes(option.id);
        return (
          <Pressable
            key={option.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            onPress={() => {
              if (confirming) return;
              haptics.select();
              onToggle(option.id);
            }}
            style={({ pressed }) => [
              styles.chip,
              on ? (confirming ? styles.optionConfirm : styles.optionOn) : null,
              pressed && !on ? styles.optionPressed : null,
            ]}
          >
            {on ? <Check size={14} strokeWidth={2} color={colors.ink} /> : null}
            <Text style={[styles.chipText, on ? styles.optionTextOn : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Press and hold to commit                                            */
/* ------------------------------------------------------------------ */

const HOLD_MS = 1500;

/**
 * The primary button, held for HOLD_MS to commit. A lighter fill sweeps
 * across while held and runs back if released early.
 */
export function HoldToCommit({ committed, onCommit }: { committed: boolean; onCommit: () => void }) {
  const fill = useSharedValue(committed ? 1 : 0);
  const press = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  const begin = useCallback(() => {
    if (committed || timer.current !== null) return;
    haptics.tap();
    press.value = withTiming(1, { duration: 160, easing: EASE_SOFT });
    fill.value = withTiming(1, { duration: HOLD_MS * (1 - fill.value), easing: Easing.linear });
    timer.current = setTimeout(() => {
      timer.current = null;
      press.value = withTiming(0, { duration: 200, easing: EASE_SOFT });
      haptics.success();
      onCommit();
    }, HOLD_MS * (1 - fill.value));
  }, [committed, fill, onCommit, press]);

  const release = useCallback(() => {
    if (committed || timer.current === null) return;
    clear();
    cancelAnimation(fill);
    fill.value = withTiming(0, { duration: 300, easing: EASE_SOFT });
    press.value = withTiming(0, { duration: 200, easing: EASE_SOFT });
  }, [clear, committed, fill, press]);

  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }));
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - press.value * 0.02 }] }));

  return (
    <View>
      <Animated.View style={pressStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={committed ? "Committed" : "Press and hold to commit"}
          accessibilityState={{ checked: committed }}
          onPressIn={begin}
          onPressOut={release}
          delayLongPress={HOLD_MS * 4}
          style={styles.hold}
        >
          <Animated.View style={[styles.holdFill, fillStyle]} />
          <View style={styles.holdLabel}>
            {committed ? <Check size={16} strokeWidth={2} color={colors.primaryText} /> : null}
            <Text style={styles.holdText}>{committed ? "Committed" : "Press and hold"}</Text>
          </View>
        </Pressable>
      </Animated.View>
      <Text style={[styles.caption, styles.centered]} accessibilityLiveRegion="polite">
        {committed ? "See you tomorrow morning." : "Hold for a moment to commit."}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** Each ticker (or sector) ticks over to done in turn across `durationMs`. */
export function MappingList({ items, durationMs }: { items: string[]; durationMs: number }) {
  const shown = items.slice(0, 6);
  const extra = items.length - shown.length;
  const count = shown.length;
  const [done, setDone] = useState(0);

  useEffect(() => {
    const step = durationMs / (count + 1);
    const timers = Array.from({ length: count }, (_, i) =>
      setTimeout(() => {
        setDone(i + 1);
        haptics.select();
      }, step * (i + 1)),
    );
    return () => timers.forEach(clearTimeout);
  }, [durationMs, count]);

  return (
    <View>
      <View style={styles.list}>
        {shown.map((item, i) => (
          <View key={item} style={[styles.listRow, i > 0 ? styles.listDivider : null]}>
            <Text style={styles.ticker}>{item}</Text>
            {i < done ? (
              <View style={styles.inline}>
                <Check size={14} strokeWidth={2} color={colors.ink} />
                <Text style={styles.listStatusDone}>Mapped</Text>
              </View>
            ) : (
              <View style={styles.inline}>
                <ActivityIndicator size="small" color={colors.placeholder} style={styles.spinner} />
                <Text style={styles.listStatus}>Mapping</Text>
              </View>
            )}
          </View>
        ))}
      </View>
      {extra > 0 ? <Text style={styles.caption}>and {extra} more</Text> : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export type FilingItem = { ticker: string; form: string; label: string; filedAt: string };

export type FilingsResult =
  | { state: "loading" }
  /** No portfolio connected: nothing to look up. */
  | { state: "none" }
  | { state: "error" }
  | { state: "ok"; count: number; items: FilingItem[] };

function timeAgo(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function ResultView({ score, filings }: { score: number; filings: FilingsResult }) {
  const bar = useSharedValue(0);
  useEffect(() => {
    bar.value = withDelay(250, withTiming(score / 100, { duration: 900, easing: EASE_CALM }));
  }, [bar, score]);
  const barStyle = useAnimatedStyle(() => ({ width: `${bar.value * 100}%` }));

  return (
    <View>
      <View style={styles.scoreRow}>
        <Text style={styles.score}>{score}</Text>
        <Text style={styles.scoreOf}>/ 100</Text>
      </View>
      <View style={styles.track}>
        <Animated.View style={[styles.trackFill, barStyle]} />
      </View>
      <Text style={styles.captionLong}>
        From your answers: how often you miss moves, your research time, what frustrates you and how many stocks you
        follow.
      </Text>

      <View style={styles.card}>
        <MonoLabel>Today on your stocks</MonoLabel>
        {filings.state === "loading" ? (
          <View style={[styles.inline, styles.cardTop]}>
            <ActivityIndicator size="small" color={colors.muted} style={styles.spinner} />
            <Text style={styles.cardMuted}>Checking today's filings</Text>
          </View>
        ) : filings.state === "none" ? (
          <Text style={[styles.cardSerif, styles.cardTop]}>Connect a portfolio to see what hits your stocks.</Text>
        ) : filings.state === "error" ? (
          <Text style={[styles.cardSerif, styles.cardTop]}>
            We couldn't reach SEC filings just now. Falcon keeps watching your stocks.
          </Text>
        ) : filings.count === 0 ? (
          <Text style={[styles.cardSerif, styles.cardTop]}>No new filings on your stocks today. Falcon keeps watching.</Text>
        ) : (
          <>
            <Text style={[styles.cardHeadline, styles.cardTop]}>
              {filings.count} {filings.count === 1 ? "event" : "events"} hit your portfolio today
            </Text>
            <Text style={styles.cardSmall}>SEC filings on your stocks in the last 24 hours</Text>
            <View style={styles.locked}>
              <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                {filings.items.slice(0, 3).map((item, i) => (
                  <View key={`${item.ticker}-${item.filedAt}-${i}`} style={[styles.filingRow, i > 0 ? styles.listDivider : null]}>
                    <Text style={styles.filingTicker}>{item.ticker}</Text>
                    <Text style={styles.filingLabel} numberOfLines={1}>
                      {item.label ? `${item.form} · ${item.label}` : item.form}
                    </Text>
                    <Text style={styles.filingTime}>{timeAgo(item.filedAt)}</Text>
                  </View>
                ))}
              </View>
              <BlurView
                intensity={Platform.OS === "web" ? 18 : 14}
                tint="light"
                style={StyleSheet.absoluteFill}
              />
              <View style={styles.lockOverlay}>
                <View style={styles.lockPill}>
                  <Lock size={14} strokeWidth={1.75} color={colors.ink} />
                  <Text style={styles.lockText}>Details unlock in Falcon</Text>
                </View>
              </View>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  monoLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2.2,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.35)",
  },
  rows: { gap: 10 },
  option: {
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.optionBorder,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  optionOn: { borderColor: colors.optionBorderOn, backgroundColor: colors.optionFillOn },
  optionConfirm: { borderColor: colors.ink, backgroundColor: colors.optionFillConfirm },
  optionPressed: { backgroundColor: "rgba(0, 0, 0, 0.025)" },
  optionText: { flexShrink: 1, fontFamily: fonts.sans, fontSize: 16, lineHeight: 22, color: colors.body },
  optionTextOn: { color: colors.ink },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.optionBorder,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  chipText: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 20, color: colors.body },
  hold: {
    height: 50,
    borderRadius: 8,
    backgroundColor: colors.primary,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  holdFill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: "rgba(255, 255, 255, 0.16)" },
  holdLabel: { flexDirection: "row", alignItems: "center", gap: 8 },
  holdText: { fontFamily: fonts.sans, fontSize: 15, color: colors.primaryText },
  caption: { marginTop: 12, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.faint },
  centered: { textAlign: "center" },
  captionLong: { marginTop: 12, fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, color: colors.faint },
  list: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.divider },
  listRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14 },
  listDivider: { borderTopWidth: 1, borderTopColor: colors.divider },
  ticker: { fontFamily: fonts.mono, fontSize: 14, color: colors.ink },
  inline: { flexDirection: "row", alignItems: "center", gap: 6 },
  spinner: { transform: [{ scale: 0.75 }] },
  listStatus: { fontFamily: fonts.sans, fontSize: 14, color: colors.placeholder },
  listStatusDone: { fontFamily: fonts.sans, fontSize: 14, color: colors.ink },
  scoreRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  score: { fontFamily: fonts.serif, fontSize: 64, lineHeight: 72, color: colors.ink },
  scoreOf: { fontFamily: fonts.sans, fontSize: 15, color: colors.faint },
  track: { marginTop: 16, height: 1, backgroundColor: colors.hairline },
  trackFill: { height: 1, backgroundColor: colors.ink },
  card: {
    marginTop: 28,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.07)",
    backgroundColor: colors.background,
    padding: 20,
    boxShadow: "0 18px 40px -16px rgba(0, 0, 0, 0.18)",
  },
  cardTop: { marginTop: 12 },
  cardMuted: { fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  cardSerif: { fontFamily: fonts.serif, fontSize: 15, lineHeight: 24, color: colors.ink },
  cardHeadline: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 26, color: colors.ink },
  cardSmall: { marginTop: 4, fontFamily: fonts.sans, fontSize: 12, color: colors.faint },
  locked: { marginTop: 14, borderRadius: 8, overflow: "hidden" },
  filingRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  filingTicker: { width: 52, fontFamily: fonts.mono, fontSize: 12, color: colors.ink },
  filingLabel: { flex: 1, fontFamily: fonts.sans, fontSize: 13, color: colors.body },
  filingTime: { fontFamily: fonts.sans, fontSize: 13, color: colors.faint },
  lockOverlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  lockPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.background,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  lockText: { fontFamily: fonts.sans, fontSize: 12, color: colors.ink },
});
