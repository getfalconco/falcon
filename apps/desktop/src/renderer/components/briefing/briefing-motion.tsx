import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

/** The glass panels' spring (the stock peek and the Insight panel use the same one). */
export const PANEL_TWEEN = { type: "spring", stiffness: 260, damping: 28, mass: 0.9 } as const;

const EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

/**
 * One block of the panel arriving: a short rise, each block a beat after the
 * one above it. With reduced motion asked for, the rise and the stagger both
 * go and only the fade stays, since a fade moves nothing across the screen.
 */
export function Rise({ index, className, children }: { index: number; className?: string; children: ReactNode }) {
  const reduced = useReducedMotion() === true;
  return (
    <motion.div
      className={className}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0.2 } : { delay: 0.1 + index * 0.04, duration: 0.34, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
