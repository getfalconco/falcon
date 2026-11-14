"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, GripHorizontal, PanelRight, X } from "lucide-react";
import { SESSION_ENDED, authHeaders } from "@/lib/workspace/api-auth";
import { ICON_BUTTON } from "../shell/ui";
import { useDragDock } from "../split/dnd";

/**
 * The help chat: a floating window or a docked pane over the same
 * conversation, which lasts for this page visit (module state, so switching
 * workspaces or docking keeps it). Answers stream from POST /api/help.
 */

export type HelpMessage = { role: "user" | "assistant"; content: string; error?: boolean };

type State = { messages: HelpMessage[]; busy: boolean; floating: boolean };

let state: State = { messages: [], busy: false, floating: false };
const listeners = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const SERVER: State = { messages: [], busy: false, floating: false };

export function useHelp(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER,
  );
}

export function setHelpFloating(floating: boolean) {
  set({ floating });
}

function patchLast(fn: (m: HelpMessage) => HelpMessage) {
  set((s) => ({ messages: s.messages.map((m, i) => (i === s.messages.length - 1 ? fn(m) : m)) }));
}

export async function askHelp(text: string, view: string) {
  const q = text.trim();
  if (!q || state.busy) return;
  const history = [...state.messages.filter((m) => !m.error), { role: "user" as const, content: q }].slice(-12).map(({ role, content }) => ({ role, content }));
  set((s) => ({ busy: true, messages: [...s.messages, { role: "user", content: q }, { role: "assistant", content: "" }] }));
  try {
    const res = await fetch("/api/help", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ messages: history, view }),
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      patchLast((m) => ({ ...m, content: res.status === 401 ? SESSION_ENDED : (body?.error ?? "Help is unavailable right now."), error: true }));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) patchLast((m) => ({ ...m, content: m.content + chunk }));
    }
  } catch {
    patchLast((m) => ({ ...m, content: m.content || "Help could not be reached. Check the connection and try again.", error: !m.content }));
  } finally {
    set({ busy: false });
  }
}

/** The reply as text, with **bold** kept as bold in case the model uses it anyway. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 ? <strong key={i} className="font-medium text-[#1d1b1b]">{p}</strong> : p))}</>;
}

const SUGGESTIONS = ["How do I read a Sighting?", "What does Weak evidence mean?", "How do workspaces work?"];

/** Messages and the input; used by both the floating window and the docked pane. */
export function HelpThread({ view, autoFocus = false }: { view: string; autoFocus?: boolean }) {
  const { messages, busy } = useHelp();
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = (t = text) => {
    if (!t.trim() || busy) return;
    setText("");
    void askHelp(t, view);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length ? (
          <div className="flex flex-col gap-3">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[#f4f4f2] px-3 py-1.5 text-[13.5px] leading-[20px] text-[#1d1b1b]">{m.content}</p>
                </div>
              ) : (
                <div key={i} className="flex flex-col gap-0.5">
                  <span className="text-[11.5px] font-medium text-[#8a8a85]">Falcon help</span>
                  <p className={`whitespace-pre-wrap text-[13.5px] leading-[20px] ${m.error ? "text-[#b3432f]" : "text-[#2d2b2a]"}`}>
                    {m.content ? <Rich text={m.content} /> : (busy && i === messages.length - 1 ? <span className="text-[#9a9a9a]">Thinking…</span> : null)}
                  </p>
                </div>
              ),
            )}
            <div ref={endRef} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px] leading-[20px] text-[#4b4b48]">Ask how Falcon works or what something on screen means. Information only, not investment advice.</p>
            <div className="flex flex-col items-start gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-lg border border-black/[0.1] px-2.5 py-1 text-left text-[12.5px] text-[#3d3b3a] outline-none transition-colors hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-black/20"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <form
        className="shrink-0 p-3 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-black/[0.12] bg-white px-3 py-2 focus-within:border-black/30">
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
            maxLength={2000}
            aria-label="Ask Falcon help"
            placeholder="Ask a question..."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            className="max-h-[120px] min-h-[22px] flex-1 resize-none bg-transparent text-[13.5px] leading-[20px] text-[#1d1b1b] outline-none placeholder:text-[#9a9a9a]"
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            aria-label="Send"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#1c1917] text-[rgb(231,231,231)] outline-none transition-colors hover:bg-[#0f0d0b] focus-visible:ring-2 focus-visible:ring-black/30 disabled:opacity-30"
          >
            <ArrowUp width={15} height={15} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </form>
    </div>
  );
}

const W = 360;
const H = 520;
const MARGIN = 12;

function clamp(p: { x: number; y: number }): { x: number; y: number } {
  if (typeof window === "undefined") return p;
  return {
    x: Math.min(Math.max(MARGIN, p.x), Math.max(MARGIN, window.innerWidth - W - MARGIN)),
    y: Math.min(Math.max(MARGIN, p.y), Math.max(MARGIN, window.innerHeight - H - MARGIN)),
  };
}

function readPos(key: string): { x: number; y: number } {
  const fallback = typeof window === "undefined" ? { x: 0, y: 0 } : { x: window.innerWidth - W - 28, y: window.innerHeight - H - 28 };
  try {
    const raw = localStorage.getItem(key);
    const p = raw ? (JSON.parse(raw) as { x?: unknown; y?: unknown }) : null;
    if (p && typeof p.x === "number" && typeof p.y === "number") return clamp({ x: p.x, y: p.y });
  } catch {
    // Storage blocked: start in the corner.
  }
  return clamp(fallback);
}

/** The floating help window: drag it by the header; drop it on the main area to dock it as a pane. */
export function FloatingHelp({ userId, view, onClose, onDock }: { userId: string; view: string; onClose: () => void; onDock: () => void }) {
  const key = `falcon.help.v1:${userId}`;
  const [pos, setPos] = useState(() => readPos(key));
  const posRef = useRef(pos);
  posRef.current = pos;
  const { begin } = useDragDock();

  const save = useCallback(
    (p: { x: number; y: number }) => {
      try {
        localStorage.setItem(key, JSON.stringify(p));
      } catch {
        // Storage blocked: the position lasts for this visit.
      }
    },
    [key],
  );

  // Remember where it was left, once it stops moving.
  useEffect(() => {
    const t = setTimeout(() => save(pos), 300);
    return () => clearTimeout(t);
  }, [pos, save]);

  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Falcon help"
      className="fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-black/10 bg-white text-[#1d1b1b] shadow-[0_18px_48px_rgba(0,0,0,0.16)]"
      style={{ left: pos.x, top: pos.y, width: W, height: H }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="flex h-11 shrink-0 cursor-grab touch-none items-center gap-2 border-b border-black/[0.08] pl-3 pr-1.5 active:cursor-grabbing"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const dx = e.clientX - posRef.current.x;
          const dy = e.clientY - posRef.current.y;
          begin(e, { target: "help", label: "Help", from: "float" }, { noGhost: true, onMove: (x, y) => setPos(clamp({ x: x - dx, y: y - dy })) });
        }}
      >
        <GripHorizontal width={15} height={15} strokeWidth={1.75} className="shrink-0 text-[#b0b0ab]" aria-hidden />
        <span className="flex-1 text-[14px] font-medium">Help</span>
        <button type="button" onClick={onDock} aria-label="Dock help to the right" title="Dock to the right" className={ICON_BUTTON}>
          <PanelRight width={16} height={16} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" onClick={onClose} aria-label="Close help" title="Close" className={ICON_BUTTON}>
          <X width={16} height={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <HelpThread view={view} autoFocus />
    </div>
  );
}
