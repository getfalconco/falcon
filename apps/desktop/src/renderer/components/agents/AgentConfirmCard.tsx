import { useState, type ReactNode } from "react";
import { Segmented } from "@/components/settings/controls";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AgentDraft, AgentEnds } from "../../../shared/agent-types";
import { deliverySentence, endsSentence, triggerSentence, watchSubjects, watchedTickers, whenHint } from "./agent-format";
import { FIELD, TickerChip, useNow } from "./agent-ui";
import { ChannelsField, MetricsField, TriggersField } from "./AgentForm";
import TickerField from "./TickerField";

/**
 * The parts of a draft, each on its own row with a small "change" link that
 * opens its editor in place: Watching, When, Report on, Delivery and Ends.
 * Create Agent's second step keeps it under "Adjust details", for whoever
 * wants to set a part by hand; the name is the reader's and stays on step 1.
 */

type Part = "watching" | "when" | "reportOn" | "delivery" | "ends";

const FORMS = ["8-K", "10-Q", "10-K", "4"] as const;

/** A local date as YYYY-MM-DD, `days` from today. */
function localDatePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The results date the draft waits for, YYYY-MM-DD in New York, when the engine found one. */
function resultsDate(draft: AgentDraft): string | undefined {
  if (!draft.nextExpectedAt) return undefined;
  const at = Date.parse(draft.nextExpectedAt);
  if (!Number.isFinite(at)) return undefined;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function Row({
  label,
  part,
  open,
  onToggle,
  children,
  editor,
}: {
  label: string;
  part: Part;
  open: boolean;
  onToggle: (part: Part) => void;
  children: ReactNode;
  editor: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <h3 className="w-[92px] shrink-0 pt-px text-[12px] text-content-secondary">{label}</h3>
        <div className="min-w-0 flex-1 text-[13px] leading-[1.55] text-content-primary">{children}</div>
        <button
          type="button"
          onClick={() => onToggle(part)}
          aria-expanded={open}
          aria-label={t("agents.confirm.changeAria", { part: label })}
          className="app-no-drag shrink-0 rounded-md px-1.5 text-[12px] text-content-secondary underline-offset-2 transition-colors hover:text-content-primary hover:underline"
        >
          {open ? t("agents.confirm.done") : t("agents.confirm.change")}
        </button>
      </div>
      {open ? <div className="mt-3 pl-[104px]">{editor}</div> : null}
    </div>
  );
}

function EndsEditor({ draft, onChange }: { draft: AgentDraft; onChange: (d: AgentDraft) => void }) {
  const { t } = useI18n();
  const ticker = draft.ticker ?? watchedTickers(draft)[0];
  const ends = draft.ends;
  const filingForm = draft.triggers.find((x) => x.kind === "filing")?.forms[0];
  const set = (next: AgentEnds) => onChange({ ...draft, ends: next, endsProposed: false });
  const kind = ends?.kind ?? "date";
  const options = [
    { value: "date" as const, label: t("agents.endsKind.date") },
    ...(ticker
      ? [
          { value: "earnings" as const, label: t("agents.endsKind.earnings") },
          { value: "filing" as const, label: t("agents.endsKind.filing") },
        ]
      : []),
  ];
  return (
    <div className="space-y-3">
      <Segmented
        label={t("agents.endsKind.aria")}
        value={kind}
        options={options}
        onChange={(v) => {
          if (v === "date") set({ kind: "date", date: ends?.kind === "date" ? ends.date : localDatePlus(90) });
          else if (v === "earnings" && ticker) set({ kind: "earnings", ticker });
          else if (v === "filing" && ticker) set({ kind: "filing", ticker, form: ends?.kind === "filing" ? ends.form : filingForm ?? "8-K" });
        }}
      />
      {ends?.kind === "date" ? (
        <input
          type="date"
          value={ends.date}
          min={localDatePlus(1)}
          aria-label={t("agents.endsKind.dateAria")}
          onChange={(e) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) set({ kind: "date", date: e.target.value });
          }}
          className={cn(FIELD, "h-9 w-[180px]")}
        />
      ) : null}
      {ends?.kind === "filing" ? (
        <select
          value={ends.form}
          aria-label={t("agents.endsKind.formAria")}
          onChange={(e) => set({ ...ends, form: e.target.value })}
          className={cn(FIELD, "h-9 w-[180px]")}
        >
          {[...new Set([...FORMS, ends.form])].map((f) => (
            <option key={f} value={f}>
              {f === "4" ? t("agents.form4") : f}
            </option>
          ))}
        </select>
      ) : null}
      <Segmented
        label={t("agents.form.afterAria")}
        value={draft.oneShot ? "once" : "keep"}
        options={[
          { value: "once", label: t("agents.oneShot") },
          { value: "keep", label: t("agents.form.keepWatching") },
        ]}
        onChange={(v) => onChange({ ...draft, oneShot: v === "once" })}
      />
    </div>
  );
}

export default function AgentConfirmCard({ draft, onChange }: { draft: AgentDraft; onChange: (d: AgentDraft) => void }) {
  const { language: lang, t } = useI18n();
  const now = useNow(60_000);
  const [open, setOpen] = useState<Part | null>(null);
  const toggle = (part: Part) => setOpen((cur) => (cur === part ? null : part));
  const tickers = watchedTickers(draft);
  const subjects = watchSubjects(draft, lang);
  const metrics = draft.metrics.filter((m) => m.label.trim());
  const primary = draft.ticker ?? "";

  return (
    <div>
      <div className="rounded-2xl border border-black/[0.06]">
        <div className="divide-y divide-black/[0.06]">
          <Row
            label={t("agents.confirm.watching")}
            part="watching"
            open={open === "watching"}
            onToggle={toggle}
            editor={
              <div className="w-[240px]">
                <TickerField
                  value={primary}
                  companyName={draft.companyName}
                  placeholder={t("agents.form.companyNone")}
                  ariaLabel={t("agents.form.companyAria")}
                  onChange={(next, companyName) => {
                    // Triggers and the end that followed the agent's ticker keep following it.
                    const triggers = draft.triggers.map((x) =>
                      "ticker" in x && (x.ticker ?? "") === primary ? { ...x, ticker: next } : x,
                    ) as AgentDraft["triggers"];
                    const ends = draft.ends && draft.ends.kind !== "date" && draft.ends.ticker === primary && next ? { ...draft.ends, ticker: next } : draft.ends;
                    onChange({ ...draft, ticker: next || undefined, companyName: next ? companyName : undefined, triggers, ends });
                  }}
                />
              </div>
            }
          >
            {tickers.length > 0 ? (
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {tickers.map((tk) => (
                  <TickerChip key={tk} ticker={tk} />
                ))}
                {draft.companyName ? <span className="truncate text-[12.5px] text-content-secondary">{draft.companyName}</span> : null}
              </span>
            ) : (
              // No company: what it watches instead, a topic or the market's headlines.
              <span>{subjects.length > 0 ? subjects.join("; ") : t("agents.noun.marketNews")}</span>
            )}
          </Row>

          <Row
            label={t("agents.confirm.when")}
            part="when"
            open={open === "when"}
            onToggle={toggle}
            editor={<TriggersField draft={draft} onChange={onChange} />}
          >
            <ul className="space-y-0.5">
              {draft.triggers.map((tr, i) => {
                const hint = whenHint(tr, draft, now, lang);
                return (
                  <li key={i}>
                    {triggerSentence(tr, lang)}
                    {hint ? <span className="text-content-secondary">{`, ${hint}`}</span> : null}
                  </li>
                );
              })}
            </ul>
          </Row>

          <Row
            label={t("agents.confirm.reportOn")}
            part="reportOn"
            open={open === "reportOn"}
            onToggle={toggle}
            editor={<MetricsField draft={draft} onChange={onChange} />}
          >
            {metrics.length === 0 ? (
              <span className="text-content-secondary">{t("agents.confirm.noMetrics")}</span>
            ) : (
              <span className="flex flex-wrap gap-1.5">
                {metrics.map((m) => (
                  <span key={m.id} className="inline-flex items-center rounded-lg bg-black/[0.05] px-2 py-0.5 text-[12.5px]">
                    {m.label.trim()}
                    {m.expectation?.trim() ? <span className="ml-1 text-content-secondary">{`(${m.expectation.trim()})`}</span> : null}
                  </span>
                ))}
              </span>
            )}
          </Row>

          <Row
            label={t("agents.confirm.delivery")}
            part="delivery"
            open={open === "delivery"}
            onToggle={toggle}
            editor={<ChannelsField draft={draft} onChange={onChange} bare />}
          >
            {deliverySentence(draft.channels, lang)}
          </Row>

          <Row label={t("agents.confirm.ends")} part="ends" open={open === "ends"} onToggle={toggle} editor={<EndsEditor draft={draft} onChange={onChange} />}>
            <span>{endsSentence(draft.ends, lang, resultsDate(draft))}</span>
            {draft.endsProposed ? <span className="ml-1.5 text-[11.5px] text-content-tertiary">{t("agents.confirm.proposed")}</span> : null}
            <span className="block text-[12px] text-content-secondary">{draft.oneShot ? t("agents.oneShot") : t("agents.form.keepWatching")}</span>
          </Row>
        </div>
      </div>
    </div>
  );
}
