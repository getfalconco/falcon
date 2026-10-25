import type { PropagationRun, PropagationTarget } from "../../../shared/propagation-run-types";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { compareTargets, targetKey } from "./ripple-layout";
import {
  ACCENT,
  AMBER,
  AMBER_LINE,
  AMBER_SOFT,
  FAINT,
  MUTED,
  directionColor,
  directionGlyph,
  directionWord,
  fmtAbsPct,
  fmtPct,
  humanize,
  pricingWord,
  roleWord,
  strengthWord,
  tierWord,
  verdictWord,
} from "./ripple-format";

/**
 * List mode (spec §8): the same data as a ranked table — open + strong first.
 * The map impresses; the table works.
 */

type Props = {
  run: PropagationRun;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
};

const COLUMNS: readonly MessageKey[] = [
  "panels.ripple.col.name",
  "panels.ripple.col.relationship",
  "panels.ripple.col.direction",
  "panels.ripple.col.tier",
  "panels.ripple.col.pricing",
  "panels.ripple.col.realized",
  "panels.ripple.col.expected",
  "panels.ripple.col.mechanism",
];

function StatusPill({ t }: { t: PropagationTarget }) {
  const { t: tr } = useI18n();
  const vetoed = t.stage2?.verdict === "vetoed";
  const open = t.tracked && t.pricing.status === "open" && !vetoed;
  const against = t.tracked && t.pricing.status === "contradicted" && !vetoed;
  return (
    <span
      className="inline-block rounded-full px-2 py-[2px] text-[9.5px] font-semibold tracking-[0.08em]"
      style={{
        background: open ? ACCENT : against ? AMBER_SOFT : "transparent",
        color: open ? "#fff" : against ? AMBER : vetoed || !t.tracked ? FAINT : MUTED,
        border: `1px solid ${open ? ACCENT : against ? AMBER_LINE : "var(--border-default)"}`,
        textDecoration: vetoed ? "line-through" : undefined,
      }}
    >
      {pricingWord(t, tr)}
    </span>
  );
}

export default function RippleTable({ run, selectedKey, onSelect }: Props) {
  const { t: tr, tNodes } = useI18n();
  const na = tr("common.na");
  const rows = [...run.targets].sort(compareTargets);
  return (
    <div className="scrollbar-meridian h-full overflow-auto px-6 pb-6">
      <table className="w-max min-w-full border-separate border-spacing-0 text-left">
        <thead className="sticky top-0 z-10 bg-surface-2">
          <tr className="text-[10px] uppercase tracking-[0.12em] text-content-disabled">
            {COLUMNS.map((h) => (
              <th key={h} className="whitespace-nowrap border-b border-edge pb-2 pr-5 font-medium first:pl-1">
                {tr(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const key = targetKey(t);
            const selected = key === selectedKey;
            const vetoed = t.stage2?.verdict === "vetoed";
            return (
              <tr
                key={key}
                onClick={() => onSelect(selected ? null : key)}
                className="cursor-pointer align-top transition-colors hover:bg-white/70"
                style={{ background: selected ? "rgba(255,255,255,0.9)" : undefined, opacity: vetoed ? 0.55 : 1 }}
              >
                <td className="whitespace-nowrap border-b border-edge py-2.5 pl-1 pr-5">
                  <div className="text-[13px] font-medium text-content-primary" style={{ textDecoration: vetoed ? "line-through" : undefined }}>
                    {t.ticker ?? t.label}
                  </div>
                  {t.ticker && t.label !== t.ticker && <div className="max-w-[160px] truncate text-[10.5px] text-content-tertiary">{t.label}</div>}
                </td>
                <td className="whitespace-nowrap border-b border-edge py-2.5 pr-5 text-[11.5px] text-content-secondary">
                  {tNodes("panels.ripple.tierRole", {
                    tier: <span className="text-content-primary">{strengthWord(t.relationship.tier, tr, t.relationship.tier_measured !== false)}</span>,
                    role: roleWord(t.relationship.role, tr),
                  })}
                  {t.relationship.subtype && <div className="max-w-[180px] truncate text-[10.5px] text-content-tertiary">{humanize(t.relationship.subtype)}</div>}
                </td>
                <td className="whitespace-nowrap border-b border-edge py-2.5 pr-5 text-[11.5px]" style={{ color: directionColor(t.transmission.direction) }}>
                  {directionGlyph(t.transmission.direction)} {directionWord(t.transmission.direction, tr)}
                </td>
                <td className="whitespace-nowrap border-b border-edge py-2.5 pr-5 text-[11.5px] text-content-primary">
                  {tierWord(t.transmission.tier, tr)}
                  {t.transmission.transmits === "weak" && <span className="text-content-tertiary"> · {tr("panels.ripple.weakShort")}</span>}
                </td>
                <td className="whitespace-nowrap border-b border-edge py-2.5 pr-5">
                  <StatusPill t={t} />
                </td>
                <td className="whitespace-nowrap border-b border-edge py-2.5 pr-5 font-mono text-[11px] tabular-nums text-content-primary">
                  {t.tracked ? fmtPct(t.pricing.realized_resid_pct, 2, na) : na}
                </td>
                <td className="whitespace-nowrap border-b border-edge py-2.5 pr-5 font-mono text-[11px] tabular-nums text-content-secondary">
                  {t.tracked && t.pricing.expected_pct != null ? `±${fmtAbsPct(t.pricing.expected_pct, 2, na)}` : na}
                </td>
                <td className="min-w-[300px] max-w-[420px] border-b border-edge py-2.5 pr-1 text-[11.5px] leading-relaxed text-content-secondary">
                  {t.mechanism}
                  {t.stage2?.rationale && (
                    <div className="mt-0.5 text-[10.5px] text-content-tertiary">
                      {tr("panels.ripple.verdictLine", { verdict: verdictWord(t.stage2.verdict, tr), rationale: t.stage2.rationale })}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
