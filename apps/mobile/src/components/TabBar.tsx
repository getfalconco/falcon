import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { BlurView } from "expo-blur";
import { Binoculars, BriefcaseBusiness, CircleUserRound, Sunrise, type LucideIcon } from "lucide-react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import type { BottomTabBarProps } from "expo-router/tabs";
import { haptics } from "@/lib/haptics";
import { EASE_CALM, colors, fonts } from "@/theme";

/** The bar's height and its gap above the screen's bottom edge (iOS 26 sizes). */
export const TAB_BAR_HEIGHT = 62;
export const TAB_BAR_SIDE = 21;
/** How far scrolling content has to clear at the bottom: the bar plus a little air. */
export function tabBarClearance(bottomInset: number): number {
  return tabBarBottom(bottomInset) + TAB_BAR_HEIGHT + 20;
}
function tabBarBottom(bottomInset: number): number {
  return Math.max(bottomInset - 13, 12);
}

const ICONS: Record<string, LucideIcon> = {
  today: Sunrise,
  sightings: Binoculars,
  portfolio: BriefcaseBusiness,
  you: CircleUserRound,
};

const PILL_INSET = 4;

/**
 * Browser preview only: the iPhone's floating Liquid Glass tab bar drawn in
 * React Native (the phone itself uses the system bar, app/(tabs)/_layout.tsx).
 */
export function TabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const count = state.routes.length;
  const itemW = width > 0 ? (width - PILL_INSET * 2) / count : 0;
  const x = useSharedValue(0);
  const ready = itemW > 0;

  useEffect(() => {
    if (!ready) return;
    const target = PILL_INSET + state.index * itemW;
    x.value = reduceMotion || x.value === 0 ? target : withTiming(target, { duration: 320, easing: EASE_CALM });
  }, [itemW, ready, reduceMotion, state.index, x]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: tabBarBottom(insets.bottom) }]}>
      <View style={styles.bar} onLayout={onLayout}>
        <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.glass]} />
        {ready ? <Animated.View style={[styles.pill, { width: itemW }, pill]} /> : null}
        <View role="tablist" style={styles.row}>
          {state.routes.map((route, index) => {
            const focused = index === state.index;
            const { options } = descriptors[route.key];
            const label = options.title ?? route.name;
            const Icon = ICONS[route.name] ?? Sunrise;
            const tint = focused ? colors.primary : "#7d7b78";
            return (
              <Pressable
                key={route.key}
                role="tab"
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: focused }}
                onPress={() => {
                  const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                  if (!focused && !event.defaultPrevented) {
                    haptics.select();
                    navigateToTab(route.key);
                  }
                }}
                style={({ pressed }) => [styles.item, pressed && !focused ? styles.pressed : null]}
              >
                <Icon size={22} strokeWidth={focused ? 1.9 : 1.6} color={tint} />
                <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: TAB_BAR_SIDE, right: TAB_BAR_SIDE },
  bar: {
    height: TAB_BAR_HEIGHT,
    borderRadius: TAB_BAR_HEIGHT / 2,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: "rgba(0, 0, 0, 0.06)",
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.10), 0 1px 2px rgba(0, 0, 0, 0.04)",
  },
  glass: { backgroundColor: "rgba(253, 253, 253, 0.72)" },
  pill: {
    position: "absolute",
    top: PILL_INSET,
    bottom: PILL_INSET,
    left: 0,
    borderRadius: (TAB_BAR_HEIGHT - PILL_INSET * 2) / 2,
    backgroundColor: "rgba(0, 0, 0, 0.06)",
  },
  row: { flex: 1, flexDirection: "row", paddingHorizontal: PILL_INSET },
  item: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3 },
  pressed: { opacity: 0.6 },
  label: { fontFamily: fonts.sansMedium, fontSize: 10, lineHeight: 12, letterSpacing: 0.1 },
});
