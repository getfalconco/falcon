import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, X } from "lucide-react";
import { Segmented } from "@/components/settings/controls";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";
import { useI18n, useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AgentFilingChangeKind, AgentLinkRelation, AgentLinkedEvent, AgentTrigger, AgentTriggerKind } from "../../../shared/agent-types";
import { triggerProblem } from "./agent-draft";
import { CHANGE_KINDS, LINKED_DEFAULT_FORMS, TRIGGER_KINDS, macroLabel, triggerKindLabel, triggerSentence, weekdayName } from "./agent-format";
import { FIELD } from "./agent-ui";
import TickerField from "./TickerField";

const FORMS = ["8-K", "10-Q", "10-K", "4", "13D", "S-1"] as const;
const MACRO_EVENTS = ["CPI", "Payrolls", "FOMC rate decision", "PCE", "GDP"] as const;
const LINK_RELATIONS: readonly AgentLinkRelation[] = ["supplier", "customer", "competitor"];
const LINKED_EVENTS: readonly AgentLinkedEvent[] = ["earnings", "filing", "news"];
const LINKED_FORMS = ["8-K", "6-K", "10-Q", "10-K"] as const;

/** A fresh trigger of a kind, filled from the agent's ticker where it needs one. */
export function defaultTrigger(kind: AgentTriggerKind, ticker: string): AgentTrigger {
  switch (kind) {
    case "earnings":
      return { kind, ticker, moment: "release" };
    case "filing":
      return { kind, ticker, forms: ["8-K", "10-Q"] };
    case "price_move":
      return { kind, ticker, thresholdPct: 5, window: "1d" };
    case "news":
      return { kind, ticker: ticker || undefined, keywords: [] };
    case "macro":
      return { kind, event: "CPI" };
    case "linked":
      return { kind, ticker, relations: ["supplier", "customer"], events: ["earnings", "filing"] };
    case "filing_changes":
      return { kind, ticker };
    case "schedule":
      return { kind, cadence: "weekdays", time: "08:00" };
  }
}

export { triggerProblem };

function KindMenu({ kind, onPick }: { kind: AgentTriggerKind; onPick: (k: AgentTriggerKind) => void }) {
  const lang = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="app-no-drag inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-content-primary transition-colors hover:bg-black/[0.04]"
      >
        {triggerKindLabel(kind, lang)}
        <ChevronDown className="h-3.5 w-3.5 text-content-secondary" strokeWidth={2} aria-hidden />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            {...DROPDOWN_FADE}
            className="app-no-drag absolute left-0 top-full z-50 mt-1.5 w-44 rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
          >
            {TRIGGER_KINDS.map((k) => (
              <button
                key={k}
                role="menuitemradio"
                aria-checked={k === kind}
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (k !== kind) onPick(k);
                }}
                className={cn(
                  "flex w-full items-center rounded-xl px-3 py-1.5 text-left text-[12.5px] text-content-primary transition-colors hover:bg-ink/[0.07]",
                  k === kind && "font-medium",
                )}
              >
                {triggerKindLabel(k, lang)}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "app-no-drag h-7 rounded-lg px-2.5 text-[12px] transition-colors",
        on ? "bg-ink/[0.08] font-medium text-content-primary ring-1 ring-black/[0.1]" : "text-content-secondary ring-1 ring-black/[0.06] hover:bg-black/[0.04]",
      )}
    >
      {children}
    </button>
  );
}

const SMALL_LABEL = "w-[84px] shrink-0 text-[12px] leading-[1.3] text-content-secondary";

/**
 * One trigger, edited by kind: the kind menu on the left, its fields under
 * it, and the trigger read back as a sentence so the reader sees what they
 * have set without decoding the controls.
 */
export default function TriggerEditor({
  trigger,
  agentTicker,
  onChange,
  onRemove,
}: {
  trigger: AgentTrigger;
  agentTicker: string;
  onChange: (t: AgentTrigger) => void;
  onRemove?: () => void;
}) {
  const t = trigger;
  const { language: lang, t: tr } = useI18n();
  const problem = triggerProblem(t, lang);
  const [keywordText, setKeywordText] = useState(t.kind === "news" ? t.keywords.join(", ") : t.kind === "schedule" ? (t.keywords ?? []).join(", ") : "");
  const [customMacro, setCustomMacro] = useState(t.kind === "macro" && !(MACRO_EVENTS as readonly string[]).includes(t.event));

  const tickerRow =
    t.kind === "earnings" || t.kind === "filing" || t.kind === "price_move" || t.kind === "news" || t.kind === "linked" || t.kind === "filing_changes" ? (
      <div className="flex items-center gap-3">
        <span className={SMALL_LABEL}>{tr("agents.trig.ticker")}</span>
        <TickerField
          className="w-44"
          value={t.ticker ?? ""}
          ariaLabel={tr("agents.trig.ticker")}
          placeholder={t.kind === "news" ? tr("agents.form.optional") : agentTicker || tr("agents.trig.ticker")}
          onChange={(ticker) => onChange({ ...t, ticker } as AgentTrigger)}
        />
      </div>
    ) : null;

  return (
    <div className="rounded-2xl border border-black/[0.06] bg-white/40 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="-ml-2">
          <KindMenu kind={t.kind} onPick={(k) => onChange(defaultTrigger(k, agentTicker))} />
        </div>
        {onRemove ? (
          <button
            type="button"
            aria-label={tr("agents.trig.remove")}
            onClick={onRemove}
            className="app-no-drag flex h-6 w-6 items-center justify-center rounded-md text-content-tertiary transition-colors hover:bg-black/[0.04] hover:text-content-primary"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="mt-2 space-y-2.5">
        {tickerRow}

        {t.kind === "earnings" ? (
          <div className="flex items-center gap-3">
            <span className={SMALL_LABEL}>{tr("agents.trig.firesOn")}</span>
            <Segmented
              label={tr("agents.trig.firesOn")}
              value={t.moment}
              options={[
                { value: "release", label: tr("agents.trig.release") },
                { value: "call", label: tr("agents.trig.call") },
              ]}
              onChange={(moment) => onChange({ ...t, moment })}
            />
          </div>
        ) : null}

        {t.kind === "filing" ? (
          <div className="flex items-start gap-3">
            <span className={cn(SMALL_LABEL, "pt-1.5")}>{tr("agents.trig.forms")}</span>
            <div className="flex flex-wrap gap-1.5">
              {FORMS.map((f) => {
                const on = t.forms.includes(f);
                return (
                  <Chip
                    key={f}
                    on={on}
                    onClick={() => {
                      const forms = on ? t.forms.filter((x) => x !== f) : [...t.forms, f];
                      onChange({ ...t, forms, insiderBuysOnly: forms.includes("4") ? t.insiderBuysOnly : undefined });
                    }}
                  >
                    {f === "4" ? tr("agents.form4") : f}
                  </Chip>
                );
              })}
            </div>
          </div>
        ) : null}

        {t.kind === "filing" && t.forms.includes("4") ? (
          <label className="flex cursor-pointer items-center gap-3">
            <span className={SMALL_LABEL}>{tr("agents.form4")}</span>
            <input
              type="checkbox"
              checked={t.insiderBuysOnly === true}
              onChange={(e) => onChange({ ...t, insiderBuysOnly: e.target.checked || undefined })}
              className="app-no-drag h-[15px] w-[15px] accent-tint"
            />
            <span className="text-[12.5px] text-content-primary">{tr("agents.trig.openMarketOnly")}</span>
          </label>
        ) : null}

        {t.kind === "price_move" ? (
          <>
            <div className="flex items-center gap-3">
              <span className={SMALL_LABEL}>{tr("agents.trig.moreThan")}</span>
              <div className="relative w-24">
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={Number.isFinite(t.thresholdPct) ? t.thresholdPct : ""}
                  onChange={(e) => onChange({ ...t, thresholdPct: Number(e.target.value) })}
                  aria-label={tr("agents.trig.moveAria")}
                  className={cn(FIELD, "h-9 pr-7 tabular-nums")}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-content-tertiary">%</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className={SMALL_LABEL}>{tr("agents.trig.over")}</span>
              <Segmented
                label={tr("agents.trig.window")}
                value={t.window}
                options={[
                  { value: "intraday", label: tr("agents.trig.session") },
                  { value: "1d", label: tr("agents.trig.oneDay") },
                  { value: "5d", label: tr("agents.trig.fiveDays") },
                ]}
                onChange={(window) => onChange({ ...t, window })}
              />
            </div>
          </>
        ) : null}

        {t.kind === "news" ? (
          <div className="flex items-center gap-3">
            <span className={SMALL_LABEL}>{tr("agents.trig.keywords")}</span>
            <input
              value={keywordText}
              onChange={(e) => {
                setKeywordText(e.target.value);
                onChange({ ...t, keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) });
              }}
              placeholder={tr("agents.trig.keywordsPlaceholder")}
              aria-label={tr("agents.trig.keywordsAria")}
              className={cn(FIELD, "h-9 flex-1")}
            />
          </div>
        ) : null}

        {t.kind === "linked" ? (
          <>
            <div className="flex items-start gap-3">
              <span className={cn(SMALL_LABEL, "pt-1.5")}>{tr("agents.trig.relations")}</span>
              <div className="flex flex-wrap gap-1.5">
                {LINK_RELATIONS.map((r) => {
                  const current = t.relations && t.relations.length > 0 ? t.relations : LINK_RELATIONS;
                  const on = current.includes(r);
                  return (
                    <Chip
                      key={r}
                      on={on}
                      onClick={() => {
                        const next = on ? current.filter((x) => x !== r) : LINK_RELATIONS.filter((x) => x === r || current.includes(x));
                        // None picked reads as all three, so the last one stays on.
                        if (next.length === 0) return;
                        onChange({ ...t, relations: next.length === LINK_RELATIONS.length ? undefined : [...next] });
                      }}
                    >
                      {tr(`agents.trig.rel.${r}`)}
                    </Chip>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className={SMALL_LABEL}>{tr("agents.trig.strength")}</span>
              <Segmented
                label={tr("agents.trig.strength")}
                value={t.minTier ?? "important"}
                options={[
                  { value: "critical", label: tr("agents.trig.tier.critical") },
                  { value: "important", label: tr("agents.trig.tier.important") },
                  { value: "marginal", label: tr("agents.trig.tier.marginal") },
                ]}
                onChange={(minTier) => onChange({ ...t, minTier: minTier === "important" ? undefined : minTier })}
              />
            </div>
            <div className="flex items-start gap-3">
              <span className={cn(SMALL_LABEL, "pt-1.5")}>{tr("agents.trig.firesOn")}</span>
              <div className="flex flex-wrap gap-1.5">
                {LINKED_EVENTS.map((e) => {
                  const on = t.events.includes(e);
                  return (
                    <Chip
                      key={e}
                      on={on}
                      onClick={() => onChange({ ...t, events: on ? t.events.filter((x) => x !== e) : LINKED_EVENTS.filter((x) => x === e || t.events.includes(x)) })}
                    >
                      {tr(`agents.trig.ev.${e}`)}
                    </Chip>
                  );
                })}
              </div>
            </div>
            {t.events.includes("filing") ? (
              <div className="flex items-start gap-3">
                <span className={cn(SMALL_LABEL, "pt-1.5")}>{tr("agents.trig.forms")}</span>
                <div className="flex flex-wrap gap-1.5">
                  {LINKED_FORMS.map((f) => {
                    const current = t.forms && t.forms.length > 0 ? t.forms : LINKED_DEFAULT_FORMS;
                    const on = current.includes(f);
                    return (
                      <Chip
                        key={f}
                        on={on}
                        onClick={() => {
                          const next = on ? current.filter((x) => x !== f) : [...current, f];
                          if (next.length === 0) return;
                          const same = next.length === LINKED_DEFAULT_FORMS.length && LINKED_DEFAULT_FORMS.every((x) => next.includes(x));
                          onChange({ ...t, forms: same ? undefined : next });
                        }}
                      >
                        {f}
                      </Chip>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {t.kind === "filing_changes" ? (
          <div className="flex items-start gap-3">
            <span className={cn(SMALL_LABEL, "pt-1.5")}>{tr("agents.trig.changes")}</span>
            <div className="flex flex-wrap gap-1.5">
              {CHANGE_KINDS.map((k: AgentFilingChangeKind) => {
                const current = t.kinds && t.kinds.length > 0 ? t.kinds : CHANGE_KINDS;
                const on = current.includes(k);
                return (
                  <Chip
                    key={k}
                    on={on}
                    onClick={() => {
                      const next = on ? current.filter((x) => x !== k) : CHANGE_KINDS.filter((x) => x === k || current.includes(x));
                      // None picked reads as all four, so the last one stays on.
                      if (next.length === 0) return;
                      onChange({ ...t, kinds: next.length === CHANGE_KINDS.length ? undefined : [...next] });
                    }}
                  >
                    {tr(`agents.trig.change.${k}`)}
                  </Chip>
                );
              })}
            </div>
          </div>
        ) : null}

        {t.kind === "macro" ? (
          <div className="flex items-start gap-3">
            <span className={cn(SMALL_LABEL, "pt-1.5")}>{tr("agents.trig.releaseLabel")}</span>
            <div className="flex flex-1 flex-wrap gap-1.5">
              {MACRO_EVENTS.map((ev) => (
                <Chip
                  key={ev}
                  on={!customMacro && t.event === ev}
                  onClick={() => {
                    setCustomMacro(false);
                    onChange({ ...t, event: ev });
                  }}
                >
                  {macroLabel(ev, lang)}
                </Chip>
              ))}
              <Chip
                on={customMacro}
                onClick={() => {
                  setCustomMacro(true);
                  onChange({ ...t, event: "" });
                }}
              >
                {tr("agents.trig.other")}
              </Chip>
              {customMacro ? (
                <input
                  autoFocus
                  value={t.event}
                  onChange={(e) => onChange({ ...t, event: e.target.value })}
                  placeholder={tr("agents.trig.releasePlaceholder")}
                  aria-label={tr("agents.trig.releaseAria")}
                  className={cn(FIELD, "mt-1 h-9 w-full")}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {t.kind === "schedule" ? (
          <>
            <div className="flex items-center gap-3">
              <span className={SMALL_LABEL}>{tr("agents.trig.every")}</span>
              <Segmented
                label={tr("agents.trig.cadence")}
                value={t.cadence}
                options={[
                  { value: "daily", label: tr("agents.trig.day") },
                  { value: "weekdays", label: tr("agents.trig.weekday") },
                  { value: "weekly", label: tr("agents.trig.week") },
                ]}
                onChange={(cadence) => onChange({ ...t, cadence, weekday: cadence === "weekly" ? (t.weekday ?? 1) : undefined })}
              />
            </div>
            {t.cadence === "weekly" ? (
              <div className="flex items-center gap-3">
                <span className={SMALL_LABEL}>{tr("agents.trig.on")}</span>
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 4, 5].map((d) => (
                    <Chip key={d} on={(t.weekday ?? 1) === d} onClick={() => onChange({ ...t, weekday: d })}>
                      {weekdayName(d, lang, "short")}
                    </Chip>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex items-center gap-3">
              <span className={SMALL_LABEL}>{tr("agents.trig.at")}</span>
              <input
                type="time"
                value={t.time}
                onChange={(e) => onChange({ ...t, time: e.target.value })}
                aria-label={tr("agents.trig.timeAria")}
                className={cn(FIELD, "h-9 w-32 tabular-nums")}
              />
              <span className="text-[11.5px] text-content-tertiary">{tr("agents.trig.localTime")}</span>
            </div>
            {/* A digest about no one company: the topic its headlines are narrowed to. */}
            <div className="flex items-center gap-3">
              <span className={SMALL_LABEL}>{tr("agents.trig.keywords")}</span>
              <input
                value={keywordText}
                onChange={(e) => {
                  setKeywordText(e.target.value);
                  const keywords = e.target.value.split(",").map((k) => k.trim()).filter(Boolean);
                  onChange({ ...t, keywords: keywords.length > 0 ? keywords : undefined });
                }}
                placeholder={tr("agents.trig.keywordsPlaceholder")}
                aria-label={tr("agents.trig.keywordsAria")}
                className={cn(FIELD, "h-9 flex-1")}
              />
            </div>
          </>
        ) : null}
      </div>

      <p className={cn("mt-3 text-[12px]", problem ? "text-tone-warning" : "text-content-secondary")}>{problem ?? triggerSentence(t, lang)}</p>
    </div>
  );
}
