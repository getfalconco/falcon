"use client";

import Image from "next/image";
import { motion } from "framer-motion";

// MacBook frame asset. Screen stays empty.
const MACBOOK_SRC = "/macbook_new.png";

export default function MacbookMockup() {
  return (
    <section className="relative px-5 pb-20 pt-8 sm:px-8 sm:pb-28">
      {/* Fades in after the hero text has settled. */}
      <motion.div
        initial={{ opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, ease: [0.21, 0.47, 0.32, 0.98], delay: 3.2 }}
        className="relative mx-auto w-full max-w-4xl"
      >
        <Image
          src={MACBOOK_SRC}
          alt=""
          width={3944}
          height={2564}
          priority
          className="h-auto w-full select-none"
        />
      </motion.div>
    </section>
  );
}
