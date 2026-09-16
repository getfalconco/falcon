"use client";

import ScrollReveal from "./ScrollReveal";
import { FALCON_STACK } from "@/lib/marketing-copy";

export default function MeridianStackSection() {
  return (
    <section id="stack" className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <ScrollReveal className="text-center">
          <h2 className="font-serif text-2xl font-normal text-white sm:text-3xl">
            {FALCON_STACK.title}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
            {FALCON_STACK.subtitle}
          </p>
        </ScrollReveal>

        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {FALCON_STACK.roles.map((item, i) => (
            <ScrollReveal
              key={item.role}
              offset={20}
              delay={i * 0.06}
              className="border border-white/[0.08] bg-[#0d0d0d] p-6"
            >
              <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-white/50">
                Desk role
              </p>
              <h3 className="mt-2 font-serif text-lg text-white">{item.role}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-[#707070]">{item.equivalent}</p>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
