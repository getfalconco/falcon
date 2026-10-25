import { useI18n, type LanguageCode } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AgentActivity as Entry } from "../../../shared/agent-types";
import { capitalize, clockTime, sayLines, shortDate } from "./agent-format";

/** Dot colour per kind: firing and errors stand out, routine checks stay quiet. */
const DOT: Readonly<Record<Entry["kind"], string>> = {
  created: "bg-ink/30",
  edited: "bg-ink/30",
  checked: "bg-ink/20",
  waiting: "bg-ink/20",
  fired: "bg-ink",
  notified: "bg-ink/40",
  paused: "bg-content-tertiary",
  resumed: "bg-tone-positive-fill",
  completed: "bg-ink/40",
  error: "bg-tone-negative-fill",
};

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string, now: number, lang: LanguageCode): string {
  const key = dayKey(iso);
  const relative = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (key === dayKey(new Date(now).toISOString())) return capitalize(relative.format(0, "day"), lang);
  if (key === dayKey(new Date(now - 86_400_000).toISOString())) return capitalize(relative.format(-1, "day"), lang);
  return shortDate(iso, lang);
}

/**
 * The agent's timeline, newest first and grouped by day: when it was made,
 * each check, each time it fired and what it sent. An entry that produced a
 * report links to it.
 */
export default function AgentActivity({
  activity,
  now,
  onOpenReport,
}: {
  activity: readonly Entry[];
  now: number;
  onOpenReport: (reportId: string) => void;
}) {
  const { language: lang, t } = useI18n();
  if (activity.length === 0) {
    return <p className="py-10 text-center text-[12.5px] text-content-tertiary">{t("agents.activity.empty")}</p>;
  }

  const groups: Array<{ label: string; items: Entry[] }> = [];
  for (const entry of activity) {
    const label = dayLabel(entry.at, now, lang);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(entry);
    else groups.push({ label, items: [entry] });
  }

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.label}>
          <h3 className="pb-2 font-['Geist_Mono'] text-[9.5px] uppercase tracking-[0.06em] text-content-tertiary">{g.label}</h3>
          <ol className="relative">
            {g.items.map((e, i) => (
              <li key={e.id} className="relative grid grid-cols-[44px_14px_minmax(0,1fr)] items-start gap-x-2 pb-3 last:pb-0">
                <time dateTime={e.at} className="pt-px text-right font-['Geist_Mono'] text-[11px] tabular-nums text-content-tertiary">
                  {clockTime(e.at, lang)}
                </time>
                <span className="relative flex h-full justify-center">
                  {i < g.items.length - 1 ? <span aria-hidden className="absolute bottom-[-12px] top-3 w-px bg-black/[0.06]" /> : null}
                  <span aria-hidden className={cn("relative mt-[5px] h-[7px] w-[7px] rounded-full", DOT[e.kind])} />
                </span>
                <div className="min-w-0 text-[13px] leading-[1.45]">
                  <span className={cn(e.kind === "error" ? "text-tone-negative" : e.kind === "fired" ? "font-medium text-content-primary" : "text-content-body")}>
                    {sayLines(e.lines, lang, e.text)}
                  </span>
                  {e.reportId ? (
                    <button
                      type="button"
                      onClick={() => onOpenReport(e.reportId!)}
                      className="app-no-drag ml-2 text-[12px] text-content-secondary underline decoration-black/20 underline-offset-2 transition-colors hover:text-content-primary"
                    >
                      {t("agents.activity.openReport")}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
