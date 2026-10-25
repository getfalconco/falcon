import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Radar } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useHomeTabIsActive } from "@/lib/home-tab-activity";
import { isTypingTarget } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import AgentDetail from "./AgentDetail";
import AgentList from "./AgentList";
import AgentWizard from "./AgentWizard";
import { matchesQuery, sortAgents, type StatusFilter } from "./agent-format";
import type { WizardStart } from "./agent-wizard";
import { BUTTON, SKELETON, SURFACE, useNow } from "./agent-ui";
import { refreshAgents, useAgents, type AgentSubview } from "./agents-store";

/**
 * The tab sits in the page's scrolling column, under the greeting and the
 * tab strip. Its two panes scroll on their own, so it takes exactly the
 * height left in the window below where it starts, measured rather than
 * assumed: the rows above it belong to other code and may change.
 */
function useFillHeight(bottomGap: number): [React.RefCallback<HTMLDivElement>, number] {
  const [height, setHeight] = useState(560);
  const node = useRef<HTMLDivElement | null>(null);
  const measure = useCallback(() => {
    const el = node.current;
    if (!el) return;
    // Against the scrolling column the tab sits in (the page's <main>), as
    // if it were scrolled to the top; the window when there is none.
    const main = el.closest("main");
    const box = main?.getBoundingClientRect();
    const bottom = main && box ? box.top + main.clientHeight : window.innerHeight;
    const top = el.getBoundingClientRect().top + (main?.scrollTop ?? 0);
    setHeight(Math.max(440, Math.round(bottom - top - bottomGap)));
  }, [bottomGap]);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      measure();
    },
    [measure],
  );
  useLayoutEffect(() => {
    measure();
    const main = node.current?.closest("main");
    const ro = typeof ResizeObserver !== "undefined" && main ? new ResizeObserver(measure) : null;
    if (ro && main) ro.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);
  return [ref, height];
}

type Mode = { kind: "agent"; view: AgentSubview; reportId?: string };

/**
 * Agents: the list on the left, the selected agent on the right. Arrow keys
 * move through the list, N starts a new agent when the reader is not typing,
 * and requests from elsewhere in the app (a dashboard row, a notification,
 * an earnings row's "Create agent") arrive through the store's `focus`.
 *
 * Creating an agent is always the Create Agent modal (AgentWizard), from New
 * agent, N, a create request, or by itself over the empty state when there
 * are no agents yet. Closing it leaves the empty state's Create agent button,
 * which opens it again where the reader left it.
 */
export default function AgentsTab() {
  const snap = useAgents();
  const now = useNow();
  const t = useT();
  const [fillRef, height] = useFillHeight(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "agent", view: "overview" });
  const [wizardOpen, setWizardOpen] = useState(false);
  /** A brief handed in from elsewhere (an earnings row), for the wizard to start from. */
  const [wizardBrief, setWizardBrief] = useState<WizardStart | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => sortAgents(snap.agents), [snap.agents]);
  const visible = useMemo(
    () => sorted.filter((a) => (filter === "all" || a.status === filter) && matchesQuery(a, query)),
    [sorted, filter, query],
  );
  const selected = snap.agents.find((a) => a.id === selectedId) ?? null;

  /** An agent with unread reports opens on them; any other on its overview. */
  const select = useCallback(
    (id: string, view?: AgentSubview, reportId?: string) => {
      const agent = snap.agents.find((a) => a.id === id);
      setSelectedId(id);
      setMode({ kind: "agent", view: view ?? (agent && agent.unread > 0 ? "reports" : "overview"), reportId });
    },
    [snap.agents],
  );

  // Requests from outside the tab. Applied once each, by sequence number.
  const appliedSeq = useRef(0);
  useEffect(() => {
    const f = snap.focus;
    if (!f || f.seq === appliedSeq.current) return;
    if (f.kind === "agent" && snap.phase !== "ready" && !snap.agents.some((a) => a.id === f.id)) return;
    appliedSeq.current = f.seq;
    if (f.kind === "create") {
      if (f.brief) setWizardBrief({ text: f.brief, ...(f.name ? { name: f.name } : {}), ...(f.draft ? { draft: f.draft } : {}), seq: f.seq });
      setWizardOpen(true);
      return;
    }
    setFilter("all");
    setQuery("");
    select(f.id, f.view, f.reportId);
  }, [snap.focus, snap.phase, snap.agents, select]);

  // Something is always selected while there is something to select.
  useEffect(() => {
    if (snap.phase !== "ready") return;
    if (selectedId && snap.agents.some((a) => a.id === selectedId)) return;
    const first = visible[0] ?? sorted[0];
    if (first) select(first.id);
    else setSelectedId(null);
  }, [snap.phase, snap.agents, selectedId, visible, sorted, select]);

  const step = useCallback(
    (delta: 1 | -1) => {
      if (visible.length === 0) return;
      const at = visible.findIndex((a) => a.id === selectedId);
      const next = visible[Math.min(visible.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
      if (next) {
        select(next.id);
        listRef.current?.focus();
      }
    },
    [visible, selectedId, select],
  );

  // No agents: the wizard opens by itself, each time the list becomes empty.
  const none = snap.phase === "ready" && snap.agents.length === 0;
  useEffect(() => {
    if (none) setWizardOpen(true);
  }, [none]);
  const closeWizard = useCallback(() => setWizardOpen(false), []);
  const onWizardCreated = useCallback((agent: { id: string }) => {
    setWizardOpen(false);
    setFilter("all");
    setQuery("");
    setSelectedId(agent.id);
    setMode({ kind: "agent", view: "overview" });
  }, []);

  // N for a new agent, and the arrows when nothing in particular has focus;
  // only while this tab is in front (the home page keeps it mounted behind the others).
  const isActive = useHomeTabIsActive();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive()) return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if ((e.key === "n" || e.key === "N") && !e.shiftKey) {
        e.preventDefault();
        setWizardOpen(true);
        return;
      }
      const idle = document.activeElement === document.body || document.activeElement === null;
      if (idle && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        step(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, isActive]);

  // The wizard sits in the same place in every state, so it keeps what was
  // typed while it is closed and fades out over the list it just filled.
  const shell = (children: React.ReactNode) => (
    <div ref={fillRef} className="app-no-drag px-8 pb-6 pt-5" style={{ height }}>
      {children}
      <AgentWizard open={wizardOpen} onClose={closeWizard} onCreated={onWizardCreated} initialBrief={wizardBrief} />
    </div>
  );

  if (snap.phase === "unavailable") {
    return shell(
      <div className={cn(SURFACE, "flex h-full flex-col items-center justify-center px-8 text-center")}>
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.04] text-content-body">
          <Radar className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </span>
        <p className="mt-4 text-[15px] font-medium text-content-primary">{t("agents.tab.unavailableTitle")}</p>
        <p className="mt-1.5 max-w-[420px] text-[13px] leading-[1.55] text-content-secondary">{t("agents.tab.unavailableBody")}</p>
      </div>,
    );
  }

  const loading = snap.agents.length === 0 && (snap.phase === "loading" || snap.phase === "idle");
  const failed = snap.phase === "error" && snap.agents.length === 0;

  if (none) {
    return shell(
      // While the modal is open its content is hidden, so nothing of it shows through the panel's glass.
      <div className={cn(SURFACE, "flex h-full flex-col items-center justify-center px-8 text-center", wizardOpen && "[&>*]:invisible")} aria-hidden={wizardOpen || undefined}>
        <p className="text-[15px] font-medium text-content-primary">{t("agents.tab.emptyTitle")}</p>
        <p className="mt-1.5 max-w-[420px] text-[13px] leading-[1.55] text-content-secondary">{t("agents.tab.emptyBody")}</p>
        <button type="button" onClick={() => setWizardOpen(true)} className="glass-cta app-no-drag mt-5 h-9 px-5 text-[12.5px] font-medium">
          {t("agents.create.create")}
        </button>
      </div>,
    );
  }

  let main: React.ReactNode;
  if (failed) {
    main = (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <p className="text-[14px] font-medium text-content-primary">{t("agents.tab.loadFailed")}</p>
        {snap.error ? <p className="mt-1 text-[12.5px] text-content-tertiary">{snap.error}</p> : null}
        <button type="button" onClick={() => void refreshAgents()} className={cn(BUTTON, "mt-4")}>
          {t("agents.tryAgain")}
        </button>
      </div>
    );
  } else if (loading) {
    main = (
      <div className="space-y-4 px-7 py-6" aria-hidden>
        <div className={cn(SKELETON, "h-5 w-[38%]")} />
        <div className={cn(SKELETON, "h-3 w-[52%]")} />
        <div className={cn(SKELETON, "mt-6 h-20 w-full rounded-2xl")} />
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((k) => (
            <div key={k} className={cn(SKELETON, "h-[68px] rounded-2xl")} />
          ))}
        </div>
      </div>
    );
  } else if (selected) {
    main = (
      <AgentDetail
        key={selected.id}
        agent={selected}
        view={mode.view}
        focusReportId={mode.reportId}
        now={now}
        onView={(view, reportId) => setMode({ kind: "agent", view, reportId })}
        onDeleted={() => setSelectedId(null)}
      />
    );
  } else {
    main = (
      <div className="flex h-full items-center justify-center text-[13px] text-content-tertiary">
        {visible.length === 0 ? t("agents.tab.noMatchFilter") : t("agents.tab.pick")}
      </div>
    );
  }

  return shell(
    <div className="flex h-full min-h-0 gap-4">
      <aside className={cn(SURFACE, "flex w-[272px] shrink-0 flex-col overflow-hidden")} aria-label={t("agents.tab.yourAgents")}>
        <AgentList
          ref={listRef}
          agents={visible}
          all={snap.agents}
          loading={loading}
          selectedId={selectedId}
          creating={wizardOpen}
          query={query}
          filter={filter}
          fresh={snap.fresh}
          now={now}
          onQuery={setQuery}
          onFilter={setFilter}
          onSelect={(id) => select(id)}
          onNew={() => setWizardOpen(true)}
          onStep={step}
        />
      </aside>
      <section className={cn(SURFACE, "min-w-0 flex-1 overflow-hidden")} aria-label={selected?.name ?? t("agents.tab.agent")}>
        {main}
      </section>
    </div>,
  );
}
