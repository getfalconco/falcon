import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import Animated, {
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { EASE_CALM, colors, fonts, signal } from "@/theme";
import { netBand, signedInt } from "./format";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const SIZE = 236;
const STROKE = 14;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/**
 * The Today ring: Net direction, -100 to 100. The arc starts at the top and
 * runs clockwise for upside, counterclockwise for downside, in the band's
 * color. No value: an empty ring with a dash.
 */
export function DirectionRing({
  value,
  label,
  pending = false,
}: {
  value: number | null;
  label: string;
  /** Still loading: the track and the label only. */
  pending?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const band = netBand(value);
  const fraction = value === null ? 0 : Math.min(1, Math.abs(value) / 100);
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = reduceMotion
      ? fraction
      : withDelay(180, withTiming(fraction, { duration: 1100, easing: EASE_CALM }));
  }, [fraction, progress, reduceMotion]);

  const arc = useAnimatedProps(() => ({ strokeDashoffset: C * (1 - progress.value) }));
  const flip = value !== null && value < 0;

  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        pending ? label : value === null ? `${label}: no reading yet` : `${label}: ${value}. ${band.word}.`
      }
    >
      <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
        <Circle cx={SIZE / 2} cy={SIZE / 2} r={R} stroke={signal.track} strokeWidth={STROKE} fill="none" />
      </Svg>
      {/* The arc starts at 12 o'clock; mirrored for downside so it runs the other way. */}
      {value !== null && fraction > 0 ? (
        <Svg
          width={SIZE}
          height={SIZE}
          style={[StyleSheet.absoluteFill, { transform: [{ rotate: "-90deg" }, { scaleY: flip ? -1 : 1 }] }]}
        >
          <AnimatedCircle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            stroke={band.color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${C} ${C}`}
            animatedProps={arc}
          />
        </Svg>
      ) : null}
      <View style={styles.center} pointerEvents="none">
        <Text style={styles.label}>{label}</Text>
        {pending ? (
          <View style={styles.pending} />
        ) : value === null ? (
          <View style={styles.dash} />
        ) : (
          <Text style={styles.value}>{signedInt(value)}</Text>
        )}
        <Text style={[styles.band, { color: band.color }]}>{band.word || " "}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: SIZE, height: SIZE, alignSelf: "center" },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.42)",
  },
  value: {
    marginTop: 6,
    fontFamily: fonts.serif,
    fontSize: 60,
    lineHeight: 72,
    letterSpacing: -1,
    color: colors.ink,
  },
  dash: {
    marginTop: 43,
    marginBottom: 35,
    width: 30,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(29, 27, 27, 0.28)",
  },
  pending: { height: 81 },
  band: { marginTop: 2, fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 18 },
});
