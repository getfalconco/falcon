import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { UserRound } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { getSupabase } from "@/lib/supabase";
import { EASE_SOFT, colors, fonts } from "@/theme";
import { cardStyles } from "./SightingCard";

/** A tab's big serif title, with an optional small line above it. */
export function ScreenTitle({ title, kicker, right }: { title: string; kicker?: string; right?: React.ReactNode }) {
  return (
    <View style={styles.titleRow}>
      <View style={styles.titleText}>
        {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.section} accessibilityRole="header">
        {title}
      </Text>
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={10}>
          {({ pressed }) => <Text style={[styles.action, pressed ? styles.actionPressed : null]}>{action.label}</Text>}
        </Pressable>
      ) : null}
    </View>
  );
}

/** Empty state: a title, nothing else. */
export function EmptyTitle({ title }: { title: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
    </View>
  );
}

/** Development builds only: marks fixture cards. */
export function SampleTag() {
  if (!__DEV__) return null;
  return (
    <View style={styles.sample}>
      <Text style={styles.sampleText}>Sample data</Text>
    </View>
  );
}

/** A card-shaped placeholder that breathes while the feed loads. */
export function SkeletonCard() {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    pulse.value = withRepeat(withTiming(1, { duration: 900, easing: EASE_SOFT }), -1, true);
  }, [pulse, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: 0.55 + pulse.value * 0.45 }));
  return (
    <Animated.View style={[cardStyles.surface, styles.skeleton, style]}>
      <View style={[styles.bone, { width: "36%" }]} />
      <View style={[styles.bone, styles.boneTall, { width: "82%" }]} />
      <View style={[styles.bone, { width: "58%", marginTop: 18 }]} />
    </Animated.View>
  );
}

function initialOf(user: { email?: string | null; user_metadata?: Record<string, unknown> } | null | undefined) {
  const meta = user?.user_metadata ?? {};
  const name = [meta.full_name, meta.name, meta.given_name].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const source = name ?? user?.email ?? "";
  const letter = source.trim().charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(letter) ? letter : null;
}

/** A round button with an icon, the same size and look as the avatar. */
export function RoundButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}>
      {({ pressed }) => <View style={[styles.avatar, pressed ? styles.avatarPressed : null]}>{children}</View>}
    </Pressable>
  );
}

/** The member's initial in a circle (a person glyph without a session). */
export function Avatar({ onPress }: { onPress?: () => void }) {
  const [initial, setInitial] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void getSupabase()
      ?.auth.getSession()
      .then(({ data }) => {
        if (live) setInitial(initialOf(data.session?.user));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="You" onPress={onPress} hitSlop={8}>
      {({ pressed }) => (
        <View style={[styles.avatar, pressed ? styles.avatarPressed : null]}>
          {initial ? (
            <Text style={styles.avatarText}>{initial}</Text>
          ) : (
            <UserRound size={18} strokeWidth={1.7} color={colors.body} />
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 16 },
  titleText: { flexShrink: 1 },
  kicker: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.8,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.45)",
    marginBottom: 6,
  },
  title: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 42, letterSpacing: -0.5, color: colors.ink },
  sectionRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 },
  section: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 26, color: colors.ink },
  action: { fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  actionPressed: { opacity: 0.5 },
  empty: { paddingVertical: 56, alignItems: "center" },
  emptyTitle: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 26, color: colors.muted, textAlign: "center" },
  sample: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.08)",
  },
  sampleText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: colors.faint,
  },
  skeleton: { padding: 18, gap: 10 },
  bone: { height: 10, borderRadius: 5, backgroundColor: "rgba(0, 0, 0, 0.06)" },
  boneTall: { height: 16, borderRadius: 6 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f2f1ef",
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.hairline,
  },
  avatarPressed: { opacity: 0.7 },
  avatarText: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.ink },
});
