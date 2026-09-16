import { useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  runOnUI,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import PrimaryButton from "@/components/PrimaryButton";
import { COLORS, SPACING, TYPE } from "@/theme";

/**
 * Three slides explaining what Falcon does. Copy is taken from the website's
 * hero and feature grid (apps/web/app/components/Hero.tsx and FeatureGrid.tsx)
 * so the app and the site make the same promise in the same words.
 */
const SLIDES = [
  {
    title: "When one stock moves, know which one moves next",
    body: "See how one company's news moves the stocks around it, before consensus does.",
  },
  {
    title: "Falcon does the research",
    body: "Most tools give you a headline. Falcon traces where it travels next and shows you the connected stock before the market reacts.",
  },
  {
    title: "Every link, sourced",
    body: "Each connection is pulled from real company filings, not guesswork. You can see the exact sentence behind every claim.",
  },
] as const;

/** How far the copy lags behind its page, as a fraction of the screen width. */
const TITLE_LAG = 0.3;
const BODY_LAG = 0.46;
/** Page fraction over which a leaving slide fades out. */
const FADE_SPAN = 0.72;

const DOT_SIZE = 6;
const DOT_ACTIVE_WIDTH = 18;

/**
 * Fade + parallax for one line of copy. `pos` is where this slide sits
 * relative to the viewport: -1 = one page to the right, 0 = centred,
 * 1 = one page to the left. A bigger `lag` trails the page further.
 */
function useCopyLayer(
  scrollX: SharedValue<number>,
  index: number,
  width: number,
  lag: number,
) {
  return useAnimatedStyle(() => {
    const pos = width === 0 ? 0 : (scrollX.value - index * width) / width;
    const away = Math.abs(pos);
    return {
      opacity: interpolate(away, [0, FADE_SPAN], [1, 0], Extrapolation.CLAMP),
      transform: [
        { translateX: pos * width * lag },
        { scale: interpolate(away, [0, 1], [1, 0.94], Extrapolation.CLAMP) },
      ],
    };
  });
}

/**
 * One slide. Title and body ride the scroll at different speeds, so a swipe
 * reads as depth rather than a flat pan: the heading trails the page, the
 * paragraph trails it further, and both dissolve before the next slide lands.
 */
function Slide({
  title,
  body,
  index,
  scrollX,
  width,
}: {
  title: string;
  body: string;
  index: number;
  scrollX: SharedValue<number>;
  width: number;
}) {
  const titleStyle = useCopyLayer(scrollX, index, width, TITLE_LAG);
  const bodyStyle = useCopyLayer(scrollX, index, width, BODY_LAG);

  return (
    <View style={[styles.slide, { width }]}>
      <Animated.Text style={[styles.title, titleStyle]}>{title}</Animated.Text>
      <Animated.Text style={[styles.body, bodyStyle]}>{body}</Animated.Text>
    </View>
  );
}

/** Pager dot: widens into a pill and darkens as its page comes to rest. */
function Dot({
  index,
  scrollX,
  width,
}: {
  index: number;
  scrollX: SharedValue<number>;
  width: number;
}) {
  const style = useAnimatedStyle(() => {
    const pos = width === 0 ? 0 : (scrollX.value - index * width) / width;
    const away = Math.min(Math.abs(pos), 1);
    return {
      width: interpolate(away, [0, 1], [DOT_ACTIVE_WIDTH, DOT_SIZE], Extrapolation.CLAMP),
      backgroundColor: interpolateColor(away, [0, 1], [COLORS.ink, COLORS.dash]),
    };
  });

  return <Animated.View style={[styles.dot, style]} />;
}

export default function IntroScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const listRef = useAnimatedRef<Animated.ScrollView>();
  const scrollX = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollX.value = e.contentOffset.x;
  });

  const isLast = index === SLIDES.length - 1;

  function handleMomentumEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  }

  function handleContinue() {
    if (isLast) {
      router.replace("/login");
      return;
    }
    const next = index + 1;
    // Reanimated's own scroll command: it runs on the UI thread, so the page
    // turn stays in step with the parallax instead of trailing a frame behind.
    const x = next * width;
    runOnUI(() => {
      "worklet";
      scrollTo(listRef, x, 0, true);
    })();
    setIndex(next);
  }

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <Animated.ScrollView
        ref={listRef}
        style={styles.list}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        // Every frame — the parallax runs on the UI thread, so this costs no
        // bridge traffic and a throttled handler would visibly step.
        scrollEventThrottle={1}
        onMomentumScrollEnd={handleMomentumEnd}
      >
        {SLIDES.map((slide, i) => (
          <Slide
            key={slide.title}
            title={slide.title}
            body={slide.body}
            index={i}
            scrollX={scrollX}
            width={width}
          />
        ))}
      </Animated.ScrollView>

      <View style={styles.footer}>
        <View style={styles.dots}>
          {SLIDES.map((slide, i) => (
            <Dot key={slide.title} index={i} scrollX={scrollX} width={width} />
          ))}
        </View>

        <PrimaryButton
          label={isLast ? "Get started" : "Continue"}
          onPress={handleContinue}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  list: { flex: 1 },
  slide: {
    // Horizontal ScrollView stretches its children to the full height, so the
    // copy centres against the viewport without measuring anything.
    justifyContent: "center",
    paddingHorizontal: SPACING.lg,
  },
  title: { ...TYPE.hero, marginBottom: SPACING.md },
  body: { ...TYPE.body, maxWidth: 340 },
  footer: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
    gap: SPACING.lg,
  },
  dots: { flexDirection: "row", gap: 6, justifyContent: "center", alignItems: "center" },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: COLORS.dash,
  },
});
