import type { CSSProperties } from "react";

/**
 * Apple Magic Keyboard (Space Gray) — tuned to match anodized aluminum + dark keycaps.
 */
export const KEYBOARD_SPACE_GRAY = {
  chassisGradient:
    "linear-gradient(165deg, #a3a3a8 0%, #8e8e93 32%, #7c7c80 58%, #636366 100%)",
  chassisShadow:
    "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -1px 0 rgba(0,0,0,0.18), 0 10px 28px rgba(0,0,0,0.42), 0 0 0 1px rgba(0,0,0,0.28)",
  keyGradient:
    "linear-gradient(180deg, #454547 0%, #323234 42%, #232325 72%, #1a1a1c 100%)",
  keyShadow:
    "inset 0 1px 0 rgba(255,255,255,0.14), 0 1.5px 2px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(0,0,0,0.65)",
  keyPressedGradient:
    "linear-gradient(180deg, #353537 0%, #252527 50%, #161618 100%)",
  keyPressedShadow:
    "inset 0 1px 3px rgba(0,0,0,0.45), 0 0 0 0.5px rgba(0,0,0,0.55)",
  keyHighlightShadow:
    "inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 1px rgba(255,255,255,0.72), 0 0 12px rgba(255,255,255,0.18), 0 1.5px 2px rgba(0,0,0,0.45)",
  legend: "rgba(245,245,247,0.9)",
  appleMark: "#d2d2d7",
} as const;

export function getKeycapStyle({
  isPressed,
  isHighlighted,
}: {
  isPressed: boolean;
  isHighlighted: boolean;
}): CSSProperties {
  if (isPressed) {
    return {
      background: KEYBOARD_SPACE_GRAY.keyPressedGradient,
      boxShadow: KEYBOARD_SPACE_GRAY.keyPressedShadow,
      color: KEYBOARD_SPACE_GRAY.legend,
    };
  }

  if (isHighlighted) {
    return {
      background: KEYBOARD_SPACE_GRAY.keyGradient,
      boxShadow: KEYBOARD_SPACE_GRAY.keyHighlightShadow,
      color: KEYBOARD_SPACE_GRAY.legend,
    };
  }

  return {
    background: KEYBOARD_SPACE_GRAY.keyGradient,
    boxShadow: KEYBOARD_SPACE_GRAY.keyShadow,
    color: KEYBOARD_SPACE_GRAY.legend,
  };
}
