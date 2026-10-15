import { cn } from "@/lib/utils";
import { useSay } from "@/components/earnings/earnings-ui";
import type { ReadthroughRow } from "../../../shared/readthrough-types";
import { relationText, safeSourceUrl, sourceHint } from "../../../shared/readthrough-view";

/**
 * Pieces the Read-through card and the Earnings tab's section share: the
 * link line ("Supplier to NVDA" with the filing behind it) and the held or
 * watched pill.
 */

/** "Supplier to NVDA · 10-K": the relation as the filing puts it, the form opening the filing on SEC.gov. */
export function LinkLine({ row, className }: { row: ReadthroughRow; className?: string }) {
  const { say, lang, t } = useSay();
  const url = safeSourceUrl(row.sourceUrl);
  const form = row.form ?? t("readthrough.source.filing");
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-[11.5px] text-[#9CA3AF]", className)}>
      <span className="truncate">{relationText(row, say)}</span>
      <span aria-hidden>·</span>
      {url ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void window.meridian?.openExternal(url);
          }}
          title={sourceHint(row, say, lang)}
          aria-label={t("readthrough.source.open", { filer: row.namedBy, form })}
          className="app-no-drag shrink-0 underline-offset-2 outline-none hover:text-[#4b5563] hover:underline focus-visible:underline"
        >
          {form}
        </button>
      ) : (
        <span className="shrink-0" title={sourceHint(row, say, lang)}>
          {form}
        </span>
      )}
    </span>
  );
}

/** Held or watched: the pill beside the reader's name. */
export function NamePill({ row }: { row: Pick<ReadthroughRow, "held" | "watchlist"> }) {
  const { t } = useSay();
  const pill = "inline-flex h-[17px] shrink-0 items-center rounded-full px-1.5 text-[10.5px] leading-none";
  if (row.held) return <span className={cn(pill, "bg-black/[0.06] text-[#4b5563]")}>{t("readthrough.mark.held")}</span>;
  if (row.watchlist) return <span className={cn(pill, "bg-black/[0.04] text-[#6b7280]")}>{t("readthrough.mark.watch")}</span>;
  return null;
}

/** Green up, red down, grey flat or missing. */
export function toneOf(v: number | null | undefined): string {
  return v === null || v === undefined ? "text-[#9CA3AF]" : v > 0 ? "text-[#16a34a]" : v < 0 ? "text-[#dc2626]" : "text-[#4b5563]";
}
