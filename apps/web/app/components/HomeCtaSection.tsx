import Link from "next/link";
import { HOME_CTA } from "@/lib/marketing-copy";

export default function HomeCtaSection() {
  return (
    <section className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-serif text-2xl font-normal text-white sm:text-3xl">{HOME_CTA.title}</h2>
        <p className="mt-4 text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">{HOME_CTA.body}</p>

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
