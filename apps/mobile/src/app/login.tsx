import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";
import { BackButton, PrimaryButton } from "@/components/Buttons";
import { OtpInput, type OtpInputHandle } from "@/components/OtpInput";
import { Reveal } from "@/components/Reveal";
import { TextField } from "@/components/TextField";
import { API_URL } from "@/lib/env";
import { haptics } from "@/lib/haptics";
import { getSupabase } from "@/lib/supabase";
import { GUTTER, colors, fonts } from "@/theme";

/**
 * Sign in or create an account with an emailed code, on the website's
 * Supabase project. The project sends 8-digit codes (emails/supabase), so the
 * code field takes 8.
 */
const OTP_LENGTH = 8;
const RESEND_SECONDS = 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = { name: "email" } | { name: "code"; email: string };

function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length <= 2) return `${local[0] ?? ""}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function authMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("security purposes")) {
    return "Too many tries. Wait a minute and try again.";
  }
  if (lower.includes("network") || lower.includes("fetch")) {
    return "We couldn't reach Falcon. Check your connection.";
  }
  if (lower.includes("token") && (lower.includes("expired") || lower.includes("invalid"))) {
    return "That code is invalid or has expired.";
  }
  return message || "Something went wrong. Please try again.";
}

export default function Login() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>({ name: "email" });

  const body =
    step.name === "email" ? (
      <EmailStep key="email" onSent={(email) => setStep({ name: "code", email })} />
    ) : (
      <CodeStep
        key="code"
        email={step.email}
        onBack={() => setStep({ name: "email" })}
        onVerified={() => router.replace("/welcome")}
      />
    );

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {body}
      </KeyboardAvoidingView>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function EmailStep({ onSent }: { onSent: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = email.trim();
  const valid = EMAIL_PATTERN.test(trimmed);

  async function sendCode() {
    if (!valid || loading) return;
    const supabase = getSupabase();
    if (!supabase) {
      setError("Sign in isn't set up in this build.");
      return;
    }
    haptics.tap();
    setLoading(true);
    setError(null);
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: trimmed,
        // New emails get an account, marked like the website's sign-ups.
        options: { shouldCreateUser: true, data: { waitlist: true } },
      });
      if (otpError) throw otpError;
      Keyboard.dismiss();
      onSent(trimmed);
    } catch (err) {
      haptics.error();
      setError(authMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.centered}
        keyboardShouldPersistTaps="handled"
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        <Reveal order={0}>
          <Text style={styles.title} accessibilityRole="header">
            Welcome to{"\n"}Falcon
          </Text>
        </Reveal>
        <Reveal order={1}>
          <Text style={styles.subtitle}>Sign in or create an account</Text>
        </Reveal>

        <Reveal order={2} style={styles.form}>
          <TextField
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              if (error) setError(null);
            }}
            placeholder="Enter email address"
            accessibilityLabel="Email"
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => void sendCode()}
            editable={!loading}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton
            label="Continue"
            onPress={() => void sendCode()}
            disabled={!valid}
            loading={loading}
            style={styles.formButton}
          />
          <Text style={styles.hint}>We'll email you a code to sign in. No password needed.</Text>
        </Reveal>
      </ScrollView>

      <Reveal order={3}>
        <Text style={styles.legal}>
          By continuing you agree to the{" "}
          <Text style={styles.link} onPress={() => void WebBrowser.openBrowserAsync(`${API_URL}/terms`)}>
            Terms of Service
          </Text>{" "}
          and acknowledge the{" "}
          <Text style={styles.link} onPress={() => void WebBrowser.openBrowserAsync(`${API_URL}/privacy`)}>
            Privacy Policy
          </Text>
          .
        </Text>
      </Reveal>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Code                                                                */
/* ------------------------------------------------------------------ */

function CodeStep({ email, onBack, onVerified }: { email: string; onBack: () => void; onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  const otp = useRef<OtpInputHandle>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function verify(token: string) {
    const supabase = getSupabase();
    if (!supabase || busy.current) return;
    busy.current = true;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({ email, token, type: "email" });
      if (verifyError) throw verifyError;
      if (!data.session) throw new Error("We couldn't sign you in. Try again.");
      haptics.success();
      setVerified(true);
      Keyboard.dismiss();
      setTimeout(onVerified, 250);
    } catch (err) {
      haptics.error();
      setError(authMessage(err));
      setCode("");
      otp.current?.focus();
    } finally {
      busy.current = false;
      setVerifying(false);
    }
  }

  async function resend() {
    const supabase = getSupabase();
    if (!supabase || cooldown > 0 || verifying) return;
    setError(null);
    setNotice(null);
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, data: { waitlist: true } },
      });
      if (otpError) throw otpError;
      setCode("");
      setNotice("Code sent again.");
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(authMessage(err));
    }
  }

  return (
    <View style={styles.flex}>
      <View style={styles.topBar}>
        <BackButton onPress={onBack} disabled={verifying || verified} />
      </View>
      <ScrollView
        contentContainerStyle={styles.codeContent}
        keyboardShouldPersistTaps="handled"
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        <Reveal order={0}>
          <Text style={styles.title} accessibilityRole="header">
            Check your email
          </Text>
        </Reveal>
        <Reveal order={1}>
          <Text style={styles.subtitle}>Enter the {OTP_LENGTH}-digit code we sent to</Text>
          <Text style={styles.email}>{maskEmail(email)}</Text>
        </Reveal>

        <Reveal order={2} style={styles.form}>
          <OtpInput
            ref={otp}
            length={OTP_LENGTH}
            value={code}
            onChange={(next) => {
              setCode(next);
              if (error) setError(null);
            }}
            onComplete={(full) => void verify(full)}
            disabled={verifying || verified}
            error={Boolean(error)}
            autoFocus
          />
          <View style={styles.status}>
            {verifying ? (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={colors.muted} />
                <Text style={styles.statusText}>Verifying</Text>
              </View>
            ) : verified ? (
              <Text style={styles.statusText}>Verified.</Text>
            ) : error ? (
              <Text style={styles.errorCenter}>{error}</Text>
            ) : notice ? (
              <Text style={styles.statusText}>{notice}</Text>
            ) : null}
          </View>
        </Reveal>

        <Reveal order={3}>
          <Pressable
            accessibilityRole="button"
            onPress={() => void resend()}
            disabled={cooldown > 0 || verifying || verified}
            hitSlop={10}
            style={styles.resend}
          >
            <Text style={[styles.resendText, cooldown > 0 ? styles.resendWaiting : null]}>
              {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
            </Text>
          </Pressable>
        </Reveal>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  centered: { flexGrow: 1, justifyContent: "center", paddingHorizontal: GUTTER, paddingVertical: 32 },
  codeContent: { flexGrow: 1, paddingHorizontal: GUTTER, paddingTop: 28, paddingBottom: 32 },
  topBar: { paddingHorizontal: GUTTER - 4, paddingTop: 8, height: 52, justifyContent: "center" },
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 40,
    letterSpacing: 0.3,
    color: colors.ink,
    textAlign: "center",
  },
  subtitle: {
    marginTop: 12,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.muted,
    textAlign: "center",
  },
  email: {
    marginTop: 2,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: "rgba(0, 0, 0, 0.7)",
    textAlign: "center",
  },
  form: { marginTop: 32 },
  formButton: { marginTop: 12 },
  hint: {
    marginTop: 14,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.placeholder,
    textAlign: "center",
  },
  error: { marginTop: 10, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.error, textAlign: "center" },
  errorCenter: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.error, textAlign: "center" },
  status: { minHeight: 40, marginTop: 14, alignItems: "center", justifyContent: "flex-start" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusText: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.muted },
  resend: { alignSelf: "center", paddingVertical: 6 },
  resendText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.muted,
    textDecorationLine: "underline",
  },
  resendWaiting: { color: colors.placeholder, textDecorationLine: "none" },
  legal: {
    paddingHorizontal: GUTTER + 8,
    paddingBottom: 12,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.faint,
    textAlign: "center",
  },
  link: { color: "#6f6f6f", textDecorationLine: "underline" },
});

