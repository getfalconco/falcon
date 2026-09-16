import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
} from "react-native";

export type CountingNumberRef = {
  startAnimation: () => void;
};

export type CountingNumberProps = {
  from?: number;
  target: number;
  /** Animation length in ms. */
  duration?: number;
  style?: StyleProp<TextStyle>;
  suffix?: string;
  prefix?: string;
  onStart?: () => void;
  onComplete?: () => void;
  autoStart?: boolean;
};

/**
 * RN port of the web CountingNumber — counts from `from` → `target`.
 * Uses the RN Animated API (JS driver) so the displayed integer can update.
 */
export const CountingNumber = forwardRef<CountingNumberRef, CountingNumberProps>(
  (
    {
      from = 0,
      target,
      duration = 1400,
      style,
      suffix = "",
      prefix = "",
      onStart,
      onComplete,
      autoStart = true,
    },
    ref,
  ) => {
    const [display, setDisplay] = useState(Math.round(from));
    const anim = useRef(new Animated.Value(from)).current;
    const onStartRef = useRef(onStart);
    const onCompleteRef = useRef(onComplete);
    onStartRef.current = onStart;
    onCompleteRef.current = onComplete;

    const startAnimation = useCallback(() => {
      anim.stopAnimation();
      anim.setValue(from);
      setDisplay(Math.round(from));
      onStartRef.current?.();

      const listenerId = anim.addListener(({ value }) => {
        setDisplay(Math.round(value));
      });

      Animated.timing(anim, {
        toValue: target,
        duration,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false,
      }).start(({ finished }) => {
        anim.removeListener(listenerId);
        if (finished) {
          setDisplay(Math.round(target));
          onCompleteRef.current?.();
        }
      });
    }, [anim, from, target, duration]);

    useImperativeHandle(ref, () => ({ startAnimation }), [startAnimation]);

    useEffect(() => {
      if (!autoStart) return;
      startAnimation();
      return () => {
        anim.stopAnimation();
        anim.removeAllListeners();
      };
    }, [autoStart, startAnimation, anim]);

    return (
      <Text style={[styles.base, style]} numberOfLines={1}>
        {prefix}
        {display.toLocaleString()}
        {suffix}
      </Text>
    );
  },
);

CountingNumber.displayName = "CountingNumber";

const styles = StyleSheet.create({
  base: {
    fontVariant: ["tabular-nums"],
  },
});

export default CountingNumber;
