import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Field from "@/components/Field";
import GlassIconButton from "@/components/GlassIconButton";
import PrimaryButton from "@/components/PrimaryButton";
import Ticket from "@/components/Ticket";
import { signOut } from "@/lib/auth";
import { fetchMembership, type Membership } from "@/lib/waitlist";
import { supabase } from "@/lib/supabase";
import { COLORS, EASE_OUT_BEZIER, FONTS, SPACING, TYPE } from "@/theme";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Copy mirrored from AUTH.waitlist in apps/web/lib/marketing-copy.ts. */
const WAITLIST_COPY = {
  title: "You're on the waitlist",
  body: "We're not open to everyone yet. Access is going out slowly, to traders who want depth over noise.",
  approved:
    "Once you're approved, we'll let you know by email and phone, and walk you through setting up your desk.",
};

function splitName(full: string | null): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

export default function StatusScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ email?: string }>();
  const ticketWidth = Math.min(width - SPACING.lg * 2, 360);

  const [membership, setMembership] = useState<Membership | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** True when we have no email at all and must ask for one. */
  const [needsEmail, setNeedsEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");

  const enter = useSharedValue(0);

  const load = useCallback(
    async (emailOverride?: string) => {
      setLoading(true);
      setError(null);
      try {
        // Prefer an explicitly entered address, then the one we were routed
        // with, then the signed-in user's.
        let email = emailOverride ?? params.email ?? "";
        if (!email && supabase) {
          const { data } = await supabase.auth.getUser();
          email = data.user?.email ?? "";
        }
        if (!email) {
          // Reached from "Already applied?" with no session — ask which
          // account to look up rather than dead-ending on an error.
          setNeedsEmail(true);
          return;
        }
        setNeedsEmail(false);
        setMembership(await fetchMembership(email));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load your status.");
      } finally {
        setLoading(false);
      }
    },
    [params.email],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function lookUpEntered() {
    const trimmed = emailInput.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("Enter the email address you applied with.");
      return;
    }
    await load(trimmed);
  }

  useEffect(() => {
    if (loading) return;
    enter.value = withTiming(1, {
      duration: 550,
      easing: Easing.bezier(...EASE_OUT_BEZIER),
    });
  }, [loading, enter]);

  // Approved members go straight to the tear reveal.
  useEffect(() => {
    if (membership?.approved) {
      router.replace({
        pathname: "/welcome",
        params: {
          name: membership.name ?? "",
          memberNumber: String(membership.memberNumber ?? ""),
          grantedAt: membership.grantedAt ?? "",
        },
      });
    }
  }, [membership, router]);

  async function handleSignOut() {
    try {
      await signOut();
    } catch {
      // No session / not configured — still land the user back on login.
    }
    router.replace("/login");
  }

  const revealStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 18 }],
  }));

  if (loading) {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <ActivityIndicator color={COLORS.ink} />
      </SafeAreaView>
    );
  }

  // No email and no session — ask which account to check.
  if (needsEmail) {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.lookupBody}>
            <Text style={styles.title}>Check your status</Text>
            <Text style={styles.lookupBlurb}>
              Enter the email you applied with and we&apos;ll pull up your ticket.
            </Text>

            <View style={styles.lookupField}>
              <Field
                label="Email"
                placeholder="jane@example.com"
                autoComplete="email"
                keyboardType="email-address"
                autoCapitalize="none"
                autoFocus
                value={emailInput}
                onChangeText={(t) => {
                  setEmailInput(t);
                  setError(null);
                }}
                onSubmitEditing={() => void lookUpEntered()}
              />
            </View>

            {error ? <Text style={styles.lookupError}>{error}</Text> : null}
          </View>

          <View style={styles.lookupFooter}>
            <PrimaryButton
              label="Check status"
              onPress={() => void lookUpEntered()}
              disabled={!emailInput.trim()}
            />
            <Pressable onPress={() => router.replace("/login")} hitSlop={10}>
              <Text style={styles.backLink}>← Sign in instead</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <View style={styles.errorBox}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={TYPE.body}>{error}</Text>
          <Pressable onPress={() => void load()} hitSlop={10}>
            <Text style={styles.retry}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // The lookup succeeded but there's no application for that address — don't
  // render a membership ticket for someone who never applied.
  if (membership && !membership.found) {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <View style={styles.errorBox}>
          <Text style={styles.title}>No application found</Text>
          <Text style={styles.notFoundBody}>
            We couldn&apos;t find an early-access application for that email.
            Check the address, or apply now.
          </Text>
          <View style={styles.notFoundActions}>
            <PrimaryButton
              label="Apply for early access"
              onPress={() => router.replace("/signup")}
            />
            <Pressable
              onPress={() => {
                setMembership(null);
                setEmailInput("");
                setNeedsEmail(true);
              }}
              hitSlop={10}
            >
              <Text style={styles.retry}>Try a different email</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const { first, last } = splitName(membership?.name ?? null);
  const numberLabel =
    membership?.memberNumber != null
      ? `Member #${String(membership.memberNumber).padStart(3, "0")}`
      : "Member #———";

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.topBar}>
        <GlassIconButton
          icon="log-out"
          onPress={() => void handleSignOut()}
          accessibilityLabel="Sign out"
        />
      </View>
      <ScrollView
        contentContainerStyle={styles.successScroll}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View style={[styles.body, revealStyle]}>
        <Text style={styles.title}>{WAITLIST_COPY.title}</Text>

        <Ticket
          width={ticketWidth}
          firstName={first}
          lastName={last}
          memberLabel={numberLabel}
          grantedAt={membership?.grantedAt ?? undefined}
        />

        <View style={styles.copy}>
          <Text style={styles.bodyText}>{WAITLIST_COPY.body}</Text>
          <Text style={styles.bodyFaint}>{WAITLIST_COPY.approved}</Text>
        </View>
      </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  center: { alignItems: "center", justifyContent: "center" },
  body: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.lg,
    gap: SPACING.xl,
  },
  title: { ...TYPE.title, textAlign: "center" },
  copy: { gap: SPACING.md },
  bodyText: { ...TYPE.bodySmall, textAlign: "center" },
  bodyFaint: { ...TYPE.bodySmall, color: COLORS.faint, textAlign: "center" },
  errorBox: { paddingHorizontal: SPACING.lg, gap: SPACING.md, alignItems: "center" },
  notFoundBody: { ...TYPE.bodySmall, textAlign: "center" },
  notFoundActions: { alignSelf: "stretch", gap: SPACING.md, marginTop: SPACING.sm },
  retry: {
    fontFamily: FONTS.sansMedium,
    fontSize: 14,
    color: COLORS.ink,
    textDecorationLine: "underline",
  },
  flex: { flex: 1 },
  successScroll: { flexGrow: 1, justifyContent: "center" },
  lookupBody: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: SPACING.lg,
    gap: SPACING.sm,
  },
  lookupBlurb: { ...TYPE.bodySmall },
  lookupField: { marginTop: SPACING.lg },
  lookupError: { fontFamily: FONTS.sans, fontSize: 13, color: COLORS.error, marginTop: SPACING.sm },
  lookupFooter: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.md, gap: SPACING.md },
  backLink: {
    fontFamily: FONTS.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    color: COLORS.faint,
    textAlign: "center",
  },
  topBar: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    alignItems: "flex-start",
  },
});
