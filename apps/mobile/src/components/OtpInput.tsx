import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInput as TextInputType,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOutUp,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { FONTS } from "@/theme";

/**
 * The one-time-code field for "Check your email" — a native port of the
 * desktop's OTPInput (apps/desktop/.../be-ui-otp-input.tsx): same props, same
 * `onComplete` contract, and the same look beat for beat — sharp-cornered
 * outline cells with no fill, a hard-blinking caret in the active cell,
 * digits that rise in, the x:[0,-5,5,-3,3,-1,0] shake on a bad code, and the
 * emerald check that draws itself to the right of the cells on success.
 *
 * The component's classes still read white/N from its dark-surface days, but
 * what the desktop actually renders is the `.auth-surface` light remap in
 * apps/desktop/src/renderer/globals.css (text-white → #141414, border-white/40
 * → black/0.35, …). The constants below are those remapped values verbatim —
 * update them from that block, not from the raw Tailwind classes.
 *
 * One hidden TextInput does the typing rather than eight focusable cells: RN
 * has no per-cell focus dance worth fighting, and a single field is what iOS
 * autofills a one-time code into.
 */

export type OtpStatus = "idle" | "error" | "success";

type Props = {
  length?: number;
  value: string;
  onChange: (next: string) => void;
  onComplete?: (code: string) => void;
  status?: OtpStatus;
  disabled?: boolean;
  autoFocus?: boolean;
  hint?: string | null;
  errorMessage?: string | null;
  successMessage?: string | null;
  accessibilityLabel?: string;
};

/**
 * Desktop cells are h-12 w-9 (48×36) with a 6px gap; 36 wide × 8 plus gaps is
 * 330px, a hair over a 375pt screen's 327pt of room, so the width gives up
 * one point.
 */
const CELL_W = 35;
const CELL_H = 48;
const CELL_GAP = 6;
/** Desktop caret: w-px h-6, hard-stepped blink over 1s. */
const CARET_H = 24;
const BLINK_HALF_MS = 500;

/** The auth-surface remap: text-white / bg-white (caret) render as this. */
const DIGIT_INK = "#141414";
/** border-white/10 → black/0.1. */
const EMPTY_BORDER = "rgba(0, 0, 0, 0.10)";
/** border-white/25 → black/0.22. */
const FILLED_BORDER = "rgba(0, 0, 0, 0.22)";
/** border-white/40 → black/0.35. */
const ACTIVE_BORDER = "rgba(0, 0, 0, 0.35)";
/** red-400/60 and emerald-500/60 — the remap leaves both untouched. */
const ERROR_BORDER = "rgba(248, 113, 113, 0.6)";
const ERROR_INK = "#f87171";
const SUCCESS_BORDER = "rgba(16, 185, 129, 0.6)";
const SUCCESS_INK = "#10b981";
const MESSAGE_INK = "#888888";

const CHECK_PATH = "M5 13l4 4L19 7";
/** Length of that path, for the stroke-draw animation. */
const CHECK_PATH_LEN = 22;

const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);

const AnimatedPath = Animated.createAnimatedComponent(Path);

function sanitize(raw: string, length: number) {
  return raw.replace(/\D/g, "").slice(0, length);
}

/** Hard on/off blink, matching the desktop's [1, 1, 0, 0] keyframes. */
function Caret({ atRight }: { atRight: boolean }) {
  const reduce = useReducedMotion();
  const blink = useSharedValue(1);

  useEffect(() => {
    if (reduce) {
      blink.value = 1;
      return;
    }
    blink.value = withRepeat(
      withSequence(
        withTiming(1, { duration: BLINK_HALF_MS, easing: Easing.linear }),
        withTiming(0, { duration: 0 }),
        withTiming(0, { duration: BLINK_HALF_MS, easing: Easing.linear }),
        withTiming(1, { duration: 0 }),
      ),
      -1,
      false,
    );
  }, [blink, reduce]);

  const style = useAnimatedStyle(() => ({ opacity: blink.value }));

  return (
    <Animated.View
      pointerEvents="none"
      // Desktop: centred in an empty cell, right-2.5 beside a typed digit.
      style={[styles.caret, atRight ? styles.caretRight : null, style]}
    />
  );
}

/** The desktop's success check: springs in beside the cells, draws its path. */
function SuccessCheck() {
  const reduce = useReducedMotion();
  const scale = useSharedValue(reduce ? 1 : 0.6);
  const opacity = useSharedValue(reduce ? 1 : 0);
  const drawn = useSharedValue(reduce ? 1 : 0);

  useEffect(() => {
    if (reduce) return;
    // type: "spring", stiffness 500, damping 28 on the desktop.
    scale.value = withSpring(1, { stiffness: 500, damping: 28 });
    opacity.value = withTiming(1, { duration: 150 });
    drawn.value = withDelay(100, withTiming(1, { duration: 350, easing: EASE_OUT }));
  }, [drawn, opacity, reduce, scale]);

  const wrapStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  const pathProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_PATH_LEN * (1 - drawn.value),
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.check, wrapStyle]}>
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
        <AnimatedPath
          d={CHECK_PATH}
          stroke={SUCCESS_INK}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${CHECK_PATH_LEN} ${CHECK_PATH_LEN}`}
          animatedProps={pathProps}
        />
      </Svg>
    </Animated.View>
  );
}

export default function OtpInput({
  length = 8,
  value,
  onChange,
  onComplete,
  status = "idle",
  disabled = false,
  autoFocus = false,
  hint,
  errorMessage,
  successMessage,
  accessibilityLabel = "One-time passcode",
}: Props) {
  const inputRef = useRef<TextInputType>(null);
  const [focused, setFocused] = useState(false);
  const reduce = useReducedMotion();
  const shake = useSharedValue(0);
  // onComplete fires on the transition into a full code, not on every
  // keystroke while it stays full.
  const wasComplete = useRef(value.length === length);

  useEffect(() => {
    if (status !== "error" || reduce) return;
    // Desktop keyframes: x [0, -5, 5, -3, 3, -1, 0] over 0.45s.
    shake.value = withSequence(
      ...[-5, 5, -3, 3, -1, 0].map((x) =>
        withTiming(x, { duration: 75, easing: EASE_OUT }),
      ),
    );
  }, [status, reduce, shake]);

  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  function handleChangeText(raw: string) {
    const next = sanitize(raw, length);
    onChange(next);
    if (next.length === length && !wasComplete.current) onComplete?.(next);
    wasComplete.current = next.length === length;
  }

  const showSuccess = status === "success";
  const activeIndex =
    focused && !disabled && !showSuccess ? Math.min(value.length, length - 1) : -1;
  const message = showSuccess ? successMessage : status === "error" ? errorMessage : hint;

  return (
    <View style={styles.root}>
      <Pressable onPress={() => !disabled && inputRef.current?.focus()}>
        <View style={styles.rowWrap}>
          <Animated.View style={[styles.cells, shakeStyle]}>
            {Array.from({ length }, (_, i) => {
              const char = value[i] ?? "";
              const isActive = i === activeIndex;

              return (
                <View
                  key={i}
                  style={[
                    styles.cell,
                    char ? styles.cellFilled : null,
                    isActive && status === "idle" ? styles.cellActive : null,
                    status === "error" ? styles.cellError : null,
                    showSuccess ? styles.cellSuccess : null,
                    disabled ? styles.cellDisabled : null,
                  ]}
                >
                  {char ? (
                    <Animated.Text
                      // The desktop blurs the digit in; RN has no text blur,
                      // so the rise and fade carry it alone.
                      entering={reduce ? FadeIn : FadeInDown.duration(220)}
                      exiting={reduce ? undefined : FadeOutUp.duration(180)}
                      style={styles.digit}
                    >
                      {char}
                    </Animated.Text>
                  ) : null}
                  {isActive ? <Caret atRight={char !== ""} /> : null}
                </View>
              );
            })}
          </Animated.View>

          {showSuccess ? <SuccessCheck /> : null}
        </View>
      </Pressable>

      {/* The real field: invisible, laid over the cells, holds the keyboard. */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={!disabled}
        autoFocus={autoFocus}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={length}
        caretHidden
        accessibilityLabel={accessibilityLabel}
        style={styles.hiddenInput}
      />

      {message ? (
        <Text
          style={[
            styles.message,
            status === "error" ? styles.messageError : null,
            showSuccess ? styles.messageSuccess : null,
          ]}
        >
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", gap: 8 },
  rowWrap: { flexDirection: "row", alignItems: "center" },
  cells: { flexDirection: "row", gap: CELL_GAP },
  // Desktop cells: square-cornered, 1px border, no fill.
  cell: {
    width: CELL_W,
    height: CELL_H,
    borderWidth: 1,
    borderColor: EMPTY_BORDER,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  cellFilled: { borderColor: FILLED_BORDER },
  cellActive: { borderColor: ACTIVE_BORDER },
  cellError: { borderColor: ERROR_BORDER },
  cellSuccess: { borderColor: SUCCESS_BORDER },
  cellDisabled: { opacity: 0.5 },
  // font-mono text-lg tabular-nums.
  digit: {
    fontFamily: FONTS.mono,
    fontSize: 18,
    lineHeight: 24,
    color: DIGIT_INK,
    fontVariant: ["tabular-nums"],
  },
  caret: {
    position: "absolute",
    width: 1,
    height: CARET_H,
    backgroundColor: DIGIT_INK,
  },
  caretRight: { right: 10, left: undefined },
  // right-7 outside the cells, vertically centred.
  check: {
    position: "absolute",
    right: -28,
    top: "50%",
    marginTop: -10,
  },
  hiddenInput: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: CELL_H,
    opacity: 0,
    color: "transparent",
  },
  // text-sm, centred; emerald-500 / error / #888888.
  message: {
    fontFamily: FONTS.sans,
    fontSize: 14,
    lineHeight: 20,
    color: MESSAGE_INK,
    textAlign: "center",
  },
  messageError: { color: ERROR_INK },
  messageSuccess: { color: SUCCESS_INK },
});
