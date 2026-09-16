"use client";

import { motion } from "framer-motion";
import { EASE } from "@meridian/ui";
import { STORY } from "@/lib/marketing-copy";

export default function StoryHero() {
  return (
    <section className="flex flex-col items-center px-5 pb-16 pt-8 text-center sm:px-8 sm:pb-20">
      <motion.h1
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE }}
        className="max-w-4xl font-serif text-[2.5rem] font-normal leading-[1.1] tracking-[0.01em] text-white sm:text-[3.5rem] md:text-[4rem]"
      >
        {STORY.hero.title}
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE, delay: 0.08 }}
        className="mt-6 max-w-2xl text-[15px] leading-relaxed text-[#707070] sm:text-[16px]"
      >
        {STORY.hero.subtitle}
      </motion.p>
    </section>
  );
}
