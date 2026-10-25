import type { ReactNode } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { SKELETON } from "@/components/earnings/earnings-ui";
import { useI18n } from "@/lib/i18n";
import { useExposure } from "@/lib/exposure-store";
import { cn } from "@/lib/utils";
import { exposurePct } from "../../../shared/exposure";
import { CompanyCell, NUM, ViaTickers, headlineText } from "./exposure-ui";

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
  /** View Exposure: opens the home screen's Exposure tab. */
  onOpenExposure?: () => void;
};

/** How many shared dependencies the card lists. */
const ROWS = 3;

function Skeleton() {
  return (
    <div className="space-y-4 pt-1" aria-hidden>
      <div className={cn(SKELETON, "h-3.5 w-[80%]")} />
      {["w-[64%]", "w-[52%]", "w-[58%]"].map((w) => (
        <div key={w} className={cn(SKELETON, "h-3", w)} />
      ))}
    </div>
  );
}

/**
 * Exposure on the dashboard: the tab's one-line reading and its top three
 * shared dependencies, each with the exposed weight and the holdings it sits
 * under. The ticker opens the stock; View Exposure opens the tab, as View
 * Calendar does for the calendar. It shares the tab's answer
 * (lib/exposure-store), so neither asks twice.
 */
export default function ExposureCard({ onDuplicate, onRemove, onOpenExposure }: Props) {
  const { t, locale } = useI18n();
  const view = useExposure();
  const { summary } = view;
  const noNames = view.positions === 0 && view.watched === 0;
  const quiet = "flex flex-1 items-center justify-center px-4 text-center text-[13px] leading-[1.5]";

  let body: ReactNode;
  if (noNames) {
    body = <p className={cn(quiet, "text-content-tertiary")}>{t("exposure.card.noNames")}</p>;
  } else if (!summary && view.error !== null) {
    body = <p className={cn(quiet, "text-content-secondary")}>{view.error === "restart" ? t("exposure.error.restart") : t("exposure.card.failed")}</p>;
  } else if (!summary) {
    body = <Skeleton />;
  } else if (summary.shared.length === 0) {
    body = <p className={cn(quiet, "text-content-tertiary")}>{summary.companies === 0 ? t("exposure.empty.funds") : t("exposure.card.empty")}</p>;
  } else {
    const header = headlineText(t, summary.headline, view.scope, locale);
    body = (
      <>
        {header ? <p className="pb-3 text-[14px] leading-[1.45] text-content-primary">{header}</p> : null}
        <ul className="scrollbar-meridian -mx-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
          {summary.shared.slice(0, ROWS).map((row) => (
            <li key={row.key} className="flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-ink/[0.04]">
              <CompanyCell row={row} compact className="flex-1" />
              <ViaTickers row={row} max={2} className="shrink-0" />
              <span className={cn(NUM, "w-11 shrink-0 text-content-primary")} title={t("exposure.row.linked", { pct: exposurePct(row.linkedWeight, locale) })}>
                {exposurePct(row.exposure, locale)}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label={t("exposure.card.label")}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onOpen={onOpenExposure}
        openLabel={t("exposure.card.view")}
      />
      <div className="flex min-h-0 flex-1 flex-col pt-4">{body}</div>
    </div>
  );
}
