"use client";

import ScrollReveal from "./ScrollReveal";
import { INSTITUTIONAL_GAP } from "@/lib/marketing-copy";

export default function InstitutionalGapSection() {
  return (
    <section id="gap" className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <ScrollReveal as="h2" className="text-center font-serif text-2xl font-normal text-white sm:text-3xl">
          {INSTITUTIONAL_GAP.title}
        </ScrollReveal>

        <div className="mt-12 grid gap-8 md:grid-cols-2 md:gap-10">
          <ScrollReveal className="border border-white/[0.08] bg-[#0d0d0d] p-6 sm:p-8" offset={20}>
            <h3 className="text-[13px] font-medium uppercase tracking-[0.08em] text-white/70">
              {INSTITUTIONAL_GAP.deskTitle}
            </h3>
            <ul className="mt-5 space-y-3">
              {INSTITUTIONAL_GAP.deskItems.map((item) => (
                <li key={item} className="flex gap-3 text-[14px] leading-relaxed text-[#707070] sm:text-[15px]">
                  <span className="mt-2 h-1 w-1 shrink-0 bg-white/40" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </ScrollReveal>

          <ScrollReveal
            className="border border-white/[0.08] bg-[#0d0d0d] p-6 sm:p-8"
            offset={20}
            delay={0.08}
          >
            <h3 className="text-[13px] font-medium uppercase tracking-[0.08em] text-white/70">
              {INSTITUTIONAL_GAP.retailTitle}
            </h3>
            <ul className="mt-5 space-y-3">
              {INSTITUTIONAL_GAP.retailItems.map((item) => (
                <li key={item} className="flex gap-3 text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
                  <span className="mt-2 h-1 w-1 shrink-0 bg-white/20" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </ScrollReveal>
        </div>

        <ScrollReveal
          as="p"
          offset={0}
          delay={0.15}
          className="mt-10 text-center font-serif text-xl text-white sm:text-2xl"
        >
          {INSTITUTIONAL_GAP.closing}
        </ScrollReveal>
      </div>
    </section>
  );
}
