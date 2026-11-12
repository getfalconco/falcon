import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { haptics } from "@/lib/haptics";
import { EASE_CALM, colors, fonts } from "@/theme";

const INSET = 3;

/** An iOS-style segmented control with a sliding thumb. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );
  const itemW = width > 0 ? (width - INSET * 2) / options.length : 0;
  const x = useSharedValue(-1);

  useEffect(() => {
    if (itemW <= 0) return;
    const target = INSET + index * itemW;
    x.value = reduceMotion || x.value < 0 ? target : withTiming(target, { duration: 280, easing: EASE_CALM });
  }, [index, itemW, reduceMotion, x]);

  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: Math.max(0, x.value) }] }));

  return (
    <View style={styles.track} role="tablist" onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {itemW > 0 ? <Animated.View style={[styles.thumb, { width: itemW }, thumb]} /> : null}
      {options.map((option) => {
        const on = option.id === value;
        return (
          <Pressable
            key={option.id}
            role="tab"
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={option.label}
            onPress={() => {
              if (on) return;
              haptics.select();
              onChange(option.id);
            }}
            style={styles.item}
          >
            <Text style={[styles.label, on ? styles.labelOn : null]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 38,
    borderRadius: 11,
    padding: INSET,
    flexDirection: "row",
    backgroundColor: "rgba(0, 0, 0, 0.05)",
  },
  thumb: {
    position: "absolute",
    top: INSET,
    bottom: INSET,
    left: 0,
    borderRadius: 8,
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.10), 0 1px 1px rgba(0, 0, 0, 0.04)",
  },
  item: { flex: 1, alignItems: "center", justifyContent: "center" },
  label: { fontFamily: fonts.sans, fontSize: 14, color: colors.muted },
  labelOn: { fontFamily: fonts.sansMedium, color: colors.ink },
});
