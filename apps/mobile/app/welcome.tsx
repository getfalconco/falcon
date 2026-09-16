import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import PrimaryButton from "@/components/PrimaryButton";
import Ticket, { TICKET_RATIO } from "@/components/Ticket";
import { supabase } from "@/lib/supabase";
import { postAuthHref } from "@/lib/post-auth";
import { COLORS, EASE_OUT_BEZIER, FONTS, SPACING, TYPE } from "@/theme";

/**
 * The approved reveal, rebuilt from WaitlistView.tsx's tear choreography:
 * the ticket pulses until tapped, then the stub rips away along the
 * perforation, the main piece recentres, and "Welcome, Name" types in above it.
 *
 * Beat timings (ms from the tap) mirror the web's C_* constants.
 */
const TEAR_MS = 750;
const C_CENTER = 850;
const C_WELCOME = 1500;
const REVEAL_MS = 650;
const TYPE_SPEED_MS = 75;

const PERF_PCT = 0.7584;

function firstNameOf(full: string): string {
  return full.trim().split(/\s+/).filter(Boolean)[0] ?? "Member";
}

export default function WelcomeScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{
    name?: string;
    memberNumber?: string;
    grantedAt?: string;
  }>();

  const ticketWidth = Math.min(width - SPACING.lg * 2, 360);
  const ticketHeight = ticketWidth * TICKET_RATIO;
  const stubWidth = ticketWidth * (1 - PERF_PCT);

  const fullName = params.name ?? "";
  const first = firstNameOf(fullName);
  const nameParts = fullName.trim().split(/\s+/).filter(Boolean);
  const suffix = `, ${first}`;

  const [torn, setTorn] = useState(false);
  const [typed, setTyped] = useState("");

  const pulse = useSharedValue(1);
  const stubX = useSharedValue(0);
  const stubY = useSharedValue(0);
  const stubRotate = useSharedValue(0);
  const stubOpacity = useSharedValue(1);
  const mainX = useSharedValue(0);
  const mainRotate = useSharedValue(0);
  const reveal = useSharedValue(0);

  const easing = Easing.bezier(...EASE_OUT_BEZIER);

  // Heartbeat until the ticket is torn.
  useEffect(() => {
    if (torn) {
      pulse.value = withTiming(1, { duration: 200 });
      return;
    }
    pulse.value = withDelay(
      700,
      withRepeat(
        withSequence(
          withTiming(1.035, { duration: 190, easing }),
          withTiming(1, { duration: 190, easing }),
          withTiming(1.018, { duration: 190, easing }),
          withTiming(1, { duration: 760, easing }),
        ),
        -1,
        false,
      ),
    );
  }, [torn, pulse, easing]);

  function handleTear() {
    if (torn) return;
    setTorn(true);

    // Stub rips off along the perforation and falls away.
    stubX.value = withTiming(stubWidth * 0.9, { duration: TEAR_MS, easing: Easing.in(Easing.quad) });
    stubY.value = withTiming(ticketHeight * 0.35, { duration: TEAR_MS, easing: Easing.in(Easing.quad) });
    stubRotate.value = withTiming(22, { duration: TEAR_MS, easing: Easing.in(Easing.quad) });
    stubOpacity.value = withTiming(0, { duration: TEAR_MS });

    // Main piece recoils, then slides to the visual centre.
    mainRotate.value = withSequence(
      withTiming(-1.6, { duration: 120, easing }),
      withTiming(0.9, { duration: 180, easing }),
      withTiming(0, { duration: 200, easing }),
    );
    mainX.value = withDelay(
      C_CENTER,
      withTiming(stubWidth / 2, { duration: 600, easing }),
    );

    reveal.value = withDelay(C_WELCOME, withTiming(1, { duration: REVEAL_MS, easing }));
  }

  // Type ", Name" once "Welcome" has settled. Driven by a plain timer rather
  // than the animation callback so it doesn't depend on worklet capture.
  useEffect(() => {
    if (!torn) {
      setTyped("");
      return;
    }
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      let i = 0;
      interval = setInterval(() => {
        i += 1;
        setTyped(suffix.slice(0, i));
        if (i >= suffix.length && interval) clearInterval(interval);
      }, TYPE_SPEED_MS);
    }, C_WELCOME + REVEAL_MS);

    return () => {
      clearTimeout(start);
      if (interval) clearInterval(interval);
    };
  }, [torn, suffix]);

  const ticketStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  const mainStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: mainX.value }, { rotate: `${mainRotate.value}deg` }],
  }));
  const stubStyle = useAnimatedStyle(() => ({
    opacity: stubOpacity.value,
    transform: [
      { translateX: stubX.value },
      { translateY: stubY.value },
      { rotate: `${stubRotate.value}deg` },
    ],
  }));
  const revealStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: (1 - reveal.value) * 14 }],
  }));

  const memberLabel = params.memberNumber
    ? `Member #${params.memberNumber.padStart(3, "0")}`
    : "Member #001";

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.body}>
        <Animated.View style={[styles.welcomeSlot, revealStyle]}>
          <Text style={styles.welcome}>
            Welcome
            {typed}
          </Text>
        </Animated.View>

        {!torn ? <Text style={styles.eyebrow}>TAP YOUR TICKET</Text> : null}

        <Pressable
          onPress={handleTear}
          disabled={torn}
          accessibilityRole="button"
          accessibilityLabel="Tear your ticket"
        >
          <Animated.View style={[{ width: ticketWidth, height: ticketHeight }, ticketStyle]}>
            {/* Main piece — clipped at the perforation. */}
            <Animated.View style={[styles.piece, { width: ticketWidth * PERF_PCT }, mainStyle]}>
              <Ticket
                width={ticketWidth}
                firstName={nameParts[0]}
                lastName={nameParts.slice(1).join(" ")}
                memberLabel={memberLabel}
                grantedAt={params.grantedAt}
              />
            </Animated.View>

            {/* Stub — the piece that rips away. */}
            <Animated.View
              style={[
                styles.piece,
                styles.stubPiece,
                { width: stubWidth, left: ticketWidth * PERF_PCT },
                stubStyle,
              ]}
            >
              <View style={{ marginLeft: -ticketWidth * PERF_PCT }}>
                <Ticket
                  width={ticketWidth}
                  firstName={nameParts[0]}
                  lastName={nameParts.slice(1).join(" ")}
                  memberLabel={memberLabel}
                  grantedAt={params.grantedAt}
                />
              </View>
            </Animated.View>
          </Animated.View>
        </Pressable>

        <Animated.View style={[styles.ctaSlot, revealStyle]}>
          <Text style={styles.ctaCopy}>Your early access is active.</Text>
          <PrimaryButton
            label="Enter Falcon"
            onPress={() => {
              void (async () => {
                const { data } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
                router.replace(postAuthHref(data.user));
              })();
            }}
          />
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  body: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.lg,
    gap: SPACING.lg,
  },
  welcomeSlot: { minHeight: 48, justifyContent: "flex-end" },
  welcome: { ...TYPE.hero, textAlign: "center" },
  eyebrow: { ...TYPE.eyebrow },
  // Each half clips the shared ticket artwork so the two pieces line up
  // exactly along the perforation before the tear.
  piece: { position: "absolute", top: 0, bottom: 0, overflow: "hidden" },
  stubPiece: { alignItems: "flex-start" },
  ctaSlot: { alignSelf: "stretch", gap: SPACING.md, alignItems: "center" },
  ctaCopy: {
    fontFamily: FONTS.sans,
    fontSize: 14,
    color: COLORS.muted,
    textAlign: "center",
  },
});
