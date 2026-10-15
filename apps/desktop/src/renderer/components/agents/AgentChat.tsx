import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Agent, AgentMessage, AgentReport } from "../../../shared/agent-types";
import { clockTime, paragraphs, relativeTime, suggestedQuestions } from "./agent-format";
import { Kbd } from "./agent-ui";
import { sendAgentMessage } from "./agents-store";

/** `KeyboardEvent.key` for the return key, which the copy rules know is code. */
const ENTER = "Enter";

function Text({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((p, i) => (
        <p key={i} className="whitespace-pre-line">
          {p}
        </p>
      ))}
    </>
  );
}

/**
 * A conversation with the agent about what it has seen. Messages are plain
 * text; blank lines make paragraphs. Enter sends, Shift+Enter starts a new
 * line. While a reply is on its way the composer stays usable for drafting,
 * but a second send waits for the first.
 */
export default function AgentChat({
  agent,
  messages,
  reports,
  now,
  onOpenReport,
}: {
  agent: Agent;
  messages: readonly AgentMessage[];
  reports: readonly AgentReport[];
  now: number;
  onOpenReport: (reportId: string) => void;
}) {
  const { language: lang, t, tNodes } = useI18n();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Grows with what is typed, up to a point, then scrolls.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [draft]);

  // Follows the conversation to its newest line.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  useEffect(() => {
    input.current?.focus();
  }, [agent.id]);

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || pending) return;
    setPending(true);
    setError(null);
    setDraft("");
    const res = await sendAgentMessage(agent.id, body);
    setPending(false);
    if (!res.ok) {
      setError(res.error || t("agents.error.send"));
      setDraft((d) => d || body);
    }
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === ENTER && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  const titleOf = (id: string) => reports.find((r) => r.id === id)?.headline;
  const suggestions = messages.length === 0 ? suggestedQuestions(agent, reports, lang) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {messages.length === 0 ? (
          <div className="mx-auto max-w-[460px] pt-6 text-center">
            <p className="text-[14px] font-medium text-[#1d1b1b]">{t("agents.chat.emptyTitle")}</p>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-[#6b7280]">{t("agents.chat.emptyBody")}</p>
            <div className="mt-5 flex flex-col items-center gap-2">
              {suggestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={pending}
                  onClick={() => void send(q)}
                  className="app-no-drag rounded-xl border border-white/60 bg-white/55 px-3.5 py-2 text-left text-[12.5px] text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="space-y-5">
            {messages.map((m) =>
              m.role === "user" ? (
                <li key={m.id} className="flex flex-col items-end">
                  <div className="max-w-[78%] space-y-2 rounded-2xl rounded-br-md bg-[#1d1b1b]/[0.06] px-3.5 py-2 text-[13.5px] leading-[1.55] text-[#1d1b1b]">
                    <Text text={m.text} />
                  </div>
                  <time dateTime={m.at} className="mt-1 pr-1 text-[10.5px] tabular-nums text-[#9CA3AF]">
                    {m.id.startsWith("local:") && pending ? t("agents.chat.sending") : clockTime(m.at, lang)}
                  </time>
                </li>
              ) : (
                <li key={m.id} className="max-w-[88%]">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-[#9CA3AF]">
                    <span className="font-medium text-[#6b7280]">{agent.name}</span>
                    <time dateTime={m.at} className="tabular-nums">
                      {relativeTime(m.at, now, lang)}
                    </time>
                  </div>
                  <div className="space-y-2 text-[13.5px] leading-[1.65] text-[#1d1b1b]">
                    <Text text={m.text} />
                  </div>
                  {m.reportIds && m.reportIds.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.reportIds.map((id) =>
                        titleOf(id) ? (
                          <button
                            key={id}
                            type="button"
                            onClick={() => onOpenReport(id)}
                            className="app-no-drag max-w-[320px] truncate rounded-lg bg-black/[0.04] px-2 py-1 text-[11px] text-[#6b7280] transition-colors hover:bg-black/[0.06] hover:text-[#1d1b1b]"
                          >
                            {t("agents.chat.from", { title: titleOf(id) ?? "" })}
                          </button>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                </li>
              ),
            )}
            {pending ? (
              <li className="flex items-center gap-2 text-[12px] text-[#9CA3AF]" aria-live="polite">
                <span className="flex gap-1" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#1d1b1b]/30 motion-reduce:animate-none"
                      style={{ animationDelay: `${i * 160}ms` }}
                    />
                  ))}
                </span>
                {t("agents.chat.reading")}
              </li>
            ) : null}
          </ol>
        )}
      </div>

      <div className="shrink-0 border-t border-black/[0.06] px-5 pb-4 pt-3">
        {error ? <p className="pb-2 text-[12px] text-[#DC2626]">{error}</p> : null}
        <div className="flex items-end gap-2 rounded-2xl border border-white/60 bg-white/55 py-1.5 pl-3.5 pr-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] focus-within:bg-white/70">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={t("agents.chat.messageAria", { name: agent.name })}
            placeholder={t("agents.chat.placeholder", { name: agent.name })}
            className="app-no-drag scrollbar-meridian max-h-40 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-[1.5] text-[#1d1b1b] outline-none placeholder:text-[#9CA3AF]"
          />
          <button
            type="button"
            aria-label={t("agents.chat.send")}
            disabled={pending || !draft.trim()}
            onClick={() => void send(draft)}
            className="glass-cta cta-primary app-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-xl disabled:pointer-events-none disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          </button>
        </div>
        <div className={cn("flex items-center gap-1.5 pt-1.5 text-[10.5px] text-[#9CA3AF]")}>
          {tNodes("agents.chat.hint", { enter: <Kbd>{ENTER}</Kbd>, shift: <Kbd>Shift</Kbd> })}
        </div>
      </div>
    </div>
  );
}
