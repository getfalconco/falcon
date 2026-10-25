import type { GaugeContext, GaugeSurface } from "../../../shared/gauge-types";
import { useGaugeReadout } from "../../hooks/useGaugeReadout";
import { useT } from "../../lib/i18n";
import GaugeSetupBlock from "./GaugeSetupBlock";

/**
 * A compact Gauge block for a product surface: the Propagation drawer (context
 * mode, under an OPEN target's pricing math) and the stock page (standalone).
 * v2 §5: three lines only — setup, state, missing. The checks live in the
 * Shift+F panel; a product surface does not need the arithmetic.
 */

/** Classifier/Propagation event direction → thesis direction (mixed/unclear → unresolved). */
export function gaugeDirectionFromEvent(direction: string | null | undefined): GaugeContext["expected_direction"] {
  if (direction === "positive" || direction === "up") return "up";
  if (direction === "negative" || direction === "down") return "down";
  return null;
}

type Props = {
  ticker: string;
  context: GaugeContext | null;
  surface: GaugeSurface;
  /** Section heading; the panel's name ("Gauge") by default. */
  title?: string;
  className?: string;
};

export default function GaugeContextBlock({ ticker, context, surface, title, className }: Props) {
  const t = useT();
  const state = useGaugeReadout(ticker, context, surface, 60_000);
  const r = state.readout;
  return (
    <section className={className ?? "mt-5 rounded-xl border border-edge bg-surface-2 px-3.5 py-3"}>
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.14em] text-content-disabled">{title ?? t("panels.gauge.title")}</p>
        <span className="text-[10px] text-content-tertiary">
          {context
            ? t("panels.gauge.againstThesis", { direction: t(`panels.gauge.direction.${context.expected_direction ?? "unresolved"}`) })
            : r?.quant_as_of
              ? t("panels.gauge.asOf", { date: r.quant_as_of })
              : ""}
        </span>
      </div>
      <div className="mt-2">
        {r ? (
          <GaugeSetupBlock readout={r} compact />
        ) : state.error ? (
          <p className="text-[11px] text-red-700">{state.error}</p>
        ) : (
          <p className="text-[11px] text-content-tertiary">{state.loading ? t("panels.gauge.reading") : t("panels.gauge.noReadout")}</p>
        )}
      </div>
    </section>
  );
}
