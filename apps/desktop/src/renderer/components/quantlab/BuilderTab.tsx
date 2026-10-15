import { useI18n } from "@/lib/i18n";
import type { StrategyRow } from "../../../shared/quantlab-types";
import { plural } from "../base/plural";
import { directionLine, entryLine, filterLine, triggerLines } from "./quantlab-format";

/**
 * Builder (§10) — the rule as readable clauses, its version history, and what
 * about it cannot be tested.
 *
 * Components that have no history are shown greyed WITH the reason rather than
 * hidden: a builder that silently omitted them would let someone define a rule
 * around a field the backtest cannot see.
 */
export default function BuilderTab({
  strategies,
  selected,
  onSelect,
  onRunBacktest,
  busy,
}: {
  strategies: StrategyRow[];
  selected: StrategyRow | null;
  onSelect: (id: string) => void;
  onRunBacktest: (id: string) => void;
  busy: string | null;
}) {
  const { t, tNodes, locale } = useI18n();
  return (
    <>
      <div className="w-[340px] shrink-0 overflow-y-auto border-r border-[#e0e0da]">
        {strategies.length === 0 && (
          <div className="px-5 py-4 text-[12px] text-[#9CA3AF]">{t("instruments.quantlab.noStrategies")}</div>
        )}
        {strategies.map((row) => {
          const active = selected?.strategy.strategy_id === row.strategy.strategy_id;
          return (
            <button
              key={row.strategy.strategy_id}
              onClick={() => onSelect(row.strategy.strategy_id)}
              className={`block w-full border-b border-[#e8e8e2] px-5 py-3 text-left transition-colors ${
                active ? "bg-[#e8e8e2]" : "hover:bg-[#eeeee8]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-[#1d1b1b]">{row.strategy.name}</span>
                {row.strategy.live_enabled && (
                  <span className="rounded bg-[#189E9A] px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-white">
                    {t("instruments.quantlab.liveBadge")}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-[#9CA3AF] tabular-nums">
                <span>v{row.strategy.version}</span>
                <span>·</span>
                <span>
                  {t(plural(locale, row.runs, "instruments.quantlab.runs.one", "instruments.quantlab.runs.other"), { n: row.runs })}
                </span>
                {!row.backtestable && (
                  <>
                    <span>·</span>
                    <span className="text-[#b23b3b]">{t("instruments.quantlab.notBacktestable")}</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {!selected && <div className="px-6 py-5 text-[12px] text-[#9CA3AF]">{t("instruments.quantlab.selectStrategy")}</div>}
        {selected && (
          <div className="px-6 py-5">
            <div className="flex items-start gap-4">
              <div className="min-w-0">
                <h2 className="font-baskerville text-[20px] text-[#1d1b1b]">{selected.strategy.name}</h2>
                <div className="mt-1 text-[11px] text-[#9CA3AF] tabular-nums">
                  {t("instruments.quantlab.versionMeta", {
                    id: selected.strategy.strategy_id,
                    version: selected.strategy.version,
                  })}
                  {selected.strategy.parent_version != null &&
                    ` ${t("instruments.quantlab.fromVersion", { version: selected.strategy.parent_version })}`}
                  {" · "}
                  {t(
                    plural(
                      locale,
                      selected.runs,
                      "instruments.quantlab.backtestRuns.one",
                      "instruments.quantlab.backtestRuns.other",
                    ),
                    { n: selected.runs },
                  )}
                </div>
              </div>
              <button
                onClick={() => onRunBacktest(selected.strategy.strategy_id)}
                disabled={!selected.backtestable || busy === selected.strategy.strategy_id}
                className="ml-auto shrink-0 rounded-md bg-[#1d1b1b] px-3 py-1.5 text-[12px] text-white disabled:cursor-not-allowed disabled:bg-[#c8c8c2]"
              >
                {busy === selected.strategy.strategy_id ? t("instruments.quantlab.running") : t("instruments.quantlab.runBacktest")}
              </button>
            </div>

            {selected.unavailable.length > 0 && (
              <div className="mt-4 rounded-lg border border-[#e0d9c8] bg-[#faf6ec] px-4 py-3">
                <div className="text-[11px] font-medium tracking-[0.06em] text-[#8a7a55]">
                  {t("instruments.quantlab.unavailable")}
                </div>
                {selected.unavailable.map((u) => (
                  <div key={u.component} className="mt-2 text-[12px] text-[#6b7280]">
                    {tNodes("instruments.quantlab.unavailableItem", {
                      component: <span className="text-[#4b5563]">{u.component}</span>,
                      reason: u.reason,
                    })}
                  </div>
                ))}
                {!selected.backtestable && (
                  <div className="mt-2 text-[12px] text-[#b23b3b]">
                    {t("instruments.quantlab.cannotBacktest")}
                  </div>
                )}
              </div>
            )}

            <Section title={t("instruments.quantlab.triggerSection")}>
              {triggerLines(selected.strategy.trigger, t, locale).map((line, i) => (
                <Clause key={i}>{line}</Clause>
              ))}
            </Section>

            {selected.strategy.filters.length > 0 && (
              <Section title={t("instruments.quantlab.filtersSection")}>
                {selected.strategy.filters.map((f) => (
                  <Clause key={f.kind}>{filterLine(f, t)}</Clause>
                ))}
              </Section>
            )}

            <Section title={t("instruments.quantlab.executionSection")}>
              <Clause>{entryLine(selected.strategy, t)}</Clause>
              <Clause>{t("instruments.quantlab.hold", { sessions: selected.strategy.hold.sessions.join(" / ") })}</Clause>
              <Clause>{directionLine(selected.strategy, t)}</Clause>
              <Clause>
                {selected.strategy.universe.tickers === "tracked"
                  ? t("instruments.quantlab.universeTracked", { n: selected.strategy.universe.min_history_sessions })
                  : t("instruments.quantlab.universeList", {
                      tickers: (selected.strategy.universe.tickers as string[]).join(" "),
                      n: selected.strategy.universe.min_history_sessions,
                    })}
              </Clause>
            </Section>

            {selected.strategy.notes && (
              <Section title={t("instruments.quantlab.whatThisTests")}>
                <p className="font-baskerville text-[14px] leading-relaxed text-[#4b5563]">
                  {selected.strategy.notes}
                </p>
              </Section>
            )}

            <Section title={t("instruments.quantlab.versionHistory")}>
              <div className="flex flex-wrap gap-1.5">
                {selected.versions.map((v) => (
                  <span
                    key={v}
                    className={`rounded px-2 py-0.5 text-[11px] tabular-nums ${
                      v === selected.strategy.version ? "bg-[#1d1b1b] text-white" : "bg-[#e8e8e2] text-[#6b7280]"
                    }`}
                  >
                    v{v}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-[#9CA3AF]">
                {t("instruments.quantlab.versionNote")}
              </p>
              {selected.strategy.created_after_oos_view && (
                <p className="mt-2 text-[11px] text-[#b23b3b]">
                  {t("instruments.quantlab.createdAfterOos")}
                </p>
              )}
            </Section>

            {selected.enable_blocked_reason && (
              <Section title={t("instruments.quantlab.liveEvaluation")}>
                <p className="text-[12px] text-[#6b7280]">
                  {t("instruments.quantlab.blocked", { reason: selected.enable_blocked_reason })}
                </p>
              </Section>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <div className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">{title}</div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}

function Clause({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[13px] text-[#4b5563]">
      <span className="select-none text-[#c8c8c2]">·</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
