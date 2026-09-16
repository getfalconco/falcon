import { useState } from "react";
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
import Field from "@/components/Field";
import PrimaryButton from "@/components/PrimaryButton";
import { applyForEarlyAccess } from "@/lib/waitlist";
import { COLORS, FONTS, SPACING, TYPE } from "@/theme";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Account setup, matching the fields on getfalcon.co's signup step. */
export default function SignupScreen() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    fullName.trim().length > 0 && EMAIL_RE.test(email.trim()) && password.length >= 6;

  async function handleSubmit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await applyForEarlyAccess({ fullName, email, phone, password });
      router.replace({ pathname: "/status", params: { email: email.trim() } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.title}>Set up your Falcon account</Text>
            <Text style={styles.subtitle}>
              Nothing is created yet. Your account is set up when you submit your application.
            </Text>
          </View>

          <View style={styles.fields}>
            <Field
              label="Full name"
              placeholder="Jane Doe"
              autoComplete="name"
              value={fullName}
              onChangeText={setFullName}
            />
            <Field
              label="Email"
              placeholder="jane@example.com"
              autoComplete="email"
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
            />
            <Field
              label="Phone number"
              placeholder="(201) 555-0123"
              autoComplete="tel"
              keyboardType="phone-pad"
              value={phone}
              onChangeText={setPhone}
            />
            <Field
              label="Password"
              placeholder="At least 6 characters"
              autoComplete="new-password"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
            <Text style={styles.hint}>6+ characters</Text>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          <PrimaryButton
            label={busy ? "Submitting…" : "Continue"}
            onPress={handleSubmit}
            disabled={!canSubmit || busy}
          />
          <Pressable
            onPress={() =>
              // Deep links (and router.replace) leave no history — going back
              // would throw "GO_BACK was not handled by any navigator".
              router.canGoBack() ? router.back() : router.replace("/login")
            }
            hitSlop={10}
            style={styles.backLink}
          >
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  scroll: {
    // No justifyContent:"center" here — this form is taller than the screen,
    // and centring an over-tall child makes its top scroll out of reach.
    flexGrow: 1,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.lg,
    gap: SPACING.lg,
  },
  header: { gap: SPACING.sm },
  title: { ...TYPE.title },
  subtitle: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    lineHeight: 19,
    fontStyle: "italic",
    color: COLORS.faint,
  },
  fields: { gap: SPACING.lg },
  hint: { fontFamily: FONTS.sans, fontSize: 12, color: COLORS.faint, marginTop: 6 },
  error: { fontFamily: FONTS.sans, fontSize: 13, color: COLORS.error },
  footer: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
    gap: SPACING.md,
  },
  backLink: { alignItems: "center" },
  backText: {
    fontFamily: FONTS.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    color: COLORS.faint,
  },
});
