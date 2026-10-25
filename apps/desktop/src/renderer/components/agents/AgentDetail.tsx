import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";
import { useI18n, useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Agent, AgentDraft } from "../../../shared/agent-types";
import AgentActivity from "./AgentActivity";
import AgentChat from "./AgentChat";
import AgentForm, { draftProblems } from "./AgentForm";
import AgentOverview from "./AgentOverview";
import AgentReports, { ReportsSkeleton } from "./AgentReports";
import { sayCount, sayLines, statusLabel, waitingLine } from "./agent-format";
import { BUTTON, SKELETON, StatusDot, TickerChip } from "./agent-ui";
import {
  loadAgentDetail,
  markAgentRead,
  removeAgent,
  runAgentNow,
  setAgentStatus,
  updateAgent,
  useAgents,
  type AgentSubview,
} from "./agents-store";

const VIEWS: ReadonlyArray<{ id: AgentSubview; label: MessageKey }> = [
  { id: "overview", label: "agents.view.overview" },
  { id: "reports", label: "agents.view.reports" },
  { id: "activity", label: "agents.view.activity" },
  { id: "chat", label: "agents.view.chat" },
];

function draftOf(a: Agent): AgentDraft {
  return {
    name: a.name,
    brief: a.brief,
    ticker: a.ticker,
    companyName: a.companyName,
    triggers: a.triggers,
    metrics: a.metrics,
    instructions: a.instructions,
    channels: a.channels,
    oneShot: a.oneShot,
  };
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className={cn(SKELETON, "h-16 w-full rounded-2xl")} />
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((k) => (
          <div key={k} className={cn(SKELETON, "h-[68px] rounded-2xl")} />
        ))}
      </div>
      <div className={cn(SKELETON, "h-3 w-[40%]")} />
      <div className={cn(SKELETON, "h-3 w-[56%]")} />
    </div>
  );
}

/**
 * One agent: a header with its state and the verbs (run now, pause or
 * resume, edit, delete), and four views under it. The reports view marks
 * the agent's reports read as it is opened.
 */
export default function AgentDetail({
  agent,
  view,
  onView,
  focusReportId,
  now,
  onDeleted,
}: {
  agent: Agent;
  view: AgentSubview;
  onView: (v: AgentSubview, reportId?: string) => void;
  focusReportId?: string;
  now: number;
  onDeleted: () => void;
}) {
  const snap = useAgents();
  const { language: lang, t } = useI18n();
  const entry = snap.details[agent.id];
  const detail = entry?.detail;
  const [busy, setBusy] = useState<null | "run" | "status" | "delete" | "save">(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState<AgentDraft | null>(null);
  const [tried, setTried] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadAgentDetail(agent.id);
    setNote(null);
    setEditing(null);
    setConfirmDelete(false);
  }, [agent.id]);

  // Opening the reports is reading them.
  useEffect(() => {
    if (view === "reports" && (agent.unread > 0 || snap.fresh[agent.id])) void markAgentRead(agent.id);
  }, [view, agent.id, agent.unread, snap.fresh]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // A notice from a verb fades on its own after a while.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), note.tone === "ok" ? 5000 : 9000);
    return () => clearTimeout(t);
  }, [note]);

  const run = async () => {
    setBusy("run");
    setNote(null);
    const res = await runAgentNow(agent.id);
    setBusy(null);
    if (!res.ok) return setNote({ tone: "error", text: res.error || t("agents.error.run") });
    const fallback = res.data.fired ? t("agents.notice.newReport") : t("agents.notice.nothingNew");
    setNote({ tone: "ok", text: sayLines(res.data.noteLines, lang, res.data.note || fallback) });
    if (res.data.fired && res.data.report) onView("reports", res.data.report.id);
  };

  const toggleStatus = async () => {
    setBusy("status");
    const res = await setAgentStatus(agent.id, agent.status === "paused" ? "active" : "paused");
    setBusy(null);
    if (!res.ok) setNote({ tone: "error", text: res.error || t("agents.error.status") });
  };

  const doDelete = async () => {
    setBusy("delete");
    const res = await removeAgent(agent.id);
    setBusy(null);
    if (!res.ok) {
      setConfirmDelete(false);
      return setNote({ tone: "error", text: res.error || t("agents.error.delete") });
    }
    onDeleted();
  };

  const saveEdit = async () => {
    if (!editing) return;
    setTried(true);
    if (draftProblems(editing, lang).length > 0) return;
    setBusy("save");
    const { notes: _notes, ...patch } = editing;
    void _notes;
    const res = await updateAgent(agent.id, {
      ...patch,
      name: patch.name.trim(),
      metrics: patch.metrics.filter((m) => m.label.trim()),
    });
    setBusy(null);
    if (!res.ok) return setNote({ tone: "error", text: res.error || t("agents.error.save") });
    setEditing(null);
    setNote({ tone: "ok", text: t("agents.notice.saved") });
  };

  const reports = detail?.reports ?? [];
  const canToggle = agent.status === "active" || agent.status === "paused" || agent.status === "error";

  if (editing) {
    const problems = tried ? draftProblems(editing, lang) : [];
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-black/[0.06] px-7 py-4">
          <h2 className="truncate text-[15px] font-medium text-content-primary">{t("agents.detail.editTitle", { name: agent.name })}</h2>
        </div>
        <div className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-[620px] space-y-6">
            <section className="space-y-2">
              <h3 className="select-none text-[11px] font-medium tracking-[0.04em] text-content-tertiary">{t("agents.yourBrief")}</h3>
              <textarea
                value={editing.brief}
                onChange={(e) => setEditing({ ...editing, brief: e.target.value })}
                rows={3}
                aria-label={t("agents.detail.briefAria")}
                className="app-no-drag w-full resize-none rounded-xl border border-white/60 bg-white/55 px-3 py-2 text-[13px] leading-[1.55] text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] focus:bg-white/75"
              />
              <p className="text-[11.5px] text-content-tertiary">{t("agents.detail.briefKept")}</p>
            </section>
            <AgentForm draft={editing} onChange={setEditing} />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-black/[0.06] px-7 py-3.5">
          {problems.length > 0 ? <p className="mr-auto truncate text-[12px] text-tone-warning">{problems[0]}</p> : null}
          {note?.tone === "error" ? <p className="mr-auto truncate text-[12px] text-tone-negative">{note.text}</p> : null}
          <button type="button" onClick={() => setEditing(null)} className={BUTTON}>
            {t("agents.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void saveEdit()}
            disabled={busy === "save"}
            className="glass-cta cta-primary app-no-drag h-8 px-4 text-[12.5px] font-medium disabled:opacity-60"
          >
            {busy === "save" ? t("agents.detail.saving") : t("agents.detail.save")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 px-7 pt-5">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[19px] font-medium text-content-primary">{agent.name}</h2>
              {agent.ticker ? <TickerChip ticker={agent.ticker} /> : null}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[12.5px] text-content-secondary">
              <StatusDot status={agent.status} />
              <span className="shrink-0">{statusLabel(agent.status, lang)}</span>
              <span aria-hidden className="text-content-tertiary">·</span>
              {agent.companyName ? (
                <>
                  <span className="min-w-[32px] shrink-[4] truncate" title={agent.companyName}>{agent.companyName}</span>
                  <span aria-hidden className="text-content-tertiary">·</span>
                </>
              ) : null}
              <span className="min-w-0 max-w-[70%] shrink-0 truncate">
                {agent.status === "active"
                  ? waitingLine(agent, now, lang)
                  : agent.oneShot
                    ? t("agents.oneShot")
                    : t("agents.detail.keepsWatching")}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy !== null || agent.status === "completed"}
              className={BUTTON}
              title={t("agents.detail.runTitle")}
            >
              {busy === "run" ? t("agents.detail.checking") : t("agents.detail.runNow")}
            </button>
            {canToggle ? (
              <button type="button" onClick={() => void toggleStatus()} disabled={busy !== null} className={BUTTON}>
                {agent.status === "paused" ? t("agents.detail.resume") : t("agents.detail.pause")}
              </button>
            ) : null}
            <div ref={menuRef} className="relative">
              <button
                type="button"
                aria-label={t("agents.detail.more")}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
                className={cn(BUTTON, "px-2")}
              >
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
              <AnimatePresence>
                {menuOpen ? (
                  <motion.div
                    role="menu"
                    {...DROPDOWN_FADE}
                    className="app-no-drag absolute right-0 top-full z-50 mt-2 w-44 rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
                  >
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setTried(false);
                        setEditing(draftOf(agent));
                      }}
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-content-primary transition-colors hover:bg-ink/[0.07]"
                    >
                      <Pencil className="h-[15px] w-[15px] text-content-body" strokeWidth={1.75} aria-hidden />
                      {t("agents.detail.edit")}
                    </button>
                    <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" />
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmDelete(true);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-tone-negative transition-colors hover:bg-tone-negative-fill/[0.10]"
                    >
                      <Trash2 className="h-[15px] w-[15px]" strokeWidth={1.75} aria-hidden />
                      {t("agents.detail.delete")}
                    </button>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {confirmDelete ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div role="alertdialog" aria-label={t("agents.detail.delete")} className="mt-3 flex items-center gap-3 rounded-2xl bg-tone-negative-soft px-4 py-2.5">
                <p className="min-w-0 flex-1 text-[12.5px] text-tone-negative">{t("agents.detail.confirmDelete", { name: agent.name })}</p>
                <button type="button" autoFocus onClick={() => setConfirmDelete(false)} className={BUTTON}>
                  {t("agents.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void doDelete()}
                  disabled={busy === "delete"}
                  className="app-no-drag rounded-lg bg-tone-negative-solid px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-tone-negative-solid/90 disabled:opacity-60"
                >
                  {busy === "delete" ? t("agents.detail.deleting") : t("agents.detail.deleteShort")}
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {note ? (
          <p role="status" className={cn("mt-2 text-[12px]", note.tone === "error" ? "text-tone-negative" : "text-content-secondary")}>
            {note.text}
          </p>
        ) : null}

        {/* Sub-views, drawn as the timeframe selector is: ink and a hairline under the open one. */}
        <div role="tablist" aria-label={t("agents.detail.views")} className="mt-4 flex items-center gap-6 border-b border-black/[0.06]">
          {VIEWS.map((v) => {
            const on = v.id === view;
            const count = v.id === "reports" ? reports.length : v.id === "chat" ? (detail?.messages.length ?? 0) : 0;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onView(v.id)}
                className={cn(
                  "app-no-drag relative flex items-center gap-1.5 pb-2.5 text-[13px] transition-colors",
                  on ? "text-content-primary" : "text-content-tertiary hover:text-content-secondary",
                )}
              >
                {t(v.label)}
                {v.id === "reports" && agent.unread > 0 ? (
                  <span aria-label={sayCount(lang, "agents.unreadCount", agent.unread)} className="h-1.5 w-1.5 rounded-full bg-ink" />
                ) : count > 0 ? (
                  <span className="text-[11px] tabular-nums text-content-tertiary">{count}</span>
                ) : null}
                {on ? <motion.span layoutId="agent-view-rule" aria-hidden className="absolute inset-x-0 -bottom-px h-px bg-ink" /> : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      {view === "chat" ? (
        <div className="min-h-0 flex-1">
          {detail ? (
            <AgentChat
              agent={agent}
              messages={detail.messages}
              reports={reports}
              now={now}
              onOpenReport={(id) => onView("reports", id)}
            />
          ) : entry?.status === "error" ? (
            <DetailError error={entry.error} id={agent.id} />
          ) : (
            <div className="px-7 py-6">
              <ReportsSkeleton />
            </div>
          )}
        </div>
      ) : (
        <div className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto px-7 py-6">
          {view === "overview" ? (
            <AgentOverview agent={agent} reportCount={detail ? reports.length : agent.lastFiredAt ? 1 : 0} now={now} />
          ) : !detail ? (
            entry?.status === "error" ? <DetailError error={entry.error} id={agent.id} /> : view === "reports" ? <ReportsSkeleton /> : <DetailSkeleton />
          ) : view === "reports" ? (
            <AgentReports
              reports={reports}
              now={now}
              focusId={focusReportId}
              freshId={snap.fresh[agent.id]}
              waitingText={waitingLine(agent, now, lang)}
            />
          ) : (
            <AgentActivity activity={detail.activity} now={now} onOpenReport={(id) => onView("reports", id)} />
          )}
        </div>
      )}
    </div>
  );
}

function DetailError({ error, id }: { error: string; id: string }) {
  const t = useT();
  return (
    <div className="space-y-2 py-8 text-center">
      <p className="text-[13px] text-content-secondary">{t("agents.detail.loadFailed")}</p>
      <p className="text-[12px] text-content-tertiary">{error}</p>
      <button type="button" onClick={() => void loadAgentDetail(id)} className={BUTTON}>
        {t("agents.tryAgain")}
      </button>
    </div>
  );
}
