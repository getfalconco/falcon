import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Mail } from "lucide-react-native";
import { AuthButton, authMessage } from "@/components/AuthButton";
import { AppleIcon, GoogleIcon } from "@/components/BrandIcons";
import { SheetScreen, type CloseSheet } from "@/components/Sheet";
import { haptics } from "@/lib/haptics";
import { SHEET_DETENTS } from "@/lib/sheets";
import { signInWithApple, signInWithGoogle, type OAuthResult } from "@/lib/oauth";
import { colors, fonts } from "@/theme";

/** The landing's "Sign in" sheet: Apple, Google, or the emailed code. */
export default function SignInSheet() {
  return <SheetScreen detent={SHEET_DETENTS.signIn[0]}>{(close) => <Options close={close} />}</SheetScreen>;
}

function Options({ close }: { close: CloseSheet }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [provider, setProvider] = useState<"apple" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function continueWith(which: "apple" | "google") {
    if (provider) return;
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
      close(() => router.replace("/welcome"));
    } else if (!result.canceled) {
      haptics.error();
      setError(result.message ?? "Sign in failed. Please try again.");
    }
  }

  return (
    <View style={[styles.body, { paddingBottom: Math.max(insets.bottom, 16) }]}>
      <Text style={styles.title} accessibilityRole="header">
        Sign in
      </Text>
      <View style={styles.stack}>
        <AuthButton
          icon={<AppleIcon />}
          label="Continue with Apple"
          onPress={() => void continueWith("apple")}
          busy={provider === "apple"}
          disabled={provider !== null}
        />
        <AuthButton
          icon={<GoogleIcon />}
          label="Continue with Google"
          onPress={() => void continueWith("google")}
          busy={provider === "google"}
          disabled={provider !== null}
        />
        <AuthButton
          icon={<Mail size={18} strokeWidth={1.75} color={colors.ink} />}
          label="Continue with email"
          onPress={() => {
            haptics.tap();
            close(() => router.push("/login"));
          }}
          disabled={provider !== null}
        />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: 24 },
  // The login headline's font (the site's font-serif), smaller for a sheet.
  title: {
    marginTop: 8,
    fontFamily: fonts.display,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: 0.26,
    color: colors.ink,
    textAlign: "center",
  },
  stack: { marginTop: 24, gap: 12 },
  error: { marginTop: 12, fontFamily: fonts.inter, fontSize: 12, lineHeight: 16, color: colors.error, textAlign: "center" },
});
