import type { GaugeDecisionState, GaugeReadout } from "../../../shared/gauge-types";

/**
 * The v2 hero (§1, §5): the recognized structure, the decision frame, and —
 * when something is missing — the one condition that is missing, with its
 * threshold. Three lines, no checks: this is what the drawer and the stock page
 * show. The panel renders the same block above its collapsible evidence.
 *
 * `actionable` never means "act"; its fixed definition rides on the badge as a
 * tooltip, straight from the engine's templates.
 */

export const GAUGE_STATE_COLOR: Record<GaugeDecisionState, string> = {
  actionable: "#16A34A",
  wait: "#CA8A04",
  nothing_here: "#9CA3AF",
  unreadable: "#64748B",
  contradicted_setup: "#DC2626",
};

export const GAUGE_STATE_LABEL: Record<GaugeDecisionState, string> = {
  actionable: "actionable",
  wait: "wait",
  nothing_here: "nothing here",
  unreadable: "unreadable",
  contradicted_setup: "contradicted",
};

/** §6: the fixed definitions, mirrored for the tooltip (the engine owns the wording). */
export const GAUGE_STATE_TOOLTIP: Record<GaugeDecisionState, string> = {
  actionable: "conditions are consistent enough to test a thesis",
  wait: "a structure is present but one condition is still missing",
  nothing_here: "no structure, or the move has already happened",
  unreadable: "the measurement itself is unreliable here",
  contradicted_setup: "the tape is set up against the thesis",
};

export function StateBadge({ state, small, forceTooltip }: { state: GaugeDecisionState; small?: boolean; forceTooltip?: boolean }) {
  return (
    <span className="group relative inline-flex shrink-0">
      <span
        className={`cursor-help rounded-full font-semibold uppercase tracking-[0.08em] text-white ${small ? "px-1.5 py-[1px] text-[9px]" : "px-2 py-[3px] text-[10px]"}`}
        style={{ background: GAUGE_STATE_COLOR[state] }}
        aria-label={GAUGE_STATE_TOOLTIP[state]}
      >
        {GAUGE_STATE_LABEL[state]}
      </span>
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[280px] rounded-md bg-[#1d1b1b] px-2 py-1 text-[10.5px] font-normal normal-case leading-snug tracking-normal text-white shadow-lg ${forceTooltip ? "block" : "hidden group-hover:block"}`}
      >
        {GAUGE_STATE_TOOLTIP[state]}
      </span>
    </span>
  );
}

type Props = {
  readout: GaugeReadout;
  /** Drawer / stock page: tighter type. */
  compact?: boolean;
  forceTooltip?: boolean;
};

export default function GaugeSetupBlock({ readout, compact = false, forceTooltip = false }: Props) {
  const { setup, state, missing } = readout;
  if (!readout.tracked) {
    return <p className={`${compact ? "text-[11.5px]" : "text-[13px]"} text-[#6b7280]`}>{setup.read}</p>;
  }
  const actionLine = missing?.detail ?? readout.state_line;
  return (
    <div>
      {/* Hero — the structure */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h4 className={`font-baskerville leading-none text-[#1d1b1b] ${compact ? "text-[16px]" : "text-[22px]"}`}>{setup.name}</h4>
        <StateBadge state={state} small={compact} forceTooltip={forceTooltip} />
      </div>
      <p className={`mt-1.5 leading-snug text-[#4b5563] ${compact ? "text-[11.5px]" : "text-[13.5px]"}`}>{setup.read}</p>

      {/* Action line — what is missing, or why the state is what it is */}
      {actionLine && (
        <div
          className={`mt-2 rounded-md border-l-2 px-2.5 py-1.5 ${compact ? "text-[11px]" : "text-[12.5px]"}`}
          style={{
            borderColor: GAUGE_STATE_COLOR[state],
            background: state === "contradicted_setup" ? "rgba(220,38,38,0.06)" : "rgba(202,138,4,0.07)",
            color: "#1d1b1b",
          }}
        >
          {missing ? (
            <>
              <span className="font-medium">missing: </span>
              {missing.detail}
            </>
          ) : (
            actionLine
          )}
        </div>
      )}

      {/* Provenance + the readability caveat */}
      {setup.screen.length > 0 && (
        <p className={`mt-1.5 ${compact ? "text-[10px]" : "text-[11px]"} text-[#9CA3AF]`}>
          from screen: {setup.screen.map((f) => `${f.pattern.replace(/_/g, " ")} · ${f.day_count}d`).join(" · ")}
        </p>
      )}
      {readout.readability_note && (
        <p className={`mt-1 ${compact ? "text-[10px]" : "text-[11px]"} leading-snug text-[#9CA3AF]`}>{readout.readability_note}</p>
      )}
    </div>
  );
}
