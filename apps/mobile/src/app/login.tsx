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
import { ArrowLeft } from "lucide-react-native";
import { AuthButton, authMessage } from "@/components/AuthButton";
import { AppleIcon, GoogleIcon } from "@/components/BrandIcons";
import { OtpInput, type OtpInputHandle } from "@/components/OtpInput";
import { PixelArrow } from "@/components/PixelArrow";
import { Reveal } from "@/components/Reveal";
import { TextField } from "@/components/TextField";
import { API_URL } from "@/lib/env";
import { haptics } from "@/lib/haptics";
import { signInWithApple, signInWithGoogle, type OAuthResult } from "@/lib/oauth";
import { getSupabase } from "@/lib/supabase";
import { colors, fonts } from "@/theme";

/**
 * The website's login form (apps/web LoginForm.tsx): same copy, fonts, sizes,
 * spacing, borders and colors (no glass panel in the app). Signing in is by emailed code on the website's
 * Supabase project, which sends 6-digit codes.
 */
/** The emailed code's length (the Supabase project's OTP length setting). */
const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The site's light auth theme background: hsl(60 25% 98%). */
const AUTH_BACKGROUND = "#fbfbf9";

type Step = { name: "email" } | { name: "code"; email: string };

function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length <= 2) return `${local[0] ?? ""}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

export default function Login() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>({ name: "email" });
  // Opened from the landing's sign-in sheet: a back arrow returns there.
  // Read after mount: the router's focus state is stale during render.
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => setCanGoBack(router.canGoBack()), [router]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {step.name === "email" ? (
          <View style={styles.flex}>
            {canGoBack ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back"
                onPress={() => router.back()}
                hitSlop={8}
                style={({ pressed }) => [styles.back, pressed ? styles.backPressed : null]}
              >
                <ArrowLeft size={16} strokeWidth={1.75} color="rgba(0, 0, 0, 0.35)" />
              </Pressable>
            ) : null}
            <EmailStep
              onSent={(email) => setStep({ name: "code", email })}
              onSignedIn={() => router.replace("/welcome")}
            />
          </View>
        ) : (
          <CodeStep
            email={step.email}
            onBack={() => setStep({ name: "email" })}
            onVerified={() => router.replace("/welcome")}
          />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

/** GetStartedButton: dark, label left, the marching pixel arrow right. */
function ContinueButton({ onPress, disabled, loading }: { onPress: () => void; disabled: boolean; loading: boolean }) {
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Continue"
      accessibilityState={{ disabled: off, busy: loading }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [styles.primary, pressed && !off ? styles.primaryPressed : null, off ? styles.disabled : null]}
    >
      <View style={styles.primaryLabel}>
        {loading ? <ActivityIndicator size="small" color={colors.primaryText} /> : null}
        <Text style={[styles.buttonText, { color: colors.primaryText }]}>Continue</Text>
      </View>
      <PixelArrow />
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function EmailStep({ onSent, onSignedIn }: { onSent: (email: string) => void; onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<"google" | "apple" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function continueWith(which: "google" | "apple") {
    if (provider || loading) return;
    haptics.tap();
    setProvider(which);
    setError(null);
    let result: OAuthResult;
    try {
      result = await (which === "google" ? signInWithGoogle() : signInWithApple());
    } catch (err) {
      result = { ok: false, canceled: false, message: authMessage(err) };
    }
    setProvider(null);
    if (result.ok) {
      haptics.success();
      onSignedIn();
    } else if (!result.canceled) {
      haptics.error();
      setError(result.message ?? "Sign in failed. Please try again.");
    }
  }
  const trimmed = email.trim();
  const valid = EMAIL_PATTERN.test(trimmed);

  async function sendCode() {
    if (!valid || loading) return;
    const supabase = getSupabase();
    if (!supabase) {
      setError("Supabase is not configured.");
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
        <View style={styles.column}>
          <Text style={styles.title} accessibilityRole="header">
            Welcome to{"\n"}Falcon
          </Text>
          <Text style={styles.subtitle}>Sign in or create an account</Text>

          <View style={styles.oauthStack}>
            <AuthButton
              icon={<GoogleIcon />}
              label="Continue with Google"
              onPress={() => void continueWith("google")}
              busy={provider === "google"}
              disabled={provider !== null || loading}
            />
            <AuthButton
              icon={<AppleIcon />}
              label="Continue with Apple"
              onPress={() => void continueWith("apple")}
              busy={provider === "apple"}
              disabled={provider !== null || loading}
            />
          </View>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

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
            editable={!loading && provider === null}
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <ContinueButton onPress={() => void sendCode()} disabled={!valid} loading={loading} />
        </View>
      </ScrollView>

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
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Code (the website's OtpForm)                                        */
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
      if (!data.session) throw new Error("Verification succeeded but no session was created.");
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={onBack}
        disabled={verifying || verified}
        hitSlop={8}
        style={({ pressed }) => [styles.back, pressed ? styles.backPressed : null]}
      >
        <ArrowLeft size={16} strokeWidth={1.75} color="rgba(0, 0, 0, 0.35)" />
      </Pressable>
      <ScrollView
        contentContainerStyle={styles.centered}
        keyboardShouldPersistTaps="handled"
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
          <Reveal order={0}>
            <Text style={styles.title} accessibilityRole="header">
              Check your email
            </Text>
            <Text style={styles.subtitle}>Enter the {OTP_LENGTH}-digit code we sent to</Text>
            <Text style={styles.email}>{maskEmail(email)}</Text>
          </Reveal>

          <Reveal order={1} style={styles.codeBlock}>
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
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: AUTH_BACKGROUND },
  flex: { flex: 1 },
  // px-8, centered, max-w-[420px]
  centered: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 32, paddingVertical: 24 },
  column: { width: "100%", maxWidth: 420, alignSelf: "center" },
  // font-serif text-[2rem] leading-[1.25] tracking-[0.01em] text-[#1d1b1b]
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 40,
    letterSpacing: 0.32,
    color: colors.ink,
    textAlign: "center",
  },
  // mt-3 text-sm text-[#767676]
  subtitle: {
    marginTop: 12,
    fontFamily: fonts.inter,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    textAlign: "center",
  },
  // mt-1 text-sm text-black/70
  email: {
    marginTop: 4,
    fontFamily: fonts.inter,
    fontSize: 14,
    lineHeight: 20,
    color: "rgba(0, 0, 0, 0.7)",
    textAlign: "center",
  },
  // mt-8 space-y-3
  oauthStack: { marginTop: 32, gap: 12 },
  // BUTTON_TEXT_STYLE: Geist 13px / 20px
  buttonText: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, color: colors.ink },
  // my-6, border-t border-black/10, "or" text-xs text-[#9a9a9a] px-3
  divider: { marginVertical: 24, flexDirection: "row", alignItems: "center" },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.hairline },
  dividerText: { paddingHorizontal: 12, fontFamily: fonts.inter, fontSize: 12, lineHeight: 16, color: colors.placeholder },
  // rounded-lg border border-black/10 px-4 py-3 text-sm
  input: { height: 46, fontFamily: fonts.inter, fontSize: 14 },
  error: { marginTop: 12, fontFamily: fonts.inter, fontSize: 12, lineHeight: 16, color: colors.error, textAlign: "center" },
  // mt-3 h-11 w-full pl-4 pr-3.5, justify-between
  primary: {
    marginTop: 12,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.primary,
    paddingLeft: 16,
    paddingRight: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  primaryPressed: { backgroundColor: "#0f0d0b" },
  primaryLabel: { flexDirection: "row", alignItems: "center", gap: 8 },
  disabled: { opacity: 0.4 },
  // px-6 pb-8 text-center text-xs leading-relaxed text-[#8a8a8a]
  legal: {
    paddingHorizontal: 24,
    paddingBottom: 32,
    fontFamily: fonts.inter,
    fontSize: 12,
    lineHeight: 19.5,
    color: colors.faint,
    textAlign: "center",
  },
  link: { color: "#6f6f6f", textDecorationLine: "underline" },
  // OtpForm's back: h-8 w-8 rounded-lg text-black/35, top-left of the form side
  back: {
    position: "absolute",
    left: 32,
    top: 16,
    zIndex: 2,
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  backPressed: { backgroundColor: "rgba(0, 0, 0, 0.05)" },
  codeBlock: { marginTop: 32 },
  status: { minHeight: 32, marginTop: 12, alignItems: "center" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusText: { fontFamily: fonts.inter, fontSize: 12, lineHeight: 16, color: colors.muted },
  errorCenter: { fontFamily: fonts.inter, fontSize: 12, lineHeight: 16, color: colors.error, textAlign: "center" },
  resend: { alignSelf: "center", marginTop: 12, paddingVertical: 4 },
  resendText: { fontFamily: fonts.inter, fontSize: 12, color: colors.muted, textDecorationLine: "underline" },
  resendWaiting: { color: colors.placeholder, textDecorationLine: "none" },
});
