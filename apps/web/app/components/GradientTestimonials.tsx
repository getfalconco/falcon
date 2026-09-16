"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue } from "framer-motion";
import { EASE } from "@meridian/ui";
import TestimonialRevealText from "./TestimonialRevealText";
import { MARKETING_TESTIMONIALS, type MarketingTestimonial } from "@/lib/marketing-copy";

type Props = {
  testimonials?: MarketingTestimonial[];
};

const DEFAULT_TESTIMONIALS = MARKETING_TESTIMONIALS;

const REVEAL_MS = 2200;
const HOLD_MS = 2800;
const FADE_MS = 400;

export default function GradientTestimonials({ testimonials = DEFAULT_TESTIMONIALS }: Props) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const progress = useMotionValue(0);

  const testimonial = testimonials[index]!;

  useEffect(() => {
    let cancelled = false;

    async function cycle() {
      while (!cancelled) {
        progress.set(0);
        setVisible(true);

        await animate(progress, 1, {
          duration: REVEAL_MS / 1000,
          ease: EASE,
        });

        if (cancelled) return;
        await sleep(HOLD_MS);
        if (cancelled) return;

        setVisible(false);
        await sleep(FADE_MS);
        if (cancelled) return;

        setIndex((current) => (current + 1) % testimonials.length);
      }
    }

    void cycle();

    return () => {
      cancelled = true;
    };
  }, [progress, testimonials.length]);

  return (
    <div className="pointer-events-none flex h-full flex-col justify-end p-8 pb-10">
      <AnimatePresence mode="wait">
        {visible ? (
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: FADE_MS / 1000, ease: EASE }}
            className="max-w-[min(100%,22rem)] font-sans"
          >
            <TestimonialRevealText
              text={testimonial.text}
              highlight={testimonial.highlight}
              progress={progress}
            />

            <p className="mt-5 text-xs font-light tracking-[0.03em] text-white/30">
              {testimonial.name}
              <span className="mx-1.5 text-white/20">·</span>
              {testimonial.country}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
