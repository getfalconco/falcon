import { useState } from "react";
import type { GaugeCheck, GaugeOverall, GaugeReadout, GaugeStatus } from "../../../shared/gauge-types";
import { useI18n, useT, type TFunction } from "../../lib/i18n";
import { plural } from "../../lib/panels-format";

/**
 * The checklist itself (spec §4/§8): binding line on top, then one row per
 * check — status dot, number, label, reason (note underneath). Shared by the
 * Propagation drawer (compact), the stock page (compact) and the Shift+F
 * panel (full, with raw values). Condition language only; the strings come
 * from the engine's templates.
 */

export const GAUGE_STATUS_COLOR: Record<GaugeStatus, string> = {
  pass: "var(--positive)",
  caution: "var(--yellow)",
  fail: "var(--negative)",
  n_a: "var(--text-disabled)",
};

export const GAUGE_OVERALL_COLOR: Record<GaugeOverall, string> = {
  clear: "var(--positive)",
  mixed: "var(--yellow)",
  blocked: "var(--negative)",
};

/** A check's status word (pass / caution / fail / n/a) in the reader's language. */
export function gaugeStatusWord(status: GaugeStatus, t: TFunction): string {
  return status in GAUGE_STATUS_COLOR ? t(`panels.gauge.status.${status}`) : status;
}

/** One line of counts under the checks: "5 of 7 aligned · 1 caution · 1 fail". */
function countsLine(s: GaugeReadout["summary"], t: TFunction): string {
  const parts = [t("panels.gauge.aligned", { aligned: s.aligned, evaluable: s.evaluable })];
  if (s.cautions) parts.push(t("panels.gauge.cautions", { n: s.cautions }));
  if (s.fails) parts.push(t("panels.gauge.fails", { n: s.fails }));
  if (s.unavailable) parts.push(t("panels.gauge.unavailable", { n: s.unavailable }));
  return parts.join(" · ");
}

export function StatusDot({ status, size = 8 }: { status: GaugeStatus; size?: number }) {
  const t = useT();
  const color = GAUGE_STATUS_COLOR[status];
  return (
    <span
      aria-label={gaugeStatusWord(status, t)}
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

export function fmtGaugeValue(
  v: GaugeCheck["values"][string],
  words: { na: string; yes: string; no: string } = { na: "n/a", yes: "yes", no: "no" },
): string {
  if (v == null) return words.na;
  if (typeof v === "boolean") return v ? words.yes : words.no;
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
  const t = useT();
  const color = overall ? GAUGE_OVERALL_COLOR[overall] : "var(--text-disabled)";
  return (
    <span className="group relative inline-flex shrink-0">
      <span
        className={`rounded-full font-semibold uppercase tracking-[0.08em] text-white ${small ? "px-1.5 py-[1px] text-[9px]" : "px-2 py-[2px] text-[10px]"} ${tooltip ? "cursor-help" : ""}`}
        style={{ background: color }}
        aria-label={tooltip ?? undefined}
        lang={overall && !(overall in GAUGE_OVERALL_COLOR) ? "en" : undefined}
      >
        {overall && overall in GAUGE_OVERALL_COLOR ? t(`panels.gauge.overall.${overall}`) : overall ?? t("panels.gauge.noGauge")}
      </span>
      {tooltip && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[260px] rounded-md bg-ink px-2 py-1 text-[10.5px] font-normal normal-case leading-snug tracking-normal text-white shadow-lg ${forceTooltip ? "block" : "hidden group-hover:block"}`}
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
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const s = readout.summary;
  if (!readout.tracked || readout.checks.length === 0) return null;
  return (
    <div className="mt-3 border-t border-edge pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="app-no-drag flex w-full items-center gap-1.5 text-left text-[11px] text-content-secondary transition-colors hover:text-content-primary"
      >
        <span className="text-[9px] leading-none">{open ? "▾" : "▸"}</span>
        {plural(t, locale, "panels.gauge.conditionsChecked", readout.checks.length)}
        <span className="text-content-disabled">· {countsLine(s, t)}</span>
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
  const t = useT();
  const valueWords = { na: t("common.na"), yes: t("panels.gauge.yes"), no: t("panels.gauge.no") };
  const s = readout.summary;
  if (!readout.tracked) {
    return <p className={`${compact ? "text-[11.5px]" : "text-[13px]"} text-content-secondary`}>{s.sentence}</p>;
  }
  if (collapsible) return <GaugeEvidence readout={readout} showValues={showValues} defaultOpen={defaultOpen} />;
  const rowText = compact ? "text-[11px]" : "text-[12px]";
  return (
    <div>
      {/* Binding line */}
      <div className="flex items-start gap-2">
        <OverallBadge overall={s.overall} small={compact} tooltip={s.tooltip} forceTooltip={forceTooltip} />
        <p className={`${compact ? "text-[11.5px]" : "text-[13px]"} leading-snug text-content-primary`}>{s.binding_check ? s.binding_line : s.sentence}</p>
      </div>
      <p className={`mt-1 ${compact ? "text-[10px]" : "text-[11px]"} text-content-tertiary`}>
        {countsLine(s, t)}
        {readout.quant_as_of ? ` · ${t("panels.gauge.quantAsOf", { date: readout.quant_as_of })}` : ""}
      </p>
      {s.calibrating && (
        <div className="mt-2 rounded-md border border-tone-warning-line bg-tone-warning-soft px-2 py-1 text-[10.5px] text-tone-warning">{t("panels.gauge.calibrating")}</div>
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
                <span className="shrink-0 tabular-nums text-content-disabled">{c.number}.</span>
                <span className="shrink-0 font-medium text-content-primary">{c.label}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.06em]" style={{ color: GAUGE_STATUS_COLOR[c.status] }}>
                  {gaugeStatusWord(c.status, t)}
                </span>
              </div>
              <p className={`${rowText} leading-snug text-content-body`}>{c.reason}</p>
              {c.note && <p className={`${compact ? "text-[10px]" : "text-[11px]"} leading-snug text-content-tertiary`}>{c.note}</p>}
              {showValues && Object.keys(c.values).length > 0 && (
                <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-content-tertiary">
                  {Object.entries(c.values)
                    .map(([k, v]) => `${k}=${fmtGaugeValue(v, valueWords)}`)
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
