import { forwardRef, useImperativeHandle, useRef, useState, type ComponentRef } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { NO_FOCUS_RING, colors, fonts } from "@/theme";

export type OtpInputHandle = { focus: () => void; blur: () => void };

/**
 * One digit box per character over a single invisible field: typing moves to
 * the next box on its own, a pasted or autofilled code (iOS offers the code
 * from Mail above the keyboard) fills every box at once, backspace steps back.
 */
export const OtpInput = forwardRef<
  OtpInputHandle,
  {
    length: number;
    value: string;
    onChange: (value: string) => void;
    onComplete: (code: string) => void;
    disabled?: boolean;
    error?: boolean;
    autoFocus?: boolean;
  }
>(function OtpInput({ length, value, onChange, onComplete, disabled = false, error = false, autoFocus = false }, ref) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(false);

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    blur: () => input.current?.blur(),
  }));

  function handleChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, length);
    onChange(digits);
    if (digits.length === length) onComplete(digits);
  }

  const active = Math.min(value.length, length - 1);

  return (
    <Pressable
      onPress={() => input.current?.focus()}
      disabled={disabled}
      accessible={false}
      style={styles.wrap}
    >
      <View style={styles.row} pointerEvents="none">
        {Array.from({ length }, (_, i) => {
          const char = value[i] ?? "";
          const isActive = focused && !disabled && i === active;
          return (
            <View
              key={i}
              style={[
                styles.box,
                char ? styles.boxFilled : null,
                isActive ? styles.boxActive : null,
                error ? styles.boxError : null,
              ]}
            >
              <Text style={styles.digit}>{char}</Text>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={input}
        value={value}
        onChangeText={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={!disabled}
        autoFocus={autoFocus}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="oneTimeCode"
        autoComplete={Platform.OS === "android" ? "sms-otp" : "one-time-code"}
        maxLength={length}
        caretHidden
        accessibilityLabel={`${length}-digit verification code`}
        selectionColor="transparent"
        style={[styles.hiddenInput, NO_FOCUS_RING]}
      />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  wrap: { position: "relative", alignSelf: "stretch" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 6 },
  box: {
    flex: 1,
    maxWidth: 46,
    height: 52,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  boxFilled: { borderColor: "rgba(0, 0, 0, 0.22)" },
  boxActive: { borderColor: colors.ink },
  boxError: { borderColor: colors.error },
  digit: { fontFamily: fonts.mono, fontSize: 20, color: colors.ink },
  hiddenInput: {
    ...StyleSheet.absoluteFill,
    opacity: 0,
    color: "transparent",
    fontSize: 1,
  },
});
