import type { ReactNode } from "react";
import { Info, Plus, X } from "lucide-react";
import { Segmented, Switch } from "@/components/settings/controls";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AgentChannel, AgentDraft, AgentMetric } from "../../../shared/agent-types";
import { DIGEST_TIME, timeOfDay } from "./agent-format";
import { BUTTON, FIELD, LABEL } from "./agent-ui";
import TickerField from "./TickerField";
import TriggerEditor, { defaultTrigger } from "./TriggerEditor";

export { draftProblems } from "./agent-draft";

/**
 * The agent as editable fields: the shape `draftFromBrief` hands back for a
 * new agent, and the same fields for editing one. Controlled throughout; the
 * caller owns the draft and decides what saving means.
 *
 * Each group of fields is exported on its own so the setup wizard can lay
 * them out a step at a time; `AgentForm` is all of them in one column, as the
 * New agent flow and the edit screen show it.
 */

type PartProps = { draft: AgentDraft; onChange: (d: AgentDraft) => void };

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={LABEL}>{label}</h3>
        {hint ? <span className="text-[11.5px] text-[#9CA3AF]">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** A calm note beside the fields: an icon, an optional title, a line or a list. */
export function Callout({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-2xl bg-black/[0.04] px-4 py-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#6b7280]" strokeWidth={1.75} aria-hidden />
      <div className="min-w-0 space-y-1">
        {title ? <div className="text-[12.5px] font-medium text-[#1d1b1b]">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}

let metricSeq = 0;
const newMetricId = () => `m-${Date.now().toString(36)}-${++metricSeq}`;

/** What the parser was unsure of, when it said. */
export function DraftNotes({ draft }: { draft: AgentDraft }) {
  const { t } = useI18n();
  if (!draft.notes || draft.notes.length === 0) return null;
  return (
    <Callout title={t("agents.form.notesTitle")}>
      <ul className="space-y-0.5">
        {draft.notes.map((n) => (
          <li key={n} className="text-[12.5px] leading-[1.5] text-[#4b5563]">
            {n}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** Name and company, side by side. */
export function IdentityFields({ draft, onChange }: PartProps) {
  const { t } = useI18n();
  const set = (patch: Partial<AgentDraft>) => onChange({ ...draft, ...patch });
  const ticker = draft.ticker ?? "";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-4">
      <Field label={t("agents.form.name")}>
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder={t("agents.form.namePlaceholder")}
          aria-label={t("agents.form.nameAria")}
          className={cn(FIELD, "h-9")}
        />
      </Field>
      <Field label={t("agents.form.company")}>
        <TickerField
          value={ticker}
          companyName={draft.companyName}
          placeholder={t("agents.form.companyNone")}
          ariaLabel={t("agents.form.companyAria")}
          onChange={(next, companyName) => {
            // Triggers that were following the agent's ticker keep following it.
            const triggers = draft.triggers.map((t) =>
              "ticker" in t && (t.ticker ?? "") === ticker ? { ...t, ticker: next } : t,
            ) as AgentDraft["triggers"];
            set({ ticker: next || undefined, companyName: next ? companyName : undefined, triggers });
          }}
        />
      </Field>
    </div>
  );
}

/** The triggers, each in its own editor, and the way to add one. */
export function TriggersField({ draft, onChange }: PartProps) {
  const { t } = useI18n();
  const set = (patch: Partial<AgentDraft>) => onChange({ ...draft, ...patch });
  const ticker = draft.ticker ?? "";
  return (
    <Field label={t("agents.wakesUp")} hint={t("agents.form.wakesHint")}>
      <div className="space-y-2">
        {draft.triggers.map((t, i) => (
          <TriggerEditor
            key={`${i}-${t.kind}`}
            trigger={t}
            agentTicker={ticker}
            onChange={(next) => set({ triggers: draft.triggers.map((x, j) => (j === i ? next : x)) })}
            onRemove={draft.triggers.length > 1 ? () => set({ triggers: draft.triggers.filter((_, j) => j !== i) }) : undefined}
          />
        ))}
        <button
          type="button"
          onClick={() => set({ triggers: [...draft.triggers, defaultTrigger(ticker ? "filing" : "news", ticker)] })}
          className={BUTTON}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          {t("agents.form.anotherTrigger")}
        </button>
      </div>
    </Field>
  );
}

/** The numbers to report on, each with the reader's bar when they have one. */
export function MetricsField({ draft, onChange }: PartProps) {
  const { t } = useI18n();
  const set = (patch: Partial<AgentDraft>) => onChange({ ...draft, ...patch });
  const setMetric = (i: number, patch: Partial<AgentMetric>) =>
    set({ metrics: draft.metrics.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  return (
    <Field label={t("agents.form.reportOn")} hint={t("agents.form.reportOnHint")}>
      <div className="space-y-2">
        {draft.metrics.length > 0 ? (
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_28px] gap-x-2 px-1 font-['Geist_Mono'] text-[9.5px] uppercase tracking-[0.06em] text-[#9CA3AF]">
            <span>{t("agents.metric")}</span>
            <span>{t("agents.yourBar")}</span>
            <span />
          </div>
        ) : null}
        {draft.metrics.map((m, i) => (
          <div key={m.id} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_28px] items-center gap-x-2">
            <input
              value={m.label}
              onChange={(e) => setMetric(i, { label: e.target.value })}
              placeholder={t("agents.form.metricPlaceholder")}
              aria-label={t("agents.metric")}
              className={cn(FIELD, "h-9")}
            />
            <input
              value={m.expectation ?? ""}
              onChange={(e) => setMetric(i, { expectation: e.target.value || undefined })}
              placeholder={i === 0 ? t("agents.form.barPlaceholderFirst") : t("agents.form.optional")}
              aria-label={m.label ? t("agents.form.barFor", { metric: m.label }) : t("agents.form.barForThis")}
              className={cn(FIELD, "h-9")}
            />
            <button
              type="button"
              aria-label={m.label ? t("agents.form.remove", { metric: m.label }) : t("agents.form.removeMetric")}
              onClick={() => set({ metrics: draft.metrics.filter((_, j) => j !== i) })}
              className="app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-[#9CA3AF] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          </div>
        ))}
        {draft.metrics.length === 0 ? <p className="text-[12px] text-[#9CA3AF]">{t("agents.form.noMetrics")}</p> : null}
        <button
          type="button"
          onClick={() => set({ metrics: [...draft.metrics, { id: newMetricId(), label: "" }] })}
          className={BUTTON}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          {t("agents.form.anotherMetric")}
        </button>
      </div>
    </Field>
  );
}

/** The daily digest, desktop and mobile delivery, as switches (the app itself always has every report). `bare` leaves out the label, for a caller that names it itself. */
export function ChannelsField({ draft, onChange, bare = false }: PartProps & { bare?: boolean }) {
  const { language: lang, t } = useI18n();
  const toggleChannel = (c: AgentChannel, on: boolean) =>
    onChange({ ...draft, channels: on ? Array.from(new Set([...draft.channels, c])) : draft.channels.filter((x) => x !== c) });
  const switches = (
    <div className="divide-y divide-black/[0.06] rounded-2xl border border-black/[0.06]">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div>
          <div className="text-[13px] text-[#1d1b1b]">{t("agents.dailyDigest")}</div>
          <div className="text-[11.5px] text-[#9CA3AF]">{t("agents.form.digestHint", { time: timeOfDay(DIGEST_TIME, lang) })}</div>
        </div>
        <Switch label={t("agents.dailyDigest")} checked={draft.channels.includes("digest")} onChange={(on) => toggleChannel("digest", on)} />
      </div>
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div>
          <div className="text-[13px] text-[#1d1b1b]">{t("agents.desktopNotification")}</div>
          <div className="text-[11.5px] text-[#9CA3AF]">{t("agents.form.desktopHint")}</div>
        </div>
        <Switch label={t("agents.desktopNotification")} checked={draft.channels.includes("desktop")} onChange={(on) => toggleChannel("desktop", on)} />
      </div>
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div>
          <div className="text-[13px] text-[#1d1b1b]">{t("agents.mobilePush")}</div>
          <div className="text-[11.5px] text-[#9CA3AF]">{t("agents.form.mobileHint")}</div>
        </div>
        <Switch label={t("agents.mobilePush")} checked={draft.channels.includes("mobile_push")} onChange={(on) => toggleChannel("mobile_push", on)} />
      </div>
    </div>
  );
  if (bare) return switches;
  return <Field label={t("agents.delivery")}>{switches}</Field>;
}

/** Extra guidance for the write-up. `bare` leaves out the label, for a caller that names it itself. */
export function WriteupField({ draft, onChange, bare = false }: PartProps & { bare?: boolean }) {
  const { t } = useI18n();
  const area = (
    <textarea
      value={draft.instructions ?? ""}
      onChange={(e) => onChange({ ...draft, instructions: e.target.value || undefined })}
      rows={2}
      placeholder={t("agents.form.writeupPlaceholder")}
      aria-label={t("agents.form.writeupAria")}
      className={cn(FIELD, "resize-none py-2 leading-[1.5]")}
    />
  );
  if (bare) return area;
  return (
    <Field label={t("agents.writeup")} hint={t("agents.form.optional")}>
      {area}
    </Field>
  );
}

export default function AgentForm({ draft, onChange }: PartProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-7">
      <DraftNotes draft={draft} />
      <IdentityFields draft={draft} onChange={onChange} />
      <TriggersField draft={draft} onChange={onChange} />
      <MetricsField draft={draft} onChange={onChange} />
      <Field label={t("agents.form.after")}>
        <Segmented
          label={t("agents.form.afterAria")}
          value={draft.oneShot ? "once" : "keep"}
          options={[
            { value: "once", label: t("agents.oneShot") },
            { value: "keep", label: t("agents.form.keepWatching") },
          ]}
          onChange={(v) => onChange({ ...draft, oneShot: v === "once" })}
        />
      </Field>
      <ChannelsField draft={draft} onChange={onChange} />
      <WriteupField draft={draft} onChange={onChange} />
    </div>
  );
}
