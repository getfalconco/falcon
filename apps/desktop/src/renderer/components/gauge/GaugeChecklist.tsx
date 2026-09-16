import { useState } from "react";
import type { GaugeCheck, GaugeOverall, GaugeReadout, GaugeStatus } from "../../../shared/gauge-types";

/**
 * The checklist itself (spec §4/§8): binding line on top, then one row per
 * check — status dot, number, label, reason (note underneath). Shared by the
 * Propagation drawer (compact), the stock page (compact) and the Shift+F
 * panel (full, with raw values). Condition language only; the strings come
 * from the engine's templates.
 */

export const GAUGE_STATUS_COLOR: Record<GaugeStatus, string> = {
  pass: "#16A34A",
  caution: "#CA8A04",
  fail: "#DC2626",
  n_a: "#b4b4ae",
};

export const GAUGE_OVERALL_COLOR: Record<GaugeOverall, string> = {
  clear: "#16A34A",
  mixed: "#CA8A04",
  blocked: "#DC2626",
};

export function StatusDot({ status, size = 8 }: { status: GaugeStatus; size?: number }) {
  const color = GAUGE_STATUS_COLOR[status];
  return (
    <span
      aria-label={status}
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: status === "n_a" ? "transparent" : status === "caution" ? `linear-gradient(90deg, ${color} 50%, transparent 50%)` : color,
        border: `1.5px solid ${color}`,
        boxSizing: "border-box",
      }}
    />
  );
}

export function fmtGaugeValue(v: GaugeCheck["values"][string]): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2);
  }
  return v;
}

/**
 * State badge with the G3 one-sentence tooltip (from the engine's templates).
 * A CSS hover popover rather than a native title so it reads the same on
 * every surface; `forceTooltip` pins it open (preview / screenshots).
 */
export function OverallBadge({ overall, small, tooltip, forceTooltip }: { overall: GaugeOverall | null; small?: boolean; tooltip?: string | null; forceTooltip?: boolean }) {
  const color = overall ? GAUGE_OVERALL_COLOR[overall] : "#b4b4ae";
  return (
    <span className="group relative inline-flex shrink-0">
      <span
        className={`rounded-full font-semibold uppercase tracking-[0.08em] text-white ${small ? "px-1.5 py-[1px] text-[9px]" : "px-2 py-[2px] text-[10px]"} ${tooltip ? "cursor-help" : ""}`}
        style={{ background: color }}
        aria-label={tooltip ?? undefined}
      >
        {overall ?? "no gauge"}
      </span>
      {tooltip && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[260px] rounded-md bg-[#1d1b1b] px-2 py-1 text-[10.5px] font-normal normal-case leading-snug tracking-normal text-white shadow-lg ${forceTooltip ? "block" : "hidden group-hover:block"}`}
        >
          {tooltip}
        </span>
      )}
    </span>
  );
}

type Props = {
  readout: GaugeReadout;
  /** Drawer / stock page: tighter rows, no raw values. */
  compact?: boolean;
  /** Panel: raw values under each row. */
  showValues?: boolean;
  /** Pin the state tooltip open (preview / screenshots). */
  forceTooltip?: boolean;
  /** v2 §5: fold the evidence behind a "N conditions checked" toggle, closed by default. */
  collapsible?: boolean;
  /** Start the collapsible open (preview / screenshots). */
  defaultOpen?: boolean;
};

/**
 * v2 §5: the checks are evidence now, not the hero — folded away by default so
 * the setup line is what the reader meets first. Everything inside is v1,
 * unchanged, raw values included.
 */
export function GaugeEvidence({ readout, showValues = false, defaultOpen = false }: { readout: GaugeReadout; showValues?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const s = readout.summary;
  if (!readout.tracked || readout.checks.length === 0) return null;
  return (
    <div className="mt-3 border-t border-[#ebebe5] pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="app-no-drag flex w-full items-center gap-1.5 text-left text-[11px] text-[#6b7280] transition-colors hover:text-[#1d1b1b]"
      >
        <span className="text-[9px] leading-none">{open ? "▾" : "▸"}</span>
        {readout.checks.length} conditions checked
        <span className="text-[#b4b4ae]">
          · {s.aligned} of {s.evaluable} aligned
          {s.cautions ? ` · ${s.cautions} caution` : ""}
          {s.fails ? ` · ${s.fails} fail` : ""}
          {s.unavailable ? ` · ${s.unavailable} unavailable` : ""}
        </span>
      </button>
      {open && (
        <div className="mt-2">
          <GaugeChecklist readout={readout} showValues={showValues} />
        </div>
      )}
    </div>
  );
}

export default function GaugeChecklist({ readout, compact = false, showValues = false, forceTooltip = false, collapsible = false, defaultOpen = false }: Props) {
  const s = readout.summary;
  if (!readout.tracked) {
    return <p className={`${compact ? "text-[11.5px]" : "text-[13px]"} text-[#6b7280]`}>{s.sentence}</p>;
  }
  if (collapsible) return <GaugeEvidence readout={readout} showValues={showValues} defaultOpen={defaultOpen} />;
  const rowText = compact ? "text-[11px]" : "text-[12px]";
  return (
    <div>
      {/* Binding line */}
      <div className="flex items-start gap-2">
        <OverallBadge overall={s.overall} small={compact} tooltip={s.tooltip} forceTooltip={forceTooltip} />
        <p className={`${compact ? "text-[11.5px]" : "text-[13px]"} leading-snug text-[#1d1b1b]`}>{s.binding_check ? s.binding_line : s.sentence}</p>
      </div>
      <p className={`mt-1 ${compact ? "text-[10px]" : "text-[11px]"} text-[#9CA3AF]`}>
        {s.aligned} of {s.evaluable} aligned
        {s.cautions ? ` · ${s.cautions} caution` : ""}
        {s.fails ? ` · ${s.fails} fail` : ""}
        {s.unavailable ? ` · ${s.unavailable} unavailable` : ""}
        {readout.quant_as_of ? ` · quant as of ${readout.quant_as_of}` : ""}
      </p>
      {s.calibrating && (
        <div className="mt-2 rounded-md border border-[#e7d9a8] bg-[#fbf6e3] px-2 py-1 text-[10.5px] text-[#8a6d1d]">calibrating — limited history</div>
      )}

      {/* Rows */}
      <ul className={`${compact ? "mt-2 space-y-[5px]" : "mt-3 space-y-2"}`}>
        {readout.checks.map((c) => (
          <li key={c.key} className="flex items-start gap-2">
            <span className={`${compact ? "mt-[4px]" : "mt-[5px]"}`}>
              <StatusDot status={c.status} size={compact ? 7 : 9} />
            </span>
            <div className="min-w-0 flex-1">
              <div className={`flex items-baseline gap-1.5 ${rowText}`}>
                <span className="shrink-0 tabular-nums text-[#b4b4ae]">{c.number}.</span>
                <span className="shrink-0 font-medium text-[#1d1b1b]">{c.label}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.06em]" style={{ color: GAUGE_STATUS_COLOR[c.status] }}>
                  {c.status === "n_a" ? "n/a" : c.status}
                </span>
              </div>
              <p className={`${rowText} leading-snug text-[#4b5563]`}>{c.reason}</p>
              {c.note && <p className={`${compact ? "text-[10px]" : "text-[11px]"} leading-snug text-[#9CA3AF]`}>{c.note}</p>}
              {showValues && Object.keys(c.values).length > 0 && (
                <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-[#9CA3AF]">
                  {Object.entries(c.values)
                    .map(([k, v]) => `${k}=${fmtGaugeValue(v)}`)
                    .join("  ")}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
