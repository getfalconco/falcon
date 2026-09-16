import { useEffect } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import PressableScale from "@/components/PressableScale";
import { reportClientFalconError } from "@/lib/report-error";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle } from "react-native-svg";
import { Feather } from "@expo/vector-icons";
import { CARD, FONTS, PRODUCT, PTYPE, RADIUS, ROW_CARD, directionColor } from "@/theme";
import { useRouter } from "expo-router";

/**
 * Primitives mirroring the desktop renderer's idioms:
 *  - PANEL  = rounded card on --surface-card with a hairline border
 *  - LABEL  = 10px uppercase, tracking 0.14em, fg-faint
 *  - bands of stats separated by hairline dividers rather than gaps
 *  - small tag pills on a quiet fill
 * (apps/desktop/src/renderer/components/dashboard/DashboardView.tsx)
 */

/**
 * Room the floating nav needs above the home indicator: its own 64pt track
 */
const NAV_BAR_ROOM = 96;

/**
 * Bottom padding a screen's scroller must add so its last row still clears the
 * floating nav.
 *
 * It belongs in `contentContainerStyle`, not on the `Screen` frame: padding the
 * frame shortens the scroll viewport, which chops the content off at a hard
 * line and leaves a dead band beneath it. Padding the content instead lets the
 * list run to the bottom edge and pass behind the nav's glass, the way iOS 26's
 * own floating tab bar expects.
 */
export function useNavClearance(): number {
  return useSafeAreaInsets().bottom + NAV_BAR_ROOM;
}

/** Screen shell. Uses the inset hook rather than <SafeAreaView> because pnpm
 *  resolves that package against React 18 types while this app is on 19. */
export function Screen({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return <View style={[styles.screen, { paddingTop: insets.top }]}>{children}</View>;
}

export function MicroLabel({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[PTYPE.microLabel, style]}>{children}</Text>;
}

export function Panel({
  children,
  onPress,
  style,
  padded = true,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: object;
  padded?: boolean;
}) {
  const base = [styles.panel, padded && styles.panelPad, style];
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [...base, pressed && styles.pressed]}>
        {children}
      </Pressable>
    );
  }
  return <View style={base}>{children}</View>;
}

/** Tighter card used for list rows (desktop uses rounded-md here). */
export function RowCard({
  children,
  onPress,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: object;
}) {
  const base = [styles.rowCard, style];
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [...base, pressed && styles.pressed]}>
        {children}
      </Pressable>
    );
  }
  return <View style={base}>{children}</View>;
}

/** Hairline divider — the desktop's divide-x/divide-y between band sections. */
export function Divider({ vertical = false }: { vertical?: boolean }) {
  return <View style={vertical ? styles.divVertical : styles.divHorizontal} />;
}

export function Pill({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, active && styles.pillActive]}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

/** Quiet chip for magnitude / timeframe. */
export function Tag({ label, color }: { label: string; color?: string }) {
  return (
    <View style={[styles.tag, color ? { backgroundColor: `${color}1a` } : null]}>
      <Text style={[PTYPE.tag, color ? { color } : null]}>{label}</Text>
    </View>
  );
}

/** Signal-strength donut, matching the desktop's Ring. */
export function Ring({
  value,
  color,
  size = 72,
  stroke = 5,
  children,
}: {
  value: number;
  color: string;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, value));

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: "-90deg" }] }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={PRODUCT.border}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          fill="none"
        />
      </Svg>
      <View style={styles.ringInner}>{children}</View>
    </View>
  );
}

/** Direction arrow + ticker + mechanism — the desktop's activity row. */
export function ActivityRow({
  direction,
  ticker,
  detail,
  time,
  onPress,
  last = false,
}: {
  direction: string;
  ticker: string;
  detail: string;
  time: string;
  onPress?: () => void;
  last?: boolean;
}) {
  const color = directionColor(direction);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.activityRow,
        !last && styles.activityBorder,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.arrow, { color }]}>{direction === "positive" ? "↑" : "↓"}</Text>
      <View style={styles.activityBody}>
        <Text style={PTYPE.row} numberOfLines={1}>
          <Text style={styles.activityTicker}>{ticker}</Text>{" "}
          <Text style={styles.activityDetail}>{detail}</Text>
        </Text>
        <Text style={[PTYPE.num, styles.activityTime]}>{time}</Text>
      </View>
    </Pressable>
  );
}

export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={PRODUCT.fgSubtle} />
    </View>
  );
}

export function PrimaryPill({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={[styles.primaryPill, disabled && styles.primaryPillOff]}
      pressedStyle={styles.primaryPillHeld}
    >
      <Text style={styles.primaryPillText}>{label}</Text>
    </PressableScale>
  );
}

export function QuietButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={10}>
      <Text style={[styles.quietBtnText, disabled && { opacity: 0.4 }]}>{label}</Text>
    </Pressable>
  );
}

/** Shared drill-in / stack back control. */
export function BackLink({
  onPress,
  label = "Back",
}: {
  onPress?: () => void;
  label?: string;
}) {
  const router = useRouter();
  return (
    <Pressable
      onPress={onPress ?? (() => (router.canGoBack() ? router.back() : undefined))}
      hitSlop={12}
      style={styles.backLink}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name="chevron-left" size={18} color={PRODUCT.fgMuted} />
      <Text style={styles.backLinkText}>{label}</Text>
    </Pressable>
  );
}

/** Honest empty state, in the desktop's quiet two-line form. */
export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
    </View>
  );
}

export function ErrorState({
  message,
  code,
  ticker,
  onRetry,
}: {
  message: string;
  code?: string | null;
  ticker?: string | null;
  onRetry?: () => void;
}) {
  useEffect(() => {
    if (!code) return;
    reportClientFalconError({ code, message }, { ticker });
  }, [code, message, ticker]);

  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{message}</Text>
      {code ? <Text style={styles.ref}>Ref {code}</Text> : null}
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={10}>
          <Text style={styles.retry}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Same step down COLORS.inkButton takes to inkButtonHover under a press. */
const INK_HELD = "#0f0d0b";

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: PRODUCT.bg },
  panel: { ...CARD },
  panelPad: { padding: 16 },
  rowCard: { ...ROW_CARD, paddingHorizontal: 14, paddingVertical: 12 },
  pressed: { backgroundColor: PRODUCT.fill },
  divHorizontal: { height: StyleSheet.hairlineWidth, backgroundColor: PRODUCT.border },
  divVertical: { width: StyleSheet.hairlineWidth, backgroundColor: PRODUCT.border },
  tag: {
    backgroundColor: PRODUCT.fill,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  ringInner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  activityRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10 },
  activityBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PRODUCT.border,
  },
  activityBody: { flex: 1, minWidth: 0 },
  arrow: { fontFamily: FONTS.sansMedium, fontSize: 13, lineHeight: 17 },
  activityTicker: { fontFamily: PTYPE.ticker.fontFamily, color: PRODUCT.fg },
  activityDetail: { color: PRODUCT.fgFaint },
  activityTime: { marginTop: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { paddingVertical: 32, paddingHorizontal: 24, alignItems: "center", gap: 4 },
  emptyTitle: { fontFamily: PTYPE.body.fontFamily, fontSize: 16, color: PRODUCT.fg, textAlign: "center" },
  ref: {
    marginTop: 6,
    fontFamily: PTYPE.num.fontFamily,
    fontSize: 11,
    letterSpacing: 0.8,
    color: PRODUCT.fgFaint,
    textTransform: "uppercase",
  },
  emptyBody: {
    ...PTYPE.small,
    textAlign: "center",
    maxWidth: 280,
  },
  primaryPill: {
    backgroundColor: PRODUCT.pill,
    borderRadius: RADIUS.pill,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryPillOff: { opacity: 0.35 },
  /** Held: the fill steps down, the way the onboarding CTA's does. */
  primaryPillHeld: { backgroundColor: INK_HELD },
  primaryPillText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 15,
    color: PRODUCT.pillFg,
  },
  quietBtnText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    color: PRODUCT.fgMuted,
  },
  backLink: { flexDirection: "row", alignItems: "center", gap: 2, marginBottom: 16 },
  backLinkText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 15,
    color: PRODUCT.fgMuted,
  },
  retry: {
    marginTop: 8,
    fontFamily: PTYPE.ticker.fontFamily,
    fontSize: 12,
    color: PRODUCT.fg,
  },
  pill: {
    backgroundColor: PRODUCT.fill,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  pillActive: { backgroundColor: PRODUCT.pill },
  pillText: { fontFamily: PTYPE.ticker.fontFamily, fontSize: 14, color: PRODUCT.fgMuted },
  pillTextActive: { color: PRODUCT.pillFg },
});
