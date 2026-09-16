"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { EASE } from "@meridian/ui";

type RevealAs = "div" | "p" | "h2" | "li" | "article";

type ScrollRevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  /** Horizontal slide instead of vertical (e.g. list items). */
  axis?: "y" | "x";
  /** Offset distance in px along the chosen axis. */
  offset?: number;
  as?: RevealAs;
};

const VIEWPORT = { once: true, amount: 0.05 } as const;

export default function ScrollReveal({
  children,
  className,
  delay = 0,
  axis = "y",
  offset = 12,
  as = "div",
}: ScrollRevealProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    const StaticTag = as;
    return <StaticTag className={className}>{children}</StaticTag>;
  }

  const hidden = axis === "x" ? { opacity: 0, x: -offset } : { opacity: 0, y: offset };
  const visible = axis === "x" ? { opacity: 1, x: 0 } : { opacity: 1, y: 0 };
  const transition = { duration: 0.6, ease: EASE, delay };

  switch (as) {
    case "p":
      return (
        <motion.p
          className={className}
          initial={hidden}
          whileInView={visible}
          viewport={VIEWPORT}
          transition={transition}
        >
          {children}
        </motion.p>
      );
    case "h2":
      return (
        <motion.h2
          className={className}
          initial={hidden}
          whileInView={visible}
          viewport={VIEWPORT}
          transition={transition}
        >
          {children}
        </motion.h2>
      );
    case "li":
      return (
        <motion.li
          className={className}
          initial={hidden}
          whileInView={visible}
          viewport={VIEWPORT}
          transition={transition}
        >
          {children}
        </motion.li>
      );
    case "article":
      return (
        <motion.article
          className={className}
          initial={hidden}
          whileInView={visible}
          viewport={VIEWPORT}
          transition={transition}
        >
          {children}
        </motion.article>
      );
    default:
      return (
        <motion.div
          className={className}
          initial={hidden}
          whileInView={visible}
          viewport={VIEWPORT}
          transition={transition}
        >
          {children}
        </motion.div>
      );
  }
}
