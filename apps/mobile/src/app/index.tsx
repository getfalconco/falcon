import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { PrimaryButton } from "@/components/Buttons";
import { GlassButton } from "@/components/GlassButton";
import { haptics } from "@/lib/haptics";
import { useLanguage } from "@/lib/language";
import { GUTTER, colors, fonts } from "@/theme";

const RIPPLE = require("../../assets/onboarding/hero.webp");
/** hero.webp is 1170x1896. */
const RIPPLE_ASPECT = 1896 / 1170;
/** Where the visible window starts: the lower part, with the desk and the wave. */
const RIPPLE_FOCUS = 1;
/** The image's share of the screen's height, and how much of it fades out. */
const HERO_SHARE = 0.68;
const FADE_SHARE = 0.18;
/** The row that holds the language button. */
const TOP_BAR_H = 52;

/** Routes shown over the landing (its sheets): the image stays behind them. */
const OVER_LANDING = new Set(["/", "/sign-in", "/language"]);

/**
 * The first screen after the splash: the ripple render across the top,
 * fading into the page, then the headline, Get Started (the welcome funnel)
 * and Sign in (a sheet with Apple, Google and email). Top right: the language
 * button.
 */
export default function Landing() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const language = useLanguage();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  };

  const heroH = size ? Math.round(size.height * HERO_SHARE) : 0;
  const imageH = size ? size.width * RIPPLE_ASPECT : 0;
  const imageTop = -Math.max(0, Math.min(imageH - heroH, imageH * RIPPLE_FOCUS));
  const fadeH = Math.round(heroH * FADE_SHARE);

  return (
    <View style={styles.screen} onLayout={onLayout}>
      {/* Light status bar text over the dark render, while it is on screen. */}
      {OVER_LANDING.has(pathname) ? <StatusBar style="light" /> : null}

      {size ? (
        <View pointerEvents="none" style={[styles.hero, { height: heroH }]}>
          {/* Stops a few points above the fade's solid end so no edge shows through. */}
          <View style={[styles.imageClip, { height: heroH - 4 }]}>
            <Image
              source={RIPPLE}
              resizeMode="cover"
              style={{ position: "absolute", left: 0, top: imageTop, width: size.width, height: imageH }}
              accessibilityIgnoresInvertColors
            />
          </View>
          <Svg width={size.width} height={fadeH} style={styles.fade}>
            <Defs>
              <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.background} stopOpacity={0} />
                <Stop offset="0.15" stopColor={colors.background} stopOpacity={0.04} />
                <Stop offset="0.3" stopColor={colors.background} stopOpacity={0.14} />
                <Stop offset="0.45" stopColor={colors.background} stopOpacity={0.32} />
                <Stop offset="0.6" stopColor={colors.background} stopOpacity={0.56} />
                <Stop offset="0.75" stopColor={colors.background} stopOpacity={0.8} />
                <Stop offset="0.88" stopColor={colors.background} stopOpacity={0.95} />
                <Stop offset="0.95" stopColor={colors.background} stopOpacity={1} />
                <Stop offset="1" stopColor={colors.background} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width={size.width} height={fadeH} fill="url(#fade)" />
          </Svg>
        </View>
      ) : null}

      <View style={[styles.topBar, { marginTop: insets.top }]}>
        <GlassButton
          accessibilityLabel={`Language: ${language.label}`}
          onPress={() => {
            haptics.select();
            router.push("/language");
          }}
        >
          <Text style={styles.flag}>{language.flag}</Text>
        </GlassButton>
      </View>

      {size ? (
        <View style={[styles.content, { paddingTop: Math.max(0, heroH - insets.top - TOP_BAR_H - 6) }]}>
          <View style={styles.copy}>
            <Text style={styles.headline} accessibilityRole="header">
              See what moves{"\n"}your stocks
            </Text>
            <Text style={styles.description}>Understand your portfolio like never before.</Text>
          </View>

          <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 16) + 4 }]}>
            <PrimaryButton
              label="Get Started"
              onPress={() => {
                haptics.tap();
                router.push("/welcome");
              }}
              style={styles.cta}
            />
            <View style={styles.signInRow}>
              <Text style={styles.quiet}>Already have an account? </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sign in"
                hitSlop={{ top: 12, bottom: 12, left: 6, right: 12 }}
                onPress={() => {
                  haptics.select();
                  router.push("/sign-in");
                }}
              >
                {({ pressed }) => <Text style={[styles.signIn, pressed ? styles.signInPressed : null]}>Sign in</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  hero: { position: "absolute", left: 0, right: 0, top: 0, overflow: "hidden" },
  imageClip: { position: "absolute", left: 0, right: 0, top: 0, overflow: "hidden" },
  fade: { position: "absolute", left: 0, bottom: 0 },
  topBar: {
    height: TOP_BAR_H,
    paddingHorizontal: 20,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  // Apple's emoji on the phone; a bit under the button so it sits centered.
  flag: { fontSize: 22, lineHeight: 28, textAlign: "center" },
  content: { flex: 1, justifyContent: "space-between" },
  copy: { paddingHorizontal: GUTTER },
  // The site's serif headline (Libre Baskerville, as in "Run it from anywhere.")
  headline: {
    fontFamily: fonts.serif,
    fontSize: 32,
    lineHeight: 40,
    letterSpacing: -0.4,
    color: colors.ink,
  },
  description: {
    marginTop: 12,
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 23,
    color: colors.muted,
    maxWidth: 320,
  },
  bottom: { paddingHorizontal: 20, paddingTop: 16 },
  cta: { height: 54, borderRadius: 12 },
  signInRow: { marginTop: 18, flexDirection: "row", justifyContent: "center", alignItems: "center" },
  quiet: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.muted },
  signIn: { fontFamily: fonts.sansMedium, fontSize: 14, lineHeight: 20, color: colors.ink },
  signInPressed: { opacity: 0.55 },
});
