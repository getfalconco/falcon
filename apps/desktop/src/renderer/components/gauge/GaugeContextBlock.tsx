import type { GaugeContext, GaugeSurface } from "../../../shared/gauge-types";
import { useGaugeReadout } from "../../hooks/useGaugeReadout";
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
  /** Section heading; "Gauge" by default. */
  title?: string;
  className?: string;
};

export default function GaugeContextBlock({ ticker, context, surface, title = "Gauge", className }: Props) {
  const state = useGaugeReadout(ticker, context, surface, 60_000);
  const r = state.readout;
  return (
    <section className={className ?? "mt-5 rounded-xl border border-[#e6e6e0] bg-[#fbfbf9] px-3.5 py-3"}>
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.14em] text-[#b4b4ae]">{title}</p>
        <span className="text-[10px] text-[#9CA3AF]">
          {context
            ? `against the thesis · expected ${context.expected_direction ?? "unresolved"}`
            : r?.quant_as_of
              ? `as of ${r.quant_as_of}`
              : ""}
        </span>
      </div>
      <div className="mt-2">
        {r ? (
          <GaugeSetupBlock readout={r} compact />
        ) : state.error ? (
          <p className="text-[11px] text-red-700">{state.error}</p>
        ) : (
          <p className="text-[11px] text-[#9CA3AF]">{state.loading ? "reading the tape…" : "no readout"}</p>
        )}
      </div>
    </section>
  );
}
