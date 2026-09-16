import { useState } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { COLORS, FONTS } from "@/theme";

type Props = TextInputProps & { label: string };

/**
 * Labelled input, matching the desktop auth form
 * (apps/desktop/.../LoginForm.tsx `inputClass` / `fieldLabelClass`): a small
 * black label over a bare underline, no box — and the underline darkens while
 * the field has focus, which is the only selected-state the desktop shows.
 */
export default function Field({ label, style, onFocus, onBlur, ...inputProps }: Props) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.root}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={COLORS.muted}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={[styles.input, focused && styles.inputFocused, style]}
        {...inputProps}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  label: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    lineHeight: 16,
    color: COLORS.ink,
  },
  input: {
    fontFamily: FONTS.sans,
    fontSize: 14,
    color: COLORS.ink,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0, 0, 0, 0.15)",
  },
  inputFocused: { borderBottomColor: "rgba(0, 0, 0, 0.40)" },
});
