import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HEAD_CLASS, LABEL_CLASS, QUIET_NOTE_CLASS } from "./briefing-styles";

type Props = {
  label: string;
  /** A short qualifier on the right of the header, e.g. which close the figures count from. */
  aside?: string | null;
  loading?: boolean;
  skeletonRows?: number;
  /** Quiet lines under the body: what is missing and why. Empty entries are skipped. */
  notes?: ReadonlyArray<string | null | undefined>;
  /**
   * What a highlight inside this section is about, for the selection gloss:
   * one line naming the table or list and what its figures are. A row that
   * knows more (which name it is about) says so on its own element.
   */
  glossContext?: string;
  className?: string;
  children?: ReactNode;
};

/** Bar widths for the loading state, uneven so the block reads as text to come and not as a table. */
const SKELETON_WIDTHS = ["w-[92%]", "w-[78%]", "w-[85%]", "w-[64%]", "w-[88%]", "w-[71%]"];

/**
 * The frame every section of the panel shares: a labelled hairline header, the
 * body, and the quiet notes. A section that failed does not get an error box.
 * The report ships whatever it could gather, so a missing part is said in one
 * grey line in the place where the part would have been, and the rest of the
 * panel reads as usual.
 */
export default function BriefingSection({ label, aside, loading = false, skeletonRows = 4, notes = [], glossContext, className, children }: Props) {
  const lines = notes.filter((note): note is string => typeof note === "string" && note !== "");
  return (
    <section className={className} data-gloss-context={glossContext}>
      <div className="flex items-baseline justify-between gap-3 border-b-[0.5px] border-black/[0.06] pb-1.5">
        <h3 className={LABEL_CLASS}>{label}</h3>
        {aside && !loading ? <span className={cn(HEAD_CLASS, "truncate")}>{aside}</span> : null}
      </div>
      {loading ? (
        <div className="mt-3 space-y-2.5" aria-hidden>
          {Array.from({ length: skeletonRows }, (_, i) => (
            <div
              key={i}
              className={cn("h-3 animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none", SKELETON_WIDTHS[i % SKELETON_WIDTHS.length])}
            />
          ))}
        </div>
      ) : (
        <>
          {children}
          {lines.map((line) => (
            <p key={line} className={cn(QUIET_NOTE_CLASS, "mt-2")}>
              {line}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
