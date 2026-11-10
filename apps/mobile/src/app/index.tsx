import { useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PrimaryButton } from "@/components/Buttons";
import { GlassButton } from "@/components/GlassButton";
import { PHONE_ASPECT, PhoneMockup } from "@/components/PhoneMockup";
import { haptics } from "@/lib/haptics";
import { useLanguage } from "@/lib/language";
import { GUTTER, colors, fonts } from "@/theme";

/** The phone's largest width, and the room kept around it. */
const PHONE_MAX_WIDTH = 250;
const PHONE_MARGIN_Y = 20;

/**
 * The first screen after the splash: the phone from the website's "Run it
 * from anywhere" section, then the headline, Get Started (the welcome funnel)
 * and Sign in (a sheet with Apple, Google and email). Top right: the language
 * button.
 */
export default function Landing() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const language = useLanguage();
  const [area, setArea] = useState<{ width: number; height: number } | null>(null);

  const onArea = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setArea((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  };

  const phoneWidth = area
    ? Math.floor(Math.min(PHONE_MAX_WIDTH, area.width * 0.66, (area.height - PHONE_MARGIN_Y * 2) * PHONE_ASPECT))
    : 0;

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 16) }]}>
      <View style={styles.topBar}>
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

      <View style={styles.phoneArea} onLayout={onArea}>
        {phoneWidth > 0 ? <PhoneMockup width={phoneWidth} /> : null}
      </View>

      <View style={styles.bottom}>
        <Text style={styles.headline} accessibilityRole="header">
          See what moves{"\n"}your stocks
        </Text>
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
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topBar: { height: 52, paddingHorizontal: 20, flexDirection: "row", justifyContent: "flex-end", alignItems: "center" },
  // Apple's emoji on the phone; a bit under the button so it sits centered.
  flag: { fontSize: 22, lineHeight: 28, textAlign: "center" },
  phoneArea: { flex: 1, alignItems: "center", justifyContent: "center" },
  bottom: { paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: 8 },
  // The site's serif headline (Libre Baskerville, as in "Run it from anywhere.")
  headline: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 36,
    color: colors.ink,
    textAlign: "center",
  },
  cta: { marginTop: 24 },
  signInRow: { marginTop: 18, flexDirection: "row", justifyContent: "center", alignItems: "center" },
  quiet: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.muted },
  signIn: { fontFamily: fonts.sansMedium, fontSize: 14, lineHeight: 20, color: colors.ink },
  signInPressed: { opacity: 0.55 },
});
