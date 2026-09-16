"use client";

import GradientTestimonials from "./GradientTestimonials";
import { MARKETING_TESTIMONIALS } from "@/lib/marketing-copy";

export default function HomeTestimonialsSection() {
  return (
    <section className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center font-serif text-2xl font-normal text-white sm:text-3xl">
          Built for serious traders
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
          Desk-level conviction, speed, and second-order insight—not generic SaaS praise.
        </p>

        <div className="relative mx-auto mt-10 min-h-[220px] max-w-2xl overflow-hidden border border-white/[0.08] bg-[#0d0d0d]">
          <GradientTestimonials testimonials={MARKETING_TESTIMONIALS} />
        </div>
      </div>
    </section>
  );
}
