import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { AbsorptionPoint, PropagationRun, PropagationTarget } from "../../../shared/propagation-run-types";
import type { GaugeContext } from "../../../shared/gauge-types";
import GaugeContextBlock, { gaugeDirectionFromEvent } from "../gauge/GaugeContextBlock";
import {
  ACCENT,
  AMBER,
  AMBER_LINE,
  AMBER_SOFT,
  FAINT,
  GAIN,
  LOSS,
  MUTED,
  ROLE_WORD,
  directionColor,
  directionGlyph,
  directionWord,
  fmtAbsPct,
  fmtDay,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtWhen,
  humanize,
  pricingWord,
} from "./ripple-format";

/**
 * Right drawer (spec §8): the relationship, the filing evidence quote with
 * its source link — the trust moment, typographically first-class — the
 * mechanism line, the pricing math, and the stage-2 verdict when present.
 */

type Props = {
  run: PropagationRun;
  target: PropagationTarget;
  onClose: () => void;
};

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-[11px] text-[#9CA3AF]">{label}</span>
      <span className="font-mono text-[11px] tabular-nums" style={{ color: tone ?? "#1d1b1b" }}>
        {value}
      </span>
    </div>
  );
}

function Badge({ word, open, vetoed, against }: { word: string; open: boolean; vetoed: boolean; against?: boolean }) {
  return (
    <span
      className="rounded-full px-2 py-[2px] text-[10px] font-semibold tracking-[0.08em]"
      style={{
        background: open ? ACCENT : against ? AMBER_SOFT : "transparent",
        color: open ? "#fff" : against ? AMBER : vetoed ? FAINT : MUTED,
        border: `1px solid ${open ? ACCENT : against ? AMBER_LINE : "#e0e0da"}`,
        textDecoration: vetoed ? "line-through" : undefined,
      }}
    >
      {word}
    </span>
  );
}

export default function TargetDrawer({ run, target: t, onClose }: Props) {
  // How the reaction arrived, session by session. Live from the Tracker's
  // bars: the curve grows with every close, so it is fetched, never stored.
  const [curve, setCurve] = useState<AbsorptionPoint[]>([]);
  const key = `${t.target}|${t.relationship.role}`;
  useEffect(() => {
    let cancelled = false;
    setCurve([]);
    if (!t.tracked) return;
    void window.meridian
      ?.getPropagationAbsorption?.(run.run_id, key)
      .then((res) => {
        if (!cancelled && res?.ok) setCurve(res.curve);
      })
      .catch(() => {
        /* the pricing block still stands on its own */
      });
    return () => {
      cancelled = true;
    };
  }, [run.run_id, key, t.tracked]);

  const r = t.relationship;
  const p = t.pricing;
  const vetoed = t.stage2?.verdict === "vetoed";
  const open = t.tracked && p.status === "open" && !vetoed;
  const against = t.tracked && p.status === "contradicted" && !vetoed;
  const dirColor = directionColor(t.transmission.direction);
  const filer = r.evidence_via === "reverse" ? t.ticker ?? t.label : run.root_ticker;

  // Gauge (spec §8): context mode for an OPEN target — the thesis is the
  // target's resolved direction at the run's event instant; pricing supplies
  // the sessions since the reference close and the status.
  const gaugeContext: GaugeContext | null = open && t.ticker
    ? {
        expected_direction: gaugeDirectionFromEvent(t.stage2?.direction ?? t.transmission.direction),
        event_ts: run.event.event_ts,
        source: "propagation_target",
        pricing_status: p.status,
        sessions_since_event: p.sessions_elapsed,
        thesis_is_scheduled_event: false,
      }
    : null;

  const openSource = (url: string) => {
    if (/^https?:\/\//i.test(url)) void window.meridian?.openExternal(url);
  };

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col overflow-hidden border-l border-[#e6e6e0] bg-white/70 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-baskerville text-[22px] leading-none text-[#1d1b1b]">{t.ticker ?? t.label}</h3>
            <Badge word={pricingWord(t)} open={open} vetoed={vetoed} against={against} />
          </div>
          {t.ticker && t.label !== t.ticker && <p className="mt-1 truncate text-[11px] text-[#9CA3AF]">{t.label}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="app-no-drag -mr-1 rounded-md p-1 text-[#9CA3AF] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
          aria-label="Close target"
        >
          <X className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
        {/* Relationship */}
        <section>
          <p className="text-[10px] uppercase tracking-[0.14em] text-[#b4b4ae]">Relationship</p>
          <p className="mt-1.5 text-[13px] leading-snug text-[#1d1b1b]">
            <span className="font-medium">{r.tier}</span> {ROLE_WORD[r.role]} of {run.root_ticker}
            {r.subtype ? <span className="text-[#6b7280]"> · {humanize(r.subtype)}</span> : null}
          </p>
          <p className="mt-0.5 text-[11px] text-[#9CA3AF]">
            confidence {Math.round(r.confidence * 100)}% · asserted in {r.via === "both" ? "both filings" : `${filer}'s filing`}
            {r.filing_date ? ` · ${fmtDay(r.filing_date)}` : ""}
          </p>
          {/* A name can hold two roles toward the root at once. The engine
              keeps the strongest and folds the rest in (§4a); say which, and
              say plainly when they disagree — that is why no direction is
              called and the pricing check compares magnitude only. */}
          {(t.transmission.also_roles?.length ?? 0) > 0 && (
            <p
              className="mt-1 text-[11px] leading-snug"
              style={{ color: t.transmission.role_conflict ? AMBER : "#9CA3AF" }}
            >
              also {t.transmission.also_roles!.map((role) => ROLE_WORD[role]).join(" and ")} of{" "}
              {run.root_ticker}
              {t.transmission.role_conflict
                ? " — the two roles point opposite ways, so no direction is called and the move is judged on size alone."
                : "."}
            </p>
          )}
        </section>

        {/* Evidence — the trust moment */}
        <section className="mt-5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[#b4b4ae]">From the filing</p>
          <blockquote className="mt-2 border-l-2 pl-3" style={{ borderColor: open ? ACCENT : "#1d1b1b" }}>
            <p className="font-baskerville text-[14px] leading-[1.6] text-[#1d1b1b]">“{r.evidence_quote}”</p>
          </blockquote>
          <div className="mt-2 flex items-center gap-3">
            {r.source_url ? (
              <button
                type="button"
                onClick={() => openSource(r.source_url)}
                className="app-no-drag inline-flex items-center gap-1 text-[11px] text-[#1d1b1b] underline decoration-[#cfcfc8] underline-offset-[3px] transition-colors hover:decoration-[#1d1b1b]"
              >
                {filer} filing
                <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
              </button>
            ) : (
              <span className="text-[11px] text-[#b4b4ae]">source unavailable</span>
            )}
            {r.merged_evidence.length > 0 && <span className="text-[11px] text-[#b4b4ae]">+{r.merged_evidence.length} more edge{r.merged_evidence.length === 1 ? "" : "s"}</span>}
          </div>
          {r.merged_evidence.slice(0, 2).map((m) => (
            <p key={m.edge_id} className="mt-2 text-[11.5px] leading-relaxed text-[#6b7280]">
              “{m.quote}”
            </p>
          ))}
        </section>

        {/* Mechanism */}
        <section className="mt-5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[#b4b4ae]">Mechanism</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[#1d1b1b]">{t.mechanism}</p>
          <p className="mt-1.5 text-[11px]" style={{ color: dirColor }}>
            {directionGlyph(t.transmission.direction)} {directionWord(t.transmission.direction)} · {t.transmission.tier}
            {t.transmission.transmits === "weak" ? " · weak transmission" : ""}
            <span className="text-[#b4b4ae]"> · {t.transmission.matrix_cell}</span>
          </p>
        </section>

        {/* Pricing math */}
        <section className="mt-5 rounded-xl border border-[#e6e6e0] bg-[#fbfbf9] px-3.5 py-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#b4b4ae]">Pricing check</p>
            <span className="text-[10px] text-[#9CA3AF]">{t.tracked ? p.basis === "residual" ? "beta-adjusted residual" : p.basis === "raw" ? "raw move" : "—" : "not tracked"}</span>
          </div>
          {t.tracked ? (
            <div className="mt-1.5">
              <Row label="Reference close" value={`${fmtMoney(p.reference_close)} · ${fmtWhen(p.reference_close_ts)}`} />
              <Row label="Last price" value={`${fmtMoney(p.last_price)} · ${fmtWhen(p.last_price_ts)}`} />
              <Row label="Raw move" value={fmtPct(p.realized_raw_pct)} tone={(p.realized_raw_pct ?? 0) > 0 ? GAIN : (p.realized_raw_pct ?? 0) < 0 ? LOSS : undefined} />
              {p.basis === "residual" && <Row label={`Benchmark × β ${fmtNum(p.beta)}`} value={fmtPct(p.bench_move_pct)} />}
              <Row label="Realized residual" value={fmtPct(p.realized_resid_pct)} tone={(p.realized_resid_pct ?? 0) > 0 ? GAIN : (p.realized_resid_pct ?? 0) < 0 ? LOSS : undefined} />
              <Row label="Expected scale" value={p.expected_pct == null ? "—" : `±${fmtAbsPct(p.expected_pct)}`} />
              <Row label="Ratio" value={p.ratio == null ? "—" : `${fmtNum(p.ratio)}×`} />
              <Row label="Sessions since" value={p.sessions_elapsed == null ? "—" : String(p.sessions_elapsed)} />
              <div className="mt-1.5 flex items-center justify-between border-t border-[#ebebe5] pt-2">
                <span className="text-[11px] text-[#6b7280]">Status</span>
                <Badge word={pricingWord(t)} open={open} vetoed={vetoed} against={against} />
              </div>
              {against && (
                <p className="mt-2 rounded-md px-2 py-1.5 text-[11px] leading-relaxed" style={{ background: AMBER_SOFT, color: AMBER }}>
                  Moved against the expected direction — {directionWord(t.transmission.direction)} was expected, the residual is{" "}
                  {fmtPct(p.realized_resid_pct)} ({p.ratio == null ? "—" : `${fmtNum(p.ratio)}× the expected ${fmtAbsPct(p.expected_pct)}`}).
                </p>
              )}
              {p.note && <p className="mt-2 text-[10.5px] leading-relaxed text-[#9CA3AF]">{p.note}</p>}
            </div>
          ) : (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#6b7280]">
              {t.ticker ? `${t.ticker} is not in the Tracker universe — the mechanism and evidence stand; the tape is unknown.` : "Name-only counterparty — no ticker to price."}
            </p>
          )}
        </section>

        {/* Gauge — pre-flight checklist against the thesis (open targets only) */}
        {gaugeContext && t.ticker && <GaugeContextBlock ticker={t.ticker} context={gaugeContext} surface="drawer" />}

        {/* Absorption — when the move actually arrived */}
        {curve.length > 0 && (
          <section className="mt-5">
            <div className="flex items-baseline justify-between">
              <p className="text-[10px] uppercase tracking-[0.14em] text-[#b4b4ae]">How it arrived</p>
              <span className="text-[10px] text-[#9CA3AF]">cumulative residual · × the called move</span>
            </div>
            <div className="mt-2 space-y-[3px]">
              {curve.map((p) => {
                const m = p.multiple;
                // One bar per session, scaled against the largest so far, so
                // the shape of the arrival is readable at a glance.
                const peak = Math.max(...curve.map((x) => Math.abs(x.multiple ?? 0)), 1);
                const width = m == null ? 0 : Math.min(100, (Math.abs(m) / peak) * 100);
                const against = (m ?? 0) < 0;
                return (
                  <div key={p.date} className="flex items-center gap-2">
                    <span className="w-[46px] shrink-0 text-[10px] text-[#9CA3AF]">
                      {p.session === 0 ? "day 0" : `day ${p.session}`}
                    </span>
                    <span className="w-[54px] shrink-0 font-mono text-[10.5px] tabular-nums" style={{ color: p.residual_pct >= 0 ? GAIN : LOSS }}>
                      {fmtPct(p.residual_pct)}
                    </span>
                    <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[#f1f1ec]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${width}%`, background: against ? AMBER : open ? ACCENT : "#c9c9c2" }}
                      />
                    </div>
                    <span className="w-[46px] shrink-0 text-right font-mono text-[10.5px] tabular-nums text-[#6b7280]">
                      {m == null ? "—" : `${m.toFixed(1)}×`}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-[#9CA3AF]">
              {curve.length > 1 && Math.abs(curve[curve.length - 1].residual_pct) > Math.abs(curve[0].residual_pct) * 1.2
                ? "The move kept going after day 0 — the expected scale understated it."
                : "Most of the move was in by the first close."}
            </p>
          </section>
        )}

        {/* Stage-2 */}
        <section className="mt-5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[#b4b4ae]">Refinement</p>
          {t.stage2 ? (
            <div className="mt-1.5">
              <p className="text-[12px] text-[#1d1b1b]">
                <span className="font-medium capitalize">{t.stage2.verdict}</span>
                {t.stage2.direction ? <span className="text-[#6b7280]"> · resolved {directionWord(t.stage2.direction)}</span> : null}
              </p>
              {t.stage2.rationale && <p className="mt-1 text-[12px] leading-relaxed text-[#6b7280]">{t.stage2.rationale}</p>}
            </div>
          ) : (
            <p className="mt-1.5 text-[11.5px] text-[#9CA3AF]">{run.status === "ok" ? "Confirmed as produced by stage-1." : "Refinement unavailable — stage-1 template."}</p>
          )}
        </section>
      </div>
    </aside>
  );
}
