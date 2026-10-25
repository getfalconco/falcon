import type { GaugeDecisionState, GaugeReadout } from "../../../shared/gauge-types";
import { useT, type MessageKey } from "../../lib/i18n";

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
  actionable: "var(--positive)",
  wait: "var(--yellow)",
  nothing_here: "var(--text-tertiary)",
  unreadable: "var(--text-secondary)",
  contradicted_setup: "var(--negative)",
};

export const GAUGE_STATE_LABEL_KEY: Record<GaugeDecisionState, MessageKey> = {
  actionable: "panels.gauge.state.actionable",
  wait: "panels.gauge.state.wait",
  nothing_here: "panels.gauge.state.nothing_here",
  unreadable: "panels.gauge.state.unreadable",
  contradicted_setup: "panels.gauge.state.contradicted_setup",
};

/**
 * §6: the fixed definitions, mirrored for the tooltip (the engine owns the
 * English wording; panels.ts carries it into each language).
 */
export const GAUGE_STATE_TOOLTIP_KEY: Record<GaugeDecisionState, MessageKey> = {
  actionable: "panels.gauge.stateTip.actionable",
  wait: "panels.gauge.stateTip.wait",
  nothing_here: "panels.gauge.stateTip.nothing_here",
  unreadable: "panels.gauge.stateTip.unreadable",
  contradicted_setup: "panels.gauge.stateTip.contradicted_setup",
};

export function StateBadge({ state, small, forceTooltip }: { state: GaugeDecisionState; small?: boolean; forceTooltip?: boolean }) {
  const t = useT();
  const tooltip = t(GAUGE_STATE_TOOLTIP_KEY[state]);
  return (
    <span className="group relative inline-flex shrink-0">
      <span
        className={`cursor-help rounded-full font-semibold uppercase tracking-[0.08em] text-white ${small ? "px-1.5 py-[1px] text-[9px]" : "px-2 py-[3px] text-[10px]"}`}
        style={{ background: GAUGE_STATE_COLOR[state] }}
        aria-label={tooltip}
      >
        {t(GAUGE_STATE_LABEL_KEY[state])}
      </span>
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[280px] rounded-md bg-ink px-2 py-1 text-[10.5px] font-normal normal-case leading-snug tracking-normal text-white shadow-lg ${forceTooltip ? "block" : "hidden group-hover:block"}`}
      >
        {tooltip}
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
  const t = useT();
  const { setup, state, missing } = readout;
  if (!readout.tracked) {
    return <p className={`${compact ? "text-[11.5px]" : "text-[13px]"} text-content-secondary`}>{setup.read}</p>;
  }
  const actionLine = missing?.detail ?? readout.state_line;
  return (
    <div>
      {/* Hero — the structure */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h4 className={`font-baskerville leading-none text-content-primary ${compact ? "text-[16px]" : "text-[22px]"}`}>{setup.name}</h4>
        <StateBadge state={state} small={compact} forceTooltip={forceTooltip} />
      </div>
      <p className={`mt-1.5 leading-snug text-content-body ${compact ? "text-[11.5px]" : "text-[13.5px]"}`}>{setup.read}</p>

      {/* Action line — what is missing, or why the state is what it is */}
      {actionLine && (
        <div
          className={`mt-2 rounded-md border-l-2 px-2.5 py-1.5 ${compact ? "text-[11px]" : "text-[12.5px]"}`}
          style={{
            borderColor: GAUGE_STATE_COLOR[state],
            background: state === "contradicted_setup" ? "rgba(220,38,38,0.06)" : "rgba(202,138,4,0.07)",
            color: "var(--text-primary)",
          }}
        >
          {missing ? (
            <>
              <span className="font-medium">{t("panels.gauge.missing")}</span>
              {missing.detail}
            </>
          ) : (
            actionLine
          )}
        </div>
      )}

      {/* Provenance + the readability caveat */}
      {setup.screen.length > 0 && (
        <p className={`mt-1.5 ${compact ? "text-[10px]" : "text-[11px]"} text-content-tertiary`}>
          {t("panels.gauge.fromScreen", {
            findings: setup.screen
              .map((f) => t("panels.gauge.screenFinding", { pattern: f.pattern.replace(/_/g, " "), days: f.day_count }))
              .join(" · "),
          })}
        </p>
      )}
      {readout.readability_note && (
        <p className={`mt-1 ${compact ? "text-[10px]" : "text-[11px]"} leading-snug text-content-tertiary`}>{readout.readability_note}</p>
      )}
    </div>
  );
}
