import type { ReactNode } from "react";
import Navbar from "./Navbar";
import SiteFooter from "./SiteFooter";
import PrintButton from "./legal/PrintButton";
import type { LegalSectionDef } from "./legal/primitives";
import { Fact } from "./legal/primitives";
import { LEGAL_CONFIG, unresolvedPlaceholders } from "@/lib/legal-config";

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";

type Props = {
  title: string;
  /** One or two paragraphs above the contents: what the document covers. */
  intro: ReactNode;
  sections: readonly LegalSectionDef[];
};

/**
 * A legal page in the site's light design: the title and contents in a sticky
 * left column (as on the FAQ), numbered sections with stable anchors on the
 * right. Navigation, footer and contents drop out when printed.
 *
 * While counsel has not signed off, or any placeholder in lib/legal-config is
 * unfilled, a notice at the top says so.
 */
export default function LegalDocument({ title, intro, sections }: Props) {
  const draft = !LEGAL_CONFIG.reviewedByCounsel || unresolvedPlaceholders().length > 0;

  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111] print:bg-white" style={{ fontFamily: GEIST }}>
      <div className="print:hidden">
        <Navbar />
      </div>

      <main className="mx-auto max-w-7xl px-6 pb-32 pt-36 sm:px-10 sm:pt-40 print:max-w-none print:px-0 print:pb-0 print:pt-0">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-16 print:block">
          <aside className="lg:col-span-3 print:hidden">
            <nav aria-label="Contents" className="lg:sticky lg:top-28 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pb-8">
              <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[#a3a39f]">Contents</p>
              <ol className="mt-4 space-y-2.5">
                {sections.map((s, i) => (
                  <li key={s.id} className="flex gap-2 text-[13.5px] leading-5">
                    <span className="w-5 shrink-0 tabular-nums text-[#b5b5b0]">{i + 1}.</span>
                    <a href={`#${s.id}`} className="text-[#6b6b6b] transition-colors hover:text-[#1d1b1b]">
                      {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </aside>

          <article className="min-w-0 lg:col-span-8 lg:col-start-5">
            <header>
              <h1
                style={{ fontFamily: HEADING_FONT, fontWeight: 400, lineHeight: 1.1, color: "rgb(29, 27, 27)" }}
                className="text-[36px] sm:text-[44px] print:text-[24pt]"
              >
                {title}
              </h1>
              <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-1 text-[13px] text-[#8a8a8a] print:text-[9.5pt] print:text-black">
                <div className="flex gap-1.5">
                  <dt>Effective date:</dt>
                  <dd className="text-[#1d1b1b]">
                    <Fact k="effectiveDate" />
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>Last updated:</dt>
                  <dd className="text-[#1d1b1b]">{LEGAL_CONFIG.lastUpdated}</dd>
                </div>
              </dl>
              <div className="mt-3 print:hidden">
                <PrintButton />
              </div>
            </header>

            {draft ? (
              <div
                role="note"
                className="mt-8 rounded-xl border border-[#f0dc8a] bg-[#fffaeb] px-5 py-4 text-[13.5px] leading-relaxed text-[#6b4e00] print:border-black print:bg-white print:text-black"
              >
                <strong className="font-medium">Draft pending legal review.</strong> This document has not yet been
                reviewed by qualified counsel and should not be relied on until it has. Highlighted text marks details
                that still have to be filled in.
              </div>
            ) : null}

            <div className="mt-10 space-y-4">{intro}</div>

            <div className="mt-14 space-y-14 print:mt-8 print:space-y-8">
              {sections.map((s, i) => (
                <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="scroll-mt-28 print:break-inside-auto">
                  <h2
                    id={`${s.id}-title`}
                    style={{ fontFamily: HEADING_FONT, fontWeight: 400, color: "rgb(29, 27, 27)" }}
                    className="text-[22px] leading-8 sm:text-[24px] print:text-[14pt] print:leading-normal"
                  >
                    <span className="mr-2 tabular-nums text-[#b5b5b0] print:text-black">{i + 1}.</span>
                    {s.title}
                  </h2>
                  <div className="mt-5 space-y-4">{s.body}</div>
                </section>
              ))}
            </div>
          </article>
        </div>
      </main>

      <div className="print:hidden">
        <SiteFooter />
      </div>
    </div>
  );
}
