"use client";

import { GitBranch, Radar, Network } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import ScrollReveal from "./ScrollReveal";
import { HOW_IT_WORKS } from "@/lib/marketing-copy";

const CARD_ICONS: LucideIcon[] = [Network, GitBranch, Radar];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <ScrollReveal className="text-center">
          <h2 className="font-serif text-2xl font-normal text-white sm:text-3xl">{HOW_IT_WORKS.title}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
            {HOW_IT_WORKS.subtitle}
          </p>
        </ScrollReveal>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
          {HOW_IT_WORKS.cards.map((card, i) => {
            const Icon = CARD_ICONS[i]!;
            return (
              <ScrollReveal
                key={card.title}
                offset={20}
                delay={i * 0.08}
                className="flex flex-col border border-white/[0.08] bg-[#0d0d0d] p-6"
              >
                <div className="flex aspect-[5/2] items-center justify-center border border-white/[0.06] bg-[#111111]">
                  <Icon className="h-8 w-8 text-white/40" strokeWidth={1.25} aria-hidden />
                </div>

                <h3 className="mt-5 font-serif text-lg text-white">{card.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-[#707070]">{card.caption}</p>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
