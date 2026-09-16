import type { StrategyRow } from "../../../shared/quantlab-types";
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
  return (
    <>
      <div className="w-[340px] shrink-0 overflow-y-auto border-r border-[#e0e0da]">
        {strategies.length === 0 && (
          <div className="px-5 py-4 text-[12px] text-[#9CA3AF]">No strategies yet.</div>
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
                    LIVE
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-[#9CA3AF] tabular-nums">
                <span>v{row.strategy.version}</span>
                <span>·</span>
                <span>{row.runs} run{row.runs === 1 ? "" : "s"}</span>
                {!row.backtestable && (
                  <>
                    <span>·</span>
                    <span className="text-[#b23b3b]">not backtestable</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {!selected && <div className="px-6 py-5 text-[12px] text-[#9CA3AF]">Select a strategy.</div>}
        {selected && (
          <div className="px-6 py-5">
            <div className="flex items-start gap-4">
              <div className="min-w-0">
                <h2 className="font-baskerville text-[20px] text-[#1d1b1b]">{selected.strategy.name}</h2>
                <div className="mt-1 text-[11px] text-[#9CA3AF] tabular-nums">
                  {selected.strategy.strategy_id} · version {selected.strategy.version}
                  {selected.strategy.parent_version != null && ` (from v${selected.strategy.parent_version})`}
                  {" · "}
                  {selected.runs} backtest run{selected.runs === 1 ? "" : "s"}
                </div>
              </div>
              <button
                onClick={() => onRunBacktest(selected.strategy.strategy_id)}
                disabled={!selected.backtestable || busy === selected.strategy.strategy_id}
                className="ml-auto shrink-0 rounded-md bg-[#1d1b1b] px-3 py-1.5 text-[12px] text-white disabled:cursor-not-allowed disabled:bg-[#c8c8c2]"
              >
                {busy === selected.strategy.strategy_id ? "Running…" : "Run backtest"}
              </button>
            </div>

            {selected.unavailable.length > 0 && (
              <div className="mt-4 rounded-lg border border-[#e0d9c8] bg-[#faf6ec] px-4 py-3">
                <div className="text-[11px] font-medium tracking-[0.06em] text-[#8a7a55]">
                  UNAVAILABLE HISTORICALLY
                </div>
                {selected.unavailable.map((u) => (
                  <div key={u.component} className="mt-2 text-[12px] text-[#6b7280]">
                    <span className="text-[#4b5563]">{u.component}</span> — {u.reason}
                  </div>
                ))}
                {!selected.backtestable && (
                  <div className="mt-2 text-[12px] text-[#b23b3b]">
                    This strategy cannot be backtested. It can still be enabled for the live ledger once it has an
                    out-of-sample result — which, for this rule, means waiting for forward data.
                  </div>
                )}
              </div>
            )}

            <Section title="TRIGGER — all of these must hold">
              {triggerLines(selected.strategy.trigger).map((line, i) => (
                <Clause key={i}>{line}</Clause>
              ))}
            </Section>

            {selected.strategy.filters.length > 0 && (
              <Section title="FILTERS — all of these must also hold">
                {selected.strategy.filters.map((f) => (
                  <Clause key={f.kind}>{filterLine(f)}</Clause>
                ))}
              </Section>
            )}

            <Section title="EXECUTION">
              <Clause>{entryLine(selected.strategy)}</Clause>
              <Clause>
                hold {selected.strategy.hold.sessions.join(" / ")} sessions, exit on time only (no stops, no targets —
                each is an extra knob and the classic overfitting surface)
              </Clause>
              <Clause>{directionLine(selected.strategy)}</Clause>
              <Clause>
                universe:{" "}
                {selected.strategy.universe.tickers === "tracked"
                  ? "the tracked universe"
                  : (selected.strategy.universe.tickers as string[]).join(" ")}
                , at least {selected.strategy.universe.min_history_sessions} sessions of history
              </Clause>
            </Section>

            {selected.strategy.notes && (
              <Section title="WHAT THIS TESTS">
                <p className="font-baskerville text-[14px] leading-relaxed text-[#4b5563]">
                  {selected.strategy.notes}
                </p>
              </Section>
            )}

            <Section title="VERSION HISTORY">
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
                Every edit mints a new version rather than changing this one. The number of versions is the record of
                how much searching happened, and it is what the variant warning reads.
              </p>
              {selected.strategy.created_after_oos_view && (
                <p className="mt-2 text-[11px] text-[#b23b3b]">
                  This version was created after an out-of-sample result had been viewed.
                </p>
              )}
            </Section>

            {selected.enable_blocked_reason && (
              <Section title="LIVE EVALUATION">
                <p className="text-[12px] text-[#6b7280]">Blocked: {selected.enable_blocked_reason}</p>
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
