"use client";

import ScrollReveal from "../ScrollReveal";
import { STORY } from "@/lib/marketing-copy";

export default function DeskInfrastructure() {
  return (
    <section className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-3xl">
        <ScrollReveal as="h2" className="font-serif text-2xl font-normal text-white sm:text-3xl">
          {STORY.desk.title}
        </ScrollReveal>

        {STORY.desk.paragraphs.map((paragraph) => (
          <ScrollReveal
            as="p"
            key={paragraph.slice(0, 40)}
            className="mt-6 text-[15px] leading-relaxed text-[#707070] sm:text-[16px]"
          >
            {paragraph}
          </ScrollReveal>
        ))}

        <ul className="mt-8 space-y-3 border border-white/[0.08] bg-[#0d0d0d] p-6 sm:p-8">
          {STORY.desk.bullets.map((bullet, i) => (
            <ScrollReveal
              as="li"
              key={bullet}
              axis="x"
              offset={8}
              delay={i * 0.05}
              className="flex gap-3 text-[14px] leading-relaxed text-[#909090] sm:text-[15px]"
            >
              <span className="mt-2 h-1 w-1 shrink-0 bg-white/40" aria-hidden />
              {bullet}
            </ScrollReveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
