import Link from "next/link";
import Navbar from "./Navbar";
import Footer from "./Footer";
import type { LegalSection } from "@/lib/marketing-copy";

type Props = {
  title: string;
  updated: string;
  sections: readonly LegalSection[];
};

export default function LegalDocument({ title, updated, sections }: Props) {
  return (
    <div className="min-h-screen bg-[#090909] text-white">
      <Navbar />
      <main className="pt-[6.75rem] sm:pt-[7.25rem]">
        <article className="px-5 py-12 sm:px-8 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <header>
              <h1 className="font-serif text-3xl font-normal text-white sm:text-4xl">{title}</h1>
              <p className="mt-3 text-[13px] text-[#505050]">{updated}</p>
            </header>

            <div className="mt-12 space-y-10">
              {sections.map((section) => (
                <section key={section.title}>
                  <h2 className="font-serif text-xl font-normal text-white sm:text-2xl">{section.title}</h2>
                  <div className="mt-4 space-y-4">
                    {section.paragraphs.map((paragraph) => (
                      <p key={paragraph.slice(0, 48)} className="text-[15px] leading-relaxed text-[#707070]">
                        {paragraph.includes("@") ? (
                          <>
                            {paragraph.split(/(\S+@\S+)/).map((part) =>
                              part.includes("@") ? (
                                <Link
                                  key={part}
                                  href={`mailto:${part}`}
                                  className="text-white/70 underline-offset-2 hover:text-white hover:underline"
                                >
                                  {part}
                                </Link>
                              ) : (
                                part
                              ),
                            )}
                          </>
                        ) : (
                          paragraph
                        )}
                      </p>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </article>
      </main>
      <Footer />
    </div>
  );
}
