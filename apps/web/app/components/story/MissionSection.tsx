"use client";

import Link from "next/link";
import ScrollReveal from "../ScrollReveal";
import { STORY } from "@/lib/marketing-copy";

function StorySection({
  title,
  paragraphs,
}: {
  title: string;
  paragraphs: readonly string[];
}) {
  return (
    <section className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-3xl">
        <ScrollReveal as="h2" className="font-serif text-2xl font-normal text-white sm:text-3xl">
          {title}
        </ScrollReveal>

        {paragraphs.map((paragraph) => (
          <ScrollReveal
            as="p"
            key={paragraph.slice(0, 40)}
            className="mt-6 text-[15px] leading-relaxed text-[#707070] sm:text-[16px]"
          >
            {paragraph}
          </ScrollReveal>
        ))}
      </div>
    </section>
  );
}

export function FalconRebuildSection() {
  return <StorySection title={STORY.rebuild.title} paragraphs={STORY.rebuild.paragraphs} />;
}

export function DifferentFromAiSection() {
  return <StorySection title={STORY.different.title} paragraphs={STORY.different.paragraphs} />;
}

export function MissionSection() {
  return (
    <section className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-3xl">
        <ScrollReveal as="h2" className="font-serif text-2xl font-normal text-white sm:text-3xl">
          {STORY.mission.title}
        </ScrollReveal>
        <ScrollReveal
          as="p"
          className="mt-6 text-[15px] leading-relaxed text-[#707070] sm:text-[16px]"
        >
          {STORY.mission.body}
        </ScrollReveal>
      </div>
    </section>
  );
}

export function StoryCtaSection() {
  return (
    <section className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-serif text-2xl font-normal text-white sm:text-3xl">{STORY.cta.title}</h2>
        <p className="mt-4 text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">{STORY.cta.body}</p>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/early-access"
            className="inline-block bg-white px-6 py-2.5 text-[13px] text-[#090909] transition hover:bg-white/90"
          >
            Download
          </Link>
          <Link
            href="/login"
            className="inline-block border border-white/15 px-6 py-2.5 text-[13px] text-white transition hover:border-white/25 hover:bg-white/5"
          >
            Join waitlist
          </Link>
        </div>
      </div>
    </section>
  );
}
