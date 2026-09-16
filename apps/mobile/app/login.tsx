import { useEffect, useState } from "react";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Field from "@/components/Field";
import GlassIconButton from "@/components/GlassIconButton";
import OtpInput from "@/components/OtpInput";
import PrimaryButton from "@/components/PrimaryButton";
import {
  continueWithEmailPassword,
  requestPasswordReset,
  resendSignupOtp,
  signOut,
  updatePassword,
  verifyEmailOtp,
} from "@/lib/auth";
import { postAuthHref } from "@/lib/post-auth";
import { supabase } from "@/lib/supabase";
import { COLORS, EASE_BEZIER, FONTS, SPACING, TYPE } from "@/theme";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step =
  | { name: "login" }
  | {
      name: "otp";
      email: string;
      title: string;
      subtitle: string;
      /** Recovery codes must verify as "recovery" — "signup" silently fails. */
      otpType: EmailOtpType;
    }
  | { name: "forgot" }
  | { name: "set_password" };

/** Desktop's reveal: height 0 → auto, opacity 0 → 1, marginTop 0 → 12. */
const REVEAL_MS = 280;
const REVEAL_MARGIN = 12;

/**
 * Height wipe, matching the AnimatePresence block around the password field in
 * apps/desktop/.../LoginForm.tsx — same three properties, same 280ms, same
 * shared EASE curve. RN cannot animate to `height: "auto"`, so the child is
 * measured once and the container animates to that number while clipping it.
 */
function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, {
      duration: REVEAL_MS,
      easing: Easing.bezier(...EASE_BEZIER),
    });
  }, [open, progress]);

  const style = useAnimatedStyle(() => ({
    height: contentHeight * progress.value,
    marginTop: REVEAL_MARGIN * progress.value,
    opacity: progress.value,
  }));

  return (
    <Animated.View style={[styles.reveal, style]}>
      {/* Absolute so the animated height never constrains it: the child always
          lays out at its natural size — the "auto" the desktop animates to —
          and the clipping parent decides how much of it shows. */}
      <View
        style={styles.revealInner}
        onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}
      >
        {children}
      </View>
    </Animated.View>
  );
}

/**
 * Sign in — mirrors apps/web/app/components/LoginForm.tsx: one field pair that
 * signs in an existing account or creates a new one, then an 8-digit OTP step
 * (this Supabase project has "Confirm email" on, so signUp alone never returns
 * a session).
 */
export default function LoginScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: "login" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const canContinue = EMAIL_RE.test(email.trim()) && password.length > 0;
  // Same reveal as desktop LoginForm: the password field only exists once
  // there is an email to go with it, so the first screen is a single ask.
  const showPassword = email.trim().length > 0;
  // Always reachable — hiding password reset behind repeated failures just
  // strands anyone who already knows they have forgotten it.
  const showForgot = true;

  async function handleContinue() {
    if (!canContinue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await continueWithEmailPassword(email, password);

      if (result.type === "confirm_email") {
        setCode("");
        setStep({
          name: "otp",
          email: result.email,
          title: "Check your email",
          subtitle: "Enter the 8-digit code we sent to confirm your account.",
          otpType: "signup",
        });
        return;
      }

      if (result.type === "waitlist") {
        router.replace({ pathname: "/status", params: { email: email.trim() } });
        return;
      }

      router.replace(postAuthHref(result.session.user));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(codeOverride?: string) {
    const token = (codeOverride ?? code).trim();
    if (step.name !== "otp" || token.length !== 8 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verifyEmailOtp(step.email, token, step.otpType);
      if (result.type === "set_password") {
        // Recovery verified — the session is live but the password is still
        // the old one, so collect a new one before entering the app.
        setNewPassword("");
        setStep({ name: "set_password" });
        return;
      }
      if (result.type === "waitlist") {
        router.replace({ pathname: "/status", params: { email: step.email } });
        return;
      }
      router.replace(postAuthHref(result.session.user));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (step.name !== "otp" || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (step.otpType === "recovery") {
        await requestPasswordReset(step.email);
      } else {
        await resendSignupOtp(step.email);
      }
      setNote("Sent. Check your inbox again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend the code.");
    } finally {
      setBusy(false);
    }
  }

  async function handleForgot() {
    if (!EMAIL_RE.test(email.trim()) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestPasswordReset(email);
      setCode("");
      setStep({
        name: "otp",
        email: email.trim(),
        title: "Reset your password",
        subtitle: "Enter the 8-digit code we sent to your email.",
        otpType: "recovery",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a reset code.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    try {
      await signOut();
    } catch {
      // No session yet (the code was never confirmed) — still go back.
    }
    setError(null);
    setNote(null);
    setCode("");
    setStep({ name: "login" });
  }

  /* ----------------------------- OTP step ----------------------------- */
  if (step.name === "otp") {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.topBar}>
          <GlassIconButton
            icon="log-out"
            onPress={() => void handleSignOut()}
            accessibilityLabel="Sign out"
          />
        </View>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.body}>
            <Text style={styles.otpTitle}>{step.title}</Text>
            <Text style={styles.otpBlurb}>{step.subtitle}</Text>
            <Text style={styles.sentTo}>{step.email}</Text>

            <View style={styles.codeField}>
              <OtpInput
                length={8}
                value={code}
                autoFocus
                disabled={busy}
                status={error ? "error" : "idle"}
                errorMessage={error}
                hint={note}
                accessibilityLabel="8-digit verification code"
                onChange={(next) => {
                  setCode(next);
                  setError(null);
                }}
                // Same contract as desktop: a full code verifies itself, the
                // button below is only there for a retry.
                onComplete={(next) => void handleVerify(next)}
              />
            </View>
          </View>

          <View style={styles.footer}>
            <PrimaryButton
              label={busy ? "Verifying…" : "Verify"}
              onPress={() => void handleVerify()}
              disabled={code.trim().length !== 8 || busy}
            />
            <Pressable onPress={() => void handleResend()} hitSlop={10}>
              <Text style={styles.link}>Resend code</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  async function handleSetPassword() {
    if (newPassword.length < 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updatePassword(newPassword);
      const { data } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
      router.replace(postAuthHref(data.user));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set your password.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------- Set-password step ------------------------ */
  if (step.name === "set_password") {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.body}>
            <Text style={styles.title}>Choose a new password</Text>
            <Text style={styles.blurb}>
              At least 6 characters, with an uppercase letter, a lowercase letter and a number.
            </Text>
            <View style={styles.field}>
              <Field
                label="New password"
                placeholder="New password"
                secureTextEntry
                autoComplete="new-password"
                autoFocus
                value={newPassword}
                onChangeText={(t) => {
                  setNewPassword(t);
                  setError(null);
                }}
                onSubmitEditing={() => void handleSetPassword()}
              />
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          <View style={styles.footer}>
            <PrimaryButton
              label={busy ? "Saving…" : "Save and continue"}
              onPress={() => void handleSetPassword()}
              disabled={newPassword.length < 6 || busy}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  /* --------------------------- Forgot step ---------------------------- */
  if (step.name === "forgot") {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.body}>
            <Text style={styles.title}>Forgot password</Text>
            <Text style={styles.blurb}>
              We&apos;ll email you a one-time code to reset it.
            </Text>
            <View style={styles.field}>
              <Field
                label="Email"
                placeholder="jane@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                autoFocus
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  setError(null);
                }}
              />
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          <View style={styles.footer}>
            <PrimaryButton
              label={busy ? "Sending…" : "Send code"}
              onPress={() => void handleForgot()}
              disabled={!EMAIL_RE.test(email.trim()) || busy}
            />
            <Pressable onPress={() => setStep({ name: "login" })} hitSlop={10}>
              <Text style={styles.backLink}>← Back</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  /* ---------------------------- Login step ---------------------------- */
  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.bodyScroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.titleCentered}>Welcome to{"\n"}Falcon</Text>
          <Text style={styles.blurbCentered}>Sign in or create an account</Text>

          <View style={styles.fields}>
            <Field
              label="Email"
              placeholder="jane@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              value={email}
              onChangeText={(t) => {
                setEmail(t);
                setError(null);
              }}
            />
            <Reveal open={showPassword}>
              <Field
                label="Password"
                placeholder="Your password"
                secureTextEntry
                autoComplete="current-password"
                value={password}
                onChangeText={(t) => {
                  setPassword(t);
                  setError(null);
                }}
                onSubmitEditing={() => void handleContinue()}
              />
            </Reveal>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {showForgot ? (
            <Pressable onPress={() => setStep({ name: "forgot" })} hitSlop={10}>
              <Text style={styles.link}>Forgot password?</Text>
            </Pressable>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          <PrimaryButton
            label={busy ? "Checking…" : "Continue"}
            onPress={() => void handleContinue()}
            disabled={!canContinue || busy}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  body: { flex: 1, justifyContent: "center", paddingHorizontal: SPACING.lg, gap: SPACING.sm },
  bodyScroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xl,
    gap: SPACING.sm,
  },
  title: { ...TYPE.title },
  titleCentered: { ...TYPE.hero, textAlign: "center" },
  blurb: { ...TYPE.bodySmall },
  blurbCentered: { ...TYPE.bodySmall, textAlign: "center" },
  otpTitle: { ...TYPE.title, textAlign: "center" },
  otpBlurb: { ...TYPE.bodySmall, textAlign: "center" },
  sentTo: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    color: COLORS.ink,
    textAlign: "center",
    marginTop: 2,
  },
  topBar: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm, alignItems: "flex-start" },
  field: { marginTop: SPACING.lg },
  codeField: { marginTop: SPACING.xl, alignItems: "center" },
  fields: { marginTop: SPACING.xl },
  reveal: { overflow: "hidden" },
  revealInner: { position: "absolute", left: 0, right: 0, top: 0 },
  error: { fontFamily: FONTS.sans, fontSize: 13, color: COLORS.error, marginTop: SPACING.md },
  note: { fontFamily: FONTS.sans, fontSize: 13, color: COLORS.muted, marginTop: SPACING.md },
  footer: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.md, gap: SPACING.md },
  link: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    color: COLORS.ink,
    textAlign: "center",
    textDecorationLine: "underline",
  },
  backLink: {
    fontFamily: FONTS.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    color: COLORS.faint,
    textAlign: "center",
  },
});
