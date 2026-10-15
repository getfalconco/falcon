import { forwardRef, useEffect, useRef, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Agent, AgentStatus } from "../../../shared/agent-types";
import { statusLabel, waitingLine, type StatusFilter } from "./agent-format";
import { FIELD, Kbd, SKELETON, StatusDot, TickerChip, UnreadBadge } from "./agent-ui";

const FILTERS: readonly StatusFilter[] = ["all", "active", "paused", "completed", "error"];

function ListSkeleton() {
  return (
    <div className="space-y-1 px-2 pt-1" aria-hidden>
      {["w-[64%]", "w-[52%]", "w-[70%]", "w-[46%]"].map((w) => (
        <div key={w} className="space-y-1.5 rounded-xl px-2.5 py-2.5">
          <div className={cn(SKELETON, "h-3", w)} />
          <div className={cn(SKELETON, "h-2.5 w-[40%]")} />
        </div>
      ))}
    </div>
  );
}

type Props = {
  agents: readonly Agent[];
  /** Every agent, before the filter: for the per-status counts. */
  all: readonly Agent[];
  loading: boolean;
  selectedId: string | null;
  creating: boolean;
  query: string;
  filter: StatusFilter;
  fresh: Readonly<Record<string, string>>;
  now: number;
  onQuery: (q: string) => void;
  onFilter: (f: StatusFilter) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Moves the selection by one; the list owns the arrows while it has focus. */
  onStep: (delta: 1 | -1) => void;
};

/**
 * The Agents tab's left column: search, a status filter, and one row per
 * agent. Rows form a listbox: the arrows move the selection, and the
 * selected row follows into view.
 */
const AgentList = forwardRef<HTMLDivElement, Props>(function AgentList(
  { agents, all, loading, selectedId, creating, query, filter, fresh, now, onQuery, onFilter, onSelect, onNew, onStep },
  listRef,
) {
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  const { language: lang, t, tNodes } = useI18n();

  useEffect(() => {
    if (!selectedId) return;
    rows.current[selectedId]?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    onStep(e.key === "ArrowDown" ? 1 : -1);
  };

  const count = (status: AgentStatus) => all.filter((a) => a.status === status).length;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="space-y-2.5 px-4 pb-3 pt-4">
        <button
          type="button"
          onClick={onNew}
          aria-pressed={creating}
          className="glass-cta app-no-drag flex h-9 w-full items-center justify-center gap-1.5 text-[12.5px] font-medium"
        >
          {t("agents.newAgent")}
          <span className="ml-1 rounded bg-white/15 px-1 font-sans text-[10.5px] font-medium opacity-70">N</span>
        </button>
        <label className="relative block">
          <span className="sr-only">{t("agents.list.search")}</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9CA3AF]" strokeWidth={2} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                onStep(1);
              }
              if (e.key === "Escape" && query) {
                e.preventDefault();
                onQuery("");
              }
            }}
            placeholder={t("agents.list.search")}
            className={cn(FIELD, "h-8 pl-8 text-[12.5px]")}
          />
        </label>
        <div role="radiogroup" aria-label={t("agents.list.status")} className="flex flex-wrap gap-1">
          {FILTERS.map((value) => {
            const label = value === "all" ? t("agents.filter.all") : statusLabel(value, lang);
            const on = value === filter;
            const n = value === "all" ? all.length : count(value);
            if (value !== "all" && value !== "active" && n === 0 && !on) return null;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onFilter(value)}
                className={cn(
                  "app-no-drag inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11.5px] transition-colors duration-150",
                  on ? "bg-[#1d1b1b]/[0.08] font-medium text-[#1d1b1b]" : "text-[#6b7280] hover:bg-black/[0.04] hover:text-[#1d1b1b]",
                )}
              >
                {label}
                <span className="tabular-nums text-[#9CA3AF]">{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div aria-hidden className="mx-4 h-px shrink-0 bg-black/[0.06]" />

      <div
        ref={listRef}
        role="listbox"
        aria-label={t("agents.list.label")}
        tabIndex={agents.length > 0 ? 0 : -1}
        aria-activedescendant={selectedId ? `agent-row-${selectedId}` : undefined}
        onKeyDown={onKeyDown}
        className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto px-2 py-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-black/[0.06]"
      >
        {loading ? (
          <ListSkeleton />
        ) : agents.length === 0 ? (
          <p className="px-3 py-4 text-[12px] leading-[1.5] text-[#9CA3AF]">
            {all.length === 0 ? t("agents.list.emptyAll") : t("agents.list.noMatch")}
          </p>
        ) : (
          agents.map((agent) => {
            const on = agent.id === selectedId && !creating;
            const isFresh = Boolean(fresh[agent.id]);
            return (
              <div
                key={agent.id}
                id={`agent-row-${agent.id}`}
                ref={(el) => {
                  rows.current[agent.id] = el;
                }}
                role="option"
                aria-selected={on}
                onClick={() => onSelect(agent.id)}
                className={cn(
                  "app-no-drag relative cursor-pointer rounded-xl px-2.5 py-2 transition-colors duration-300",
                  on ? "bg-white/70 shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-black/[0.06]" : "hover:bg-black/[0.04]",
                  !on && isFresh && "bg-[#1d1b1b]/[0.04]",
                )}
              >
                <div className="flex items-center gap-2">
                  <StatusDot status={agent.status} />
                  <span className={cn("min-w-0 flex-1 truncate text-[13px] text-[#1d1b1b]", agent.unread > 0 && "font-medium")}>
                    {agent.name}
                  </span>
                  {agent.ticker ? <TickerChip ticker={agent.ticker} /> : null}
                  <UnreadBadge count={agent.unread} />
                </div>
                <div
                  className={cn(
                    "mt-0.5 truncate pl-[15px] text-[11.5px]",
                    agent.status === "error" ? "text-[#DC2626]" : "text-[#6b7280]",
                  )}
                >
                  {waitingLine(agent, now, lang)}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-4 pb-3 pt-2 text-[11px] text-[#9CA3AF]">
        {tNodes("agents.list.move", { up: <Kbd>↑</Kbd>, down: <Kbd>↓</Kbd> })}
      </div>
    </div>
  );
});

export default AgentList;
