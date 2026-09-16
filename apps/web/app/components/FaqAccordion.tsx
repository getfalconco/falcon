"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";

const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";
const EASE_SOFT = [0.4, 0, 0.2, 1] as const;

export type FaqItem = { question: string; answer: string };

/**
 * One answer open at a time: opening a question closes whichever was open,
 * and clicking the open one closes it.
 */
export default function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <ul className="border-t border-dashed border-black/[0.14]">
      {items.map((item, i) => {
        const open = openIndex === i;
        return (
          <li
            key={item.question}
            className="border-b border-dashed border-black/[0.14]"
          >
            <button
              type="button"
              onClick={() => setOpenIndex(open ? null : i)}
              aria-expanded={open}
              className="flex w-full items-start justify-between gap-8 py-8 text-left"
            >
              <span
                className="text-[21px] leading-[30px] text-[#1d1b1b]"
                style={{ fontFamily: SERIF, fontWeight: 400 }}
              >
                {item.question}
              </span>
              <ChevronDown
                aria-hidden
                strokeWidth={1.5}
                className={`mt-1.5 h-4 w-4 shrink-0 text-[#9a9a9a] transition-transform duration-300 ${
                  open ? "rotate-180" : ""
                }`}
              />
            </button>

            <AnimatePresence initial={false}>
              {open ? (
                <motion.div
                  key="answer"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.32, ease: EASE_SOFT }}
                  className="overflow-hidden"
                >
                  <p
                    className="max-w-[62ch] pb-8 pr-10 text-[15px] leading-[26px] text-[#6b7280]"
                    style={{ fontFamily: GEIST }}
                  >
                    {item.answer}
                  </p>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </li>
        );
      })}
    </ul>
  );
}
