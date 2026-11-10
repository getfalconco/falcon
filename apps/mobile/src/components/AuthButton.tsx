import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, fonts } from "@/theme";

/**
 * The login's "Continue with ..." button (the website's SECONDARY_BUTTON_CLASS,
 * h-11 w-full): hairline border, 8px radius, icon pinned 16px from the left.
 */
export function AuthButton({
  icon,
  label,
  onPress,
  busy = false,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
    >
      <View style={styles.icon}>{busy ? <ActivityIndicator size="small" color={colors.muted} /> : icon}</View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

/** Supabase auth errors in the website login's words. */
export function authMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("security purposes")) {
    return "Too many tries. Wait a minute and try again.";
  }
  if (lower.includes("network") || lower.includes("fetch")) {
    return "We couldn't reach Falcon. Check your connection.";
  }
  if (lower.includes("token") && (lower.includes("expired") || lower.includes("invalid"))) {
    return "Provided verification code is invalid";
  }
  return message || "Something went wrong. Please try again.";
}

const styles = StyleSheet.create({
  button: {
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: "#efefec" },
  icon: { position: "absolute", left: 16, top: 0, bottom: 0, justifyContent: "center" },
  // BUTTON_TEXT_STYLE: Geist 13px / 20px
  label: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, color: colors.ink },
});
