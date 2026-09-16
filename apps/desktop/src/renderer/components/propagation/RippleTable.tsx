import type { PropagationRun, PropagationTarget } from "../../../shared/propagation-run-types";
import { compareTargets, targetKey } from "./ripple-layout";
import { ACCENT, AMBER, AMBER_LINE, AMBER_SOFT, FAINT, MUTED, ROLE_WORD, directionColor, directionGlyph, fmtAbsPct, fmtPct, humanize, pricingWord } from "./ripple-format";

/**
 * List mode (spec §8): the same data as a ranked table — open + strong first.
 * The map impresses; the table works.
 */

type Props = {
  run: PropagationRun;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
};

function StatusPill({ t }: { t: PropagationTarget }) {
  const vetoed = t.stage2?.verdict === "vetoed";
  const open = t.tracked && t.pricing.status === "open" && !vetoed;
  const against = t.tracked && t.pricing.status === "contradicted" && !vetoed;
  return (
    <span
      className="inline-block rounded-full px-2 py-[2px] text-[9.5px] font-semibold tracking-[0.08em]"
      style={{
        background: open ? ACCENT : against ? AMBER_SOFT : "transparent",
        color: open ? "#fff" : against ? AMBER : vetoed || !t.tracked ? FAINT : MUTED,
        border: `1px solid ${open ? ACCENT : against ? AMBER_LINE : "#e0e0da"}`,
        textDecoration: vetoed ? "line-through" : undefined,
      }}
    >
      {pricingWord(t)}
    </span>
  );
}

export default function RippleTable({ run, selectedKey, onSelect }: Props) {
  const rows = [...run.targets].sort(compareTargets);
  return (
    <div className="scrollbar-meridian h-full overflow-auto px-6 pb-6">
      <table className="w-max min-w-full border-separate border-spacing-0 text-left">
        <thead className="sticky top-0 z-10 bg-[#f7f7f4]">
          <tr className="text-[10px] uppercase tracking-[0.12em] text-[#b4b4ae]">
            {["Target", "Relationship", "Direction", "Tier", "Pricing", "Realized", "Expected", "Mechanism"].map((h) => (
              <th key={h} className="whitespace-nowrap border-b border-[#e6e6e0] pb-2 pr-5 font-medium first:pl-1">
                {h}
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
                <td className="whitespace-nowrap border-b border-[#ebebe5] py-2.5 pl-1 pr-5">
                  <div className="text-[13px] font-medium text-[#1d1b1b]" style={{ textDecoration: vetoed ? "line-through" : undefined }}>
                    {t.ticker ?? t.label}
                  </div>
                  {t.ticker && t.label !== t.ticker && <div className="max-w-[160px] truncate text-[10.5px] text-[#9CA3AF]">{t.label}</div>}
                </td>
                <td className="whitespace-nowrap border-b border-[#ebebe5] py-2.5 pr-5 text-[11.5px] text-[#6b7280]">
                  <span className="text-[#1d1b1b]">{t.relationship.tier}</span> {ROLE_WORD[t.relationship.role]}
                  {t.relationship.subtype && <div className="max-w-[180px] truncate text-[10.5px] text-[#9CA3AF]">{humanize(t.relationship.subtype)}</div>}
                </td>
                <td className="whitespace-nowrap border-b border-[#ebebe5] py-2.5 pr-5 text-[11.5px]" style={{ color: directionColor(t.transmission.direction) }}>
                  {directionGlyph(t.transmission.direction)} {t.transmission.direction}
                </td>
                <td className="whitespace-nowrap border-b border-[#ebebe5] py-2.5 pr-5 text-[11.5px] text-[#1d1b1b]">
                  {t.transmission.tier}
                  {t.transmission.transmits === "weak" && <span className="text-[#9CA3AF]"> · weak</span>}
                </td>
                <td className="whitespace-nowrap border-b border-[#ebebe5] py-2.5 pr-5">
                  <StatusPill t={t} />
                </td>
                <td className="whitespace-nowrap border-b border-[#ebebe5] py-2.5 pr-5 font-mono text-[11px] tabular-nums text-[#1d1b1b]">
                  {t.tracked ? fmtPct(t.pricing.realized_resid_pct) : "—"}
                </td>
                <td className="whitespace-nowrap border-b border-[#ebebe5] py-2.5 pr-5 font-mono text-[11px] tabular-nums text-[#6b7280]">
                  {t.tracked && t.pricing.expected_pct != null ? `±${fmtAbsPct(t.pricing.expected_pct)}` : "—"}
                </td>
                <td className="min-w-[300px] max-w-[420px] border-b border-[#ebebe5] py-2.5 pr-1 text-[11.5px] leading-relaxed text-[#6b7280]">
                  {t.mechanism}
                  {t.stage2?.rationale && <div className="mt-0.5 text-[10.5px] text-[#9CA3AF]">{t.stage2.verdict}: {t.stage2.rationale}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
