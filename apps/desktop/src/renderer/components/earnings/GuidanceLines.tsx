import { patternText, shownPatterns } from "../../../shared/guidance-view";
import { useGuidanceTrack } from "../stock-tab/use-guidance";
import { useSay } from "./earnings-ui";

/**
 * The Earnings drawer's guidance lines: how the company's reported figures
 * have landed against its own guidance (main/guidance), the same pattern
 * lines the Stock tab's guidance section leads with. Nothing while loading,
 * and nothing for a company with under three quarters of guidance on record.
 */
export default function GuidanceLines({ ticker, className }: { ticker: string; className?: string }) {
  const { say, lang, t } = useSay();
  const state = useGuidanceTrack(ticker);
  if (state.status !== "ready" || state.track.patterns.length === 0) return null;
  return (
    <section className={className}>
      <p className="text-[10.5px] font-medium uppercase tracking-[0.04em] text-[#9CA3AF]">{t("guidance.drawer.title")}</p>
      <ul className="mt-1.5 space-y-1">
        {shownPatterns(state.track.patterns).map((p) => (
          <li key={`${p.metric}|${p.basis}`} className="text-[12px] leading-[1.45] text-[#1d1b1b]">
            {patternText(p, lang, say)}
          </li>
        ))}
      </ul>
    </section>
  );
}
