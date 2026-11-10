import { forwardRef, useState, type ComponentRef } from "react";
import { StyleSheet, TextInput, type TextInputProps } from "react-native";
import { NO_FOCUS_RING, colors, fonts } from "@/theme";

/** The site's input: 8px radius, hairline border that darkens on focus. */
export const TextField = forwardRef<ComponentRef<typeof TextInput>, TextInputProps>(function TextField({ style, onFocus, onBlur, ...props }, ref) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.placeholder}
      selectionColor={colors.ink}
      cursorColor={colors.ink}
      {...props}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[styles.input, NO_FOCUS_RING, focused ? styles.focused : null, style]}
    />
  );
});

const styles = StyleSheet.create({
  input: {
    height: 50,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingHorizontal: 16,
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: "transparent",
  },
  focused: { borderColor: colors.inputFocus },
});
