"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, CircleAlert, ImageOff, Pencil, Plus, RotateCcw, Square, X } from "lucide-react";
import AIMessage from "@/components/ui/ai-message";
import { ICON_BUTTON } from "../shell/ui";
import { ASSISTANT_NAME, FalconBadge } from "./FalconMark";
import { EmptyState } from "./EmptyState";
import { SLASH_MENU_ID, SlashMenu, slashMatches, slashOptionId } from "./SlashMenu";
import { IMAGE_TYPES, ImageError, MAX_IMAGES, prepareImage } from "./images";
import type { PreparedImage } from "./images";
import { DeskAnnouncer } from "./Announcer";
import { Appear, DeskMotionStyles, useStickToBottom } from "./motion";
import { StreamingText } from "./StreamingText";
import { ReplyFooter, useReplySources } from "./ReplyFooter";
import type { MarkdownTerms } from "./Markdown";
import { GlossaryActions } from "./TermPopover";
import { explicitTermKeys, replyLang, termKeysIn } from "@/lib/desk/glossary-match";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ToolSegment } from "./ChartBlock";
import { RunChip, RunSplit, useRunPanel } from "./RunPanel";
import { AskCard } from "./AskCard";
import type { AskAnswer } from "@/lib/desk/ask";
import type { LabRun, RunScript } from "./run";
import { ScriptCard } from "./ScriptCard";
import { ChatCites } from "./PanelSources";
import { citeContext, type CiteCtx } from "./SourceCite";
import { panelFigures } from "@/lib/desk/citation-panel";
import { stripCitations, type CiteReport } from "@/lib/desk/citations";
import { imageKept, newId } from "./sessions";
import type { LabImage, LabMessage, LabSession, LabTool } from "./sessions";

/**
 * One Desk session with Falcon AI: header (back, title, session menu, side panel),
 * the thread and the composer. A new session opens on the Falcon AI greeting
 * with prompt cards (lab/EmptyState.tsx). Replies stream in (lab/sessions.ts);
 * the data lookups show as compact rows between the paragraphs (open one to
 * see the raw result). Replies can be copied and the last one regenerated; the
 * last message can be edited and sent again. Images attach with "+", paste or
 * drag and drop, up to four per message. Typing "/" opens the command menu
 * (lab/SlashMenu.tsx). The thread follows a reply only while the viewer is at
 * the bottom; "Jump to latest" brings them back. The "⋯" session menu next
 * to the title renames, pins or deletes the session.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/20";
const ROUND = `inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-line/[0.05] text-fore-4 transition-colors hover:bg-line/[0.09] hover:text-fore disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`;
const SOLID = `inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-fore text-surface transition-opacity hover:opacity-85 disabled:pointer-events-none disabled:opacity-25 ${FOCUS}`;
const MAX_INPUT = 240;
const MAX_TITLE = 80;
const NO_MESSAGES: LabMessage[] = [];

type Pending = { id: string; preview: string; ready?: PreparedImage; failed?: boolean };

export function LabChat({
  session,
  title,
  onBack,
  onSend,
  onStop,
  onRetry,
  onVote,
  onAnswer,
  onRename,
  pinned: isPinned,
  onPin,
  onDelete,
  onEdit,
  headerExtra,
  replyExtra,
  initialText,
}: {
  /** Undefined until the first message is sent. */
  session: LabSession | undefined;
  title: string;
  onBack: () => void;
  onSend: (text: string, images: PreparedImage[]) => void;
  onStop: () => void;
  /** Asks again for this reply (cuts the thread back to the user turn before it). */
  onRetry: (replyId: string) => void;
  onVote: (replyId: string, vote: "up" | "down") => void;
  /** Answers the question card Claude asked in this reply (ask_user; lab/AskCard.tsx). */
  onAnswer?: (replyId: string, answers: AskAnswer[]) => void;
  onRename: (title: string) => void;
  pinned?: boolean;
  /** Pins or unpins the session (the "⋯" menu; hidden until the session exists). */
  onPin?: (pinned: boolean) => void;
  /** Deletes the session after a confirm in the "⋯" menu (hidden until the session exists). */
  onDelete?: () => void;
  /** Edits the viewer's last message and asks again (cuts the thread back to it). Hidden when not given. */
  onEdit?: (messageId: string, text: string) => void;
  headerExtra?: ReactNode;
  /** Extra UI under a finished reply's content (e.g. app action chips); return null for none. */
  replyExtra?: (m: LabMessage) => ReactNode;
  /** Composer text to start with ("Ask Falcon AI" buttons, lab/app-bridge.ts). */
  initialText?: string;
}) {
  const messages = session?.messages ?? NO_MESSAGES;
  const last = messages[messages.length - 1];
  const busy = last?.role === "assistant" && last.status === "streaming";
  // Strategy tests in this session with a result (lib/desk/run-result.ts); the results panel (lab/RunPanel.tsx) shows one of them.
  // Code that wrote no result (a chart, a calculation) only shows as cards in its reply.
  const runs = messages.flatMap((m) => (m.run?.result ? [m.run] : []));
  // A result that arrived in the reply streaming now: the panel opens for it once (useRunPanel).
  const liveResult = messages.find((m) => m.status === "streaming" && !m.tab && m.run?.result)?.run?.id;
  // Source citations (lib/desk/citations.ts): the session's tools with a source id, and each test's chat check for its panel.
  const sourceTools = useMemo(() => messages.flatMap((m) => (m.tools ?? []).filter((t) => t.src)), [messages]);
  const runCites = useMemo(() => new Map(messages.flatMap((m): [string, CiteReport][] => (m.run && m.cites ? [[m.run.id, m.cites]] : []))), [messages]);
  const panel = useRunPanel(runs, liveResult);
  const [text, setText] = useState(initialText ?? "");
  const [pending, setPending] = useState<Pending[]>([]);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  // "/" command menu: the matches for what is typed, the highlighted one, and Escape's dismissal.
  const [slashActive, setSlashActive] = useState(0);
  const [slashClosed, setSlashClosed] = useState<string | null>(null);
  const slashItems = text !== slashClosed ? slashMatches(text) : null;
  const slashOpen = !!slashItems;
  // The "Jump to latest" button shows when the viewer has scrolled up from the bottom.
  const [away, setAway] = useState(false);
  const lastUserId = [...messages].reverse().find((m) => m.role === "user")?.id;

  useEffect(() => {
    setSlashActive(0);
  }, [slashItems?.length]);

  const toBottom = (smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  };

  useEffect(() => {
    if (editing) titleInputRef.current?.select();
  }, [editing]);

  const startEdit = () => {
    cancelled.current = false;
    setDraft(title);
    setEditing(true);
  };
  const finishEdit = () => {
    if (!editing) return;
    setEditing(false);
    const t = draft.trim().slice(0, MAX_TITLE);
    if (!cancelled.current && t && t !== title) onRename(t);
    titleBtnRef.current?.focus();
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // Follow the reply while the viewer is at the bottom; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => {
    pinned.current = true;
    setAway(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  // ...and while a reply types out (it grows between updates).
  useStickToBottom(scrollRef, pinned);
  // Grow with the text up to MAX_INPUT, then scroll inside.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT)}px`;
  }, [text]);
  // Object URLs of the previews go when the composer does.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current.forEach((p) => URL.revokeObjectURL(p.preview)), []);

  const addFiles = (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) {
      if (files.length) setNotice("Only images can be attached for now.");
      return;
    }
    const room = MAX_IMAGES - pendingRef.current.length;
    const take = images.slice(0, Math.max(0, room));
    const bad = take.filter((f) => !IMAGE_TYPES.includes(f.type));
    const ok = take.filter((f) => IMAGE_TYPES.includes(f.type));
    setNotice(images.length > room ? `Up to ${MAX_IMAGES} images per message.` : bad.length ? "Only PNG, JPEG, WebP or GIF images can be attached." : "");
    const added: Pending[] = ok.map((f) => ({ id: newId(), preview: URL.createObjectURL(f) }));
    setPending((p) => [...p, ...added]);
    added.forEach((p, i) => {
      prepareImage(ok[i], p.id).then(
        (ready) => setPending((list) => list.map((x) => (x.id === p.id ? { ...x, ready } : x))),
        (error: unknown) => {
          setPending((list) => list.map((x) => (x.id === p.id ? { ...x, failed: true } : x)));
          setNotice(error instanceof ImageError ? error.message : "This image could not be prepared.");
        },
      );
    });
    inputRef.current?.focus();
  };

  const remove = (id: string) => {
    setPending((list) => {
      const p = list.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.preview);
      return list.filter((x) => x.id !== id);
    });
    setNotice("");
    inputRef.current?.focus();
  };

  const preparing = pending.some((p) => !p.ready && !p.failed);
  const ready = pending.filter((p) => p.ready).map((p) => p.ready as PreparedImage);
  const canSend = !busy && !preparing && (!!text.trim() || ready.length > 0);

  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), ready);
    setText("");
    pending.forEach((p) => URL.revokeObjectURL(p.preview));
    setPending([]);
    setNotice("");
  };

  // The glossary card's action rows: ask Falcon AI (sent now, or left in the composer while a reply streams) or prefill a command.
  const prefill = (t: string) => {
    setText(t);
    setSlashClosed(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(t.length, t.length);
    });
  };
  const glossary = { ask: (t: string) => (busy ? prefill(t) : onSend(t, [])), prefill };

  const pickSlash = (name: string) => {
    setText(`/${name} `);
    setSlashClosed(null);
    inputRef.current?.focus();
  };

  /** The composer's keys: the "/" menu first, then Enter to send (Shift+Enter is a new line; IME composition is left alone). */
  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (slashItems) {
      const n = slashItems.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pickSlash(slashItems[Math.min(slashActive, n - 1)]!.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashClosed(text);
        return;
      }
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <ChatCites.Provider value={runCites}>
    <RunSplit run={panel.run} open={panel.open} onClose={panel.close}>
    <div role="region" aria-label={`Falcon AI: ${title}`} data-term-panel className="flex min-h-0 flex-1 flex-col">
      <DeskMotionStyles />
      <DeskAnnouncer last={last} />
      <div data-pane-header className="flex h-14 shrink-0 items-center justify-between gap-2 pl-2.5 pr-5">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <button type="button" aria-label="Back to Falcon AI" title="Back to Falcon AI" onClick={onBack} className={ICON_BUTTON}>
            <ChevronLeft width={18} height={18} strokeWidth={1.75} aria-hidden />
          </button>
          <h1 className="-ml-1.5 w-max min-w-0 max-w-full text-fs-18 font-medium leading-fs-24 tracking-[-0.01em] text-fore">
            {editing ? (
              <input
                ref={titleInputRef}
                value={draft}
                maxLength={MAX_TITLE}
                aria-label="Rename session"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={finishEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    finishEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelled.current = true;
                    finishEdit();
                  }
                }}
                style={{ width: `${Math.max(draft.length, 6) + 3}ch` }}
                className="block min-w-0 max-w-full rounded-md bg-line/[0.06] px-1.5 py-0.5 text-fs-18 font-medium leading-fs-24 tracking-[-0.01em] text-fore outline-none ring-2 ring-line/20"
              />
            ) : (
              <button
                ref={titleBtnRef}
                type="button"
                aria-label="Rename session"
                title="Rename session"
                onClick={startEdit}
                className={`group flex max-w-full cursor-text items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-line/[0.06] ${FOCUS}`}
              >
                <span className="min-w-0 truncate underline decoration-transparent decoration-1 underline-offset-4 transition-colors group-hover:decoration-line/25">{title}</span>
                <Pencil width={13} height={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
            )}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerExtra}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-term-bounds
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          pinned.current = atBottom;
          if (atBottom === away) setAway(!atBottom);
        }}
      >
        {messages.length ? (
          <GlossaryActions.Provider value={glossary}>
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 py-6 sm:px-6" aria-busy={busy}>
            {messages.map((m) =>
              m.role === "user" ? (
                <UserMessage key={m.id} m={m} onEdit={onEdit && !busy && m.id === lastUserId ? (t) => onEdit(m.id, t) : undefined} />
              ) : (
                <Reply
                  key={m.id}
                  m={m}
                  isLast={m === last}
                  onRetry={() => onRetry(m.id)}
                  onVote={(v) => onVote(m.id, v)}
                  onAnswer={m === last && !busy && onAnswer ? (a) => onAnswer(m.id, a) : undefined}
                  runShown={panel.open && !!m.run && panel.run?.id === m.run.id}
                  onViewRun={(run) => panel.show(run.id)}
                  extra={replyExtra}
                  sourceTools={sourceTools}
                  onFollowUp={m === last ? (q) => onSend(q, []) : undefined}
                  followUpsDisabled={busy}
                />
              ),
            )}
          </div>
          </GlossaryActions.Provider>
        ) : (
          <EmptyState disabled={busy} onPick={(prompt) => onSend(prompt, [])} />
        )}
      </div>
      {away && messages.length ? (
        <button
          type="button"
          onClick={() => toBottom(true)}
          className={`absolute bottom-3 left-1/2 z-10 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-fore px-3 text-fs-12.5 font-medium text-surface shadow-[0_6px_20px_rgba(0,0,0,0.18)] transition-opacity hover:opacity-90 dark:shadow-[0_6px_20px_rgba(0,0,0,0.5)] ${FOCUS}`}
        >
          <ArrowDown width={13} height={13} strokeWidth={2} aria-hidden />
          {busy ? "Follow reply" : "Jump to latest"}
        </button>
      ) : null}
      </div>

      <form
        className="relative mx-auto w-full max-w-[720px] shrink-0 px-3 pb-4 pt-1 sm:px-6"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div
          className={`relative flex cursor-text flex-col rounded-[22px] border bg-surface-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors focus-within:border-line/[0.2] ${
            dragging ? "border-line/[0.35] ring-2 ring-line/15" : "border-line/[0.1]"
          }`}
          onClick={(e) => {
            if (e.target === e.currentTarget) inputRef.current?.focus();
          }}
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDragging(false);
            addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {slashItems ? <SlashMenu items={slashItems} active={Math.min(slashActive, slashItems.length - 1)} onHover={setSlashActive} onPick={(c) => pickSlash(c.name)} /> : null}
          {dragging ? (
            <div aria-hidden className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[21px] bg-surface/85 text-fs-13.5 font-medium text-fore-3">
              Drop images to attach
            </div>
          ) : null}
          {pending.length ? (
            <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attached images">
              {pending.map((p, i) => (
                <li key={p.id} className="group relative h-16 w-16 shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                  <img
                    src={p.preview}
                    alt={`Attached image ${i + 1}`}
                    className={`h-16 w-16 rounded-xl border border-line/[0.1] object-cover ${p.ready ? "" : "opacity-50"} ${p.failed ? "grayscale" : ""}`}
                  />
                  {!p.ready && !p.failed ? (
                    <span className="absolute inset-0 flex items-center justify-center" role="status" aria-label="Preparing image">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line/20 border-t-fore/70 motion-reduce:animate-none" />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Remove image ${i + 1}`}
                    title="Remove"
                    onClick={() => remove(p.id)}
                    className={`absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-line/[0.12] bg-surface text-fore-3 shadow-sm transition-colors hover:text-fore ${FOCUS}`}
                  >
                    <X width={12} height={12} strokeWidth={2} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={inputRef}
            value={text}
            rows={2}
            maxLength={8000}
            aria-label={`Message ${ASSISTANT_NAME}`}
            aria-autocomplete="list"
            aria-controls={slashOpen ? SLASH_MENU_ID : undefined}
            aria-activedescendant={slashItems ? slashOptionId(slashItems[Math.min(slashActive, slashItems.length - 1)]!.name) : undefined}
            aria-keyshortcuts="Enter Shift+Enter"
            placeholder={`Ask ${ASSISTANT_NAME} about a stock, or describe a strategy to test…`}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (!files.length) return;
              e.preventDefault();
              addFiles(files);
            }}
            onKeyDown={onComposerKey}
            className="block min-h-[64px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-fs-15 leading-fs-24 text-fore outline-none placeholder:text-faint-2"
          />
          {notice ? (
            <p role="status" className="px-4 pb-1 text-fs-12.5 text-quiet">
              {notice}
            </p>
          ) : null}
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
            <button
              type="button"
              aria-label="Attach images"
              title="Attach images"
              disabled={pending.length >= MAX_IMAGES}
              onClick={() => fileRef.current?.click()}
              className={ROUND}
            >
              <Plus width={17} height={17} strokeWidth={1.75} aria-hidden />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              hidden
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <span className="ml-auto hidden min-w-0 truncate text-fs-11.5 text-faint min-[420px]:inline" aria-hidden>
              {busy ? "Esc to stop" : preparing ? "Preparing image…" : text ? "Enter to send · Shift+Enter for a new line" : "/ for commands"}
            </span>
            {busy ? (
              <button type="button" aria-label="Stop reply" title="Stop (Esc)" onClick={onStop} className={`${SOLID} ml-auto min-[420px]:ml-0`}>
                <Square width={13} height={13} strokeWidth={0} fill="currentColor" aria-hidden />
              </button>
            ) : (
              <button type="submit" aria-label="Send" title="Send (Enter)" disabled={!canSend} className={`${SOLID} ml-auto min-[420px]:ml-0`}>
                <ArrowUp width={17} height={17} strokeWidth={2} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
    </RunSplit>
    </ChatCites.Provider>
  );
}

function Thumb({ img, alone }: { img: LabImage; alone: boolean }) {
  const kept = imageKept(img.id);
  const size = alone ? "max-h-[260px] max-w-[min(100%,360px)]" : "h-[120px] w-[120px] object-cover";
  if (!img.thumb)
    return (
      <span className="flex h-[88px] w-[120px] flex-col items-center justify-center gap-1 rounded-xl border border-line/[0.1] bg-well text-center text-fs-11.5 leading-fs-16 text-quiet">
        <ImageOff width={16} height={16} strokeWidth={1.75} aria-hidden />
        Image not kept after reload
      </span>
    );
  return (
    <figure className="flex flex-col items-end gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element -- small data: URL thumbnail */}
      <img src={img.thumb} alt="Attached image" width={img.w || undefined} height={img.h || undefined} className={`h-auto w-auto rounded-xl border border-line/[0.1] ${size}`} />
      {kept ? null : <figcaption className="text-fs-11.5 opacity-70">Image not kept after reload</figcaption>}
    </figure>
  );
}

/** "14:32" in the viewer's locale. */
function clock(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at);
}

function UserMessage({ m, onEdit }: { m: LabMessage; onEdit?: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT)}px`;
  }, [draft, editing]);
  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  if (!onEdit && editing) setEditing(false);
  const save = () => {
    const t = draft.trim();
    if (!t || !onEdit) return;
    setEditing(false);
    if (t !== m.text) onEdit(t);
  };
  if (editing && onEdit)
    return (
      <div className="ml-auto flex w-full max-w-[min(65ch,100%)] flex-col gap-2 rounded-2xl border border-line/[0.14] bg-surface-2 p-2.5 sm:w-[85%]">
        <textarea
          ref={ref}
          value={draft}
          maxLength={8000}
          aria-label="Edit message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(m.text);
              setEditing(false);
            }
          }}
          className="block w-full resize-none bg-transparent px-1.5 py-1 text-fs-15 leading-fs-24 text-fore outline-none"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(m.text);
              setEditing(false);
            }}
            className={`inline-flex h-8 items-center rounded-full px-3 text-fs-13 font-medium text-fore-3 transition-colors hover:bg-line/[0.06] hover:text-fore ${FOCUS}`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!draft.trim()}
            className={`inline-flex h-8 items-center rounded-full bg-fore px-3.5 text-fs-13 font-medium text-surface transition-opacity hover:opacity-85 disabled:opacity-30 ${FOCUS}`}
          >
            Send
          </button>
        </div>
      </div>
    );
  return (
    <Appear from="user" at={m.at}>
    <AIMessage
      from="user"
      copyText={m.text || undefined}
      onEdit={onEdit && m.text ? () => {
        setDraft(m.text);
        setEditing(true);
      } : undefined}
      timestamp={clock(m.at)}
      className="pl-[12%]"
    >
      <div className="flex flex-col items-end gap-2">
        {m.images?.length ? (
          <div className="flex flex-wrap justify-end gap-2">
            {m.images.map((img) => (
              <Thumb key={img.id} img={img} alone={m.images?.length === 1} />
            ))}
          </div>
        ) : null}
        {m.text ? <p className="w-full whitespace-pre-wrap break-words text-fs-15 leading-fs-24">{m.text}</p> : null}
      </div>
    </AIMessage>
    </Appear>
  );
}

type Part = { kind: "text"; text: string } | { kind: "tools"; tools: LabTool[] } | { kind: "script"; script: RunScript };

/**
 * The reply's text cut where its lookups and code happened: paragraphs, runs of tool rows and code cards
 * (lab/ScriptCard.tsx), in order. A card goes after the tool rows that came before it (`after`).
 */
function segments(text: string, tools: LabTool[], scripts: RunScript[] = []): Part[] {
  const out: Part[] = [];
  const items: ({ tool: LabTool } | { script: RunScript })[] = [];
  let k = 0;
  for (let i = 0; i <= tools.length; i++) {
    while (k < scripts.length && scripts[k]!.after <= i) items.push({ script: scripts[k++]! });
    if (i < tools.length) items.push({ tool: tools[i]! });
  }
  let pos = 0;
  for (const item of items) {
    const at = Math.min(Math.max("tool" in item ? item.tool.at : item.script.at, pos), text.length);
    if (at > pos) {
      if (text.slice(pos, at).trim()) out.push({ kind: "text", text: text.slice(pos, at) });
      pos = at;
    }
    if ("script" in item) {
      out.push({ kind: "script", script: item.script });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "tools") last.tools.push(item.tool);
    else out.push({ kind: "tools", tools: [item.tool] });
  }
  if (text.slice(pos).trim()) out.push({ kind: "text", text: text.slice(pos) });
  return out;
}

function Reply({
  m,
  isLast,
  onRetry,
  onVote,
  runShown = false,
  onViewRun,
  onAnswer,
  extra,
  sourceTools,
  onFollowUp,
  followUpsDisabled,
}: {
  m: LabMessage;
  /** The session's tools with a source id (a citation of an earlier reply's tool opens that one). */
  sourceTools?: LabTool[];
  /** Set on the last reply: asks one of its follow-up questions (lab/ReplyFooter.tsx). */
  onFollowUp?: (q: string) => void;
  followUpsDisabled?: boolean;
  isLast: boolean;
  extra?: (m: LabMessage) => ReactNode;
  onRetry: () => void;
  onVote: (v: "up" | "down") => void;
  runShown?: boolean;
  onViewRun?: (run: LabRun) => void;
  /** Set while this reply's question card can be answered (the last reply, nothing streaming). */
  onAnswer?: (answers: AskAnswer[]) => void;
}) {
  const streaming = m.status === "streaming";
  const failed = m.status === "error";
  const parts = segments(m.text, m.tools ?? [], m.run?.scripts);
  const lastPart = parts[parts.length - 1];
  // Glossary terms once the reply is done: one language for the whole reply, each term highlighted once across its text parts.
  const terms = useMemo(() => {
    if (streaming) return null;
    const lang = replyLang(m.text);
    const before = explicitTermKeys(m.text);
    return segments(m.text, m.tools ?? [], m.run?.scripts).map((p): MarkdownTerms | undefined => {
      if (p.kind !== "text") return undefined;
      const skip = new Set(before);
      termKeysIn(p.text).forEach((k) => before.add(k));
      return { lang, skip };
    });
  }, [m.text, m.tools, m.run?.scripts, streaming]);
  // Source citations once the reply is done (lib/desk/citations.ts; lab/SourceCite.tsx); a test's figures as its panel shows them.
  const cites = useMemo((): CiteCtx | undefined => {
    if (streaming) return undefined;
    const a = m.run?.audit;
    const panelFigs = m.run ? panelFigures({ headline: a?.headline, split: a?.split, whole: a?.whole, metrics: m.run.result?.metrics as Record<string, unknown> | undefined }) : undefined;
    return citeContext(m.cites, m.tools ?? [], sourceTools ?? m.tools ?? [], replyLang(m.text), panelFigs);
  }, [streaming, m.cites, m.tools, m.run, m.text, sourceTools]);
  // Still composing: nothing yet, or the lookups (or the code) are done and the answer has not started.
  const waiting = streaming && (!lastPart || (lastPart.kind === "tools" && lastPart.tools.every((t) => t.state === "done")) || (lastPart.kind === "script" && !!lastPart.script.done));
  // Sources for the inline chips and the footer's list; the footer fades in only when the reply finished here.
  const lang = replyLang(m.text);
  const sources = useReplySources(m, lang);
  const [liveHere] = useState(streaming);
  return (
    <Appear from="assistant" at={m.at}>
    <AIMessage
      from="assistant"
      bubble={false}
    >
      <div className="flex min-w-0 flex-col gap-3 break-words text-fs-15 leading-fs-26 text-fore-2 [font-variant-numeric:tabular-nums]">
        <div className="flex items-center gap-2 text-fs-13 font-medium leading-fs-20 text-fore">
          <FalconBadge size={22} />
          {ASSISTANT_NAME}
        </div>
        {parts.map((p, i) =>
          p.kind === "text" ? (
            <StreamingText key={`t${i}`} text={p.text} live={streaming} caret={i === parts.length - 1} terms={terms?.[i]} cites={cites} sources={sources.byId} />
          ) : p.kind === "script" ? (
            <ScriptCard key={`s${p.script.key}`} s={p.script} />
          ) : (
            <ToolSegment key={`x${i}`} tools={p.tools} all={m.tools ?? []} live={streaming} />
          ),
        )}
        {m.ask ? <AskCard ask={m.ask} answerable={!!onAnswer} onAnswer={onAnswer} /> : null}
        {m.run?.result && onViewRun ? <RunChip run={m.run} active={runShown} onOpen={() => onViewRun(m.run!)} /> : null}
        {!streaming && extra ? extra(m) : null}
        <ThinkingIndicator show={waiting} phase={lastPart ? "tools" : "start"} startedAt={m.at} />
        {m.status === "stopped" ? <span className="text-fs-12.5 text-faint">Stopped</span> : null}
        {failed ? (
          <div role="alert" className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-down/20 bg-down/[0.05] px-3 py-2.5 text-fs-13.5 leading-fs-20">
            <span className="flex min-w-0 flex-1 basis-[200px] items-start gap-2 text-fore-2">
              <CircleAlert width={15} height={15} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-down" />
              <span className="min-w-0">{m.error || "Something went wrong while answering."}</span>
            </span>
            <button
              type="button"
              onClick={onRetry}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-fore px-3 text-fs-13 font-medium text-surface transition-opacity hover:opacity-85 ${FOCUS}`}
            >
              <RotateCcw width={13} height={13} strokeWidth={1.75} aria-hidden />
              Retry
            </button>
          </div>
        ) : null}
        {!streaming && m.text ? (
          <ReplyFooter
            m={m}
            lang={lang}
            sources={sources.list}
            copyText={stripCitations(m.text)}
            onRetry={isLast && !failed ? onRetry : undefined}
            onVote={onVote}
            timestamp={clock(m.at)}
            onFollowUp={!failed && m.status !== "stopped" ? onFollowUp : undefined}
            followUpsDisabled={followUpsDisabled}
            animate={liveHere}
          />
        ) : null}
      </div>
    </AIMessage>
    </Appear>
  );
}
