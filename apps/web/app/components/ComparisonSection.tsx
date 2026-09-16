"use client";

import ScrollReveal from "./ScrollReveal";
import { COMPARISON } from "@/lib/marketing-copy";

export default function ComparisonSection() {
  return (
    <section id="comparison" className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <ScrollReveal className="text-center">
          <h2 className="font-serif text-2xl font-normal text-white sm:text-3xl">{COMPARISON.title}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
            {COMPARISON.subtitle}
          </p>
        </ScrollReveal>

        <ScrollReveal
          offset={20}
          delay={0.08}
          className="mt-12 overflow-hidden border border-white/[0.08]"
        >
          <div className="grid grid-cols-3 border-b border-white/[0.08] bg-[#0d0d0d] text-[12px] font-medium uppercase tracking-[0.06em] text-white/60 sm:text-[13px]">
            <div className="p-4 sm:p-5" />
            <div className="border-l border-white/[0.08] p-4 sm:p-5">{COMPARISON.genericTitle}</div>
            <div className="border-l border-white/[0.08] p-4 sm:p-5 text-white">{COMPARISON.falconTitle}</div>
          </div>

          {COMPARISON.rows.map((row, i) => (
            <div
              key={row.label}
              className={`grid grid-cols-3 text-[13px] sm:text-[14px] ${
                i < COMPARISON.rows.length - 1 ? "border-b border-white/[0.08]" : ""
              }`}
            >
              <div className="bg-[#090909] p-4 font-medium text-white/70 sm:p-5">{row.label}</div>
              <div className="border-l border-white/[0.08] bg-[#090909] p-4 leading-relaxed text-[#505050] sm:p-5">
                {row.generic}
              </div>
              <div className="border-l border-white/[0.08] bg-[#0d0d0d] p-4 leading-relaxed text-[#909090] sm:p-5">
                {row.falcon}
              </div>
            </div>
          ))}
        </ScrollReveal>
      </div>
    </section>
  );
}
