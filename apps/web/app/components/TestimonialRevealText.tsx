"use client";

import { motion, useTransform, type MotionValue } from "framer-motion";
import { cn } from "@/lib/utils";

type Props = {
  text: string;
  highlight: string;
  progress: MotionValue<number>;
  className?: string;
};

/** Diagonal top-left gradient wipe with soft blur during reveal. */
export default function TestimonialRevealText({
  text,
  highlight,
  progress,
  className,
}: Props) {
  const maskImage = useTransform(progress, (p) => {
    const edge = p * 135 - 18;
    const fadeEnd = edge + 28;
    return `linear-gradient(135deg, #000 ${edge}%, transparent ${fadeEnd}%)`;
  });

  const filter = useTransform(progress, (p) => {
    const t = Math.min(1, p * 3.2);
    const blurPx = 10 * (1 - t) ** 2;
    return `blur(${blurPx.toFixed(2)}px)`;
  });

  const highlightStart = text.indexOf(highlight);
  const hasHighlight = highlightStart >= 0;
  const before = hasHighlight ? text.slice(0, highlightStart) : text;
  const after = hasHighlight ? text.slice(highlightStart + highlight.length) : "";

  return (
    <motion.p
      className={cn(
        "m-0 font-sans text-balance text-base font-light leading-relaxed tracking-[0.02em] text-white/40",
        className,
      )}
      style={{
        WebkitMaskImage: maskImage,
        maskImage,
        filter,
      }}
    >
      {hasHighlight ? (
        <>
          {before}
          <span className="text-white/65">{highlight}</span>
          {after}
        </>
      ) : (
        text
      )}
    </motion.p>
  );
}
