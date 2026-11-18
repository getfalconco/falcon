"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react";
import { Dropdown } from "../shell/ui";
import type { MenuGroup } from "../shell/ui";
import { LAB_NEW_LABEL } from "./sessions";
import { ASSISTANT_NAME, FalconMark } from "./FalconMark";
import type { LabSession } from "./sessions";

/**
 * The Desk grid: the New card, then the sessions (pinned first). Each card has
 * a "⋯" menu (pin, rename, move, delete) shown on hover or focus. Press and
 * hold a card (250 ms) to drag it to a new place within its group; Alt+Left
 * and Alt+Right move a focused card. A plain click opens the session. The
 * search box filters by title and message text (moving is off while a search
 * is on). Each card shows the latest message and when the session was last used.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/20";
const CARD = `flex h-[140px] w-full min-w-0 rounded-xl border border-line/[0.1] bg-surface text-left transition-colors hover:border-line/[0.16] hover:bg-line/[0.025] ${FOCUS}`;
const HOLD_MS = 250;
/** Moving this far before the hold completes means a scroll or a selection, not a drag. */
const SLOP_PX = 6;
const SETTLE_MS = 180;
const MAX_TITLE = 80;

type Drag = {
  id: string;
  /** The group's ids in order when the drag began. */
  ids: string[];
  rects: DOMRect[];
  /** The grid's box, for placing the drop placeholder. */
  origin: { left: number; top: number };
  from: number;
  to: number;
  dx: number;
  dy: number;
  dropping: boolean;
  reduced: boolean;
};

type Hold = { id: string; x: number; y: number; pointerId: number; el: HTMLElement; timer: number };

/** The latest message as plain text (Markdown marks dropped), for the card. */
function preview(s: LabSession): { who: string; text: string } {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]!;
    const text = plain(m.text);
    if (text || m.images?.length) return { who: m.role === "user" ? "You" : ASSISTANT_NAME, text: text || "Image" };
  }
  return { who: "", text: "" };
}

function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/[*_`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "just now", "5m ago", "3h ago", "Yesterday", "Mon", "12 Mar". */
function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return "Yesterday";
  if (s < 604800) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at);
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: new Date(at).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" }).format(at);
}

function matches(s: LabSession, q: string): boolean {
  if (s.title.toLowerCase().includes(q)) return true;
  return s.messages.some((m) => m.text.toLowerCase().includes(q));
}

export function SessionGrid({
  sessions,
  onNew,
  onOpen,
  onRename,
  onPin,
  onMove,
  onDelete,
}: {
  sessions: LabSession[];
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  /** Moves a session to `index` within its own group (pinned or not). */
  onMove: (id: string, index: number) => void;
  onDelete: (id: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const holdRef = useRef<Hold | null>(null);
  const startPoint = useRef({ x: 0, y: 0 });
  const suppressClick = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? sessions.filter((s) => matches(s, q)) : sessions;
  const refocus = useRef<string | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const groupOf = useCallback((id: string) => {
    const s = sessions.find((x) => x.id === id);
    return sessions.filter((x) => !!x.pinned === !!s?.pinned);
  }, [sessions]);

  const cardEl = (id: string) => gridRef.current?.querySelector<HTMLElement>(`[data-session-card="${CSS.escape(id)}"]`) ?? null;

  // Keep focus on a card the keyboard just moved (the DOM node moves with it).
  useEffect(() => {
    if (!refocus.current) return;
    cardEl(refocus.current)?.querySelector<HTMLElement>("[data-card-main]")?.focus();
    refocus.current = null;
  });

  const update = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const endListeners = useRef<() => void>(() => {});

  const finish = useCallback((commit: boolean) => {
    const d = dragRef.current;
    endListeners.current();
    if (!d) return;
    if (!commit || d.to === d.from) {
      update(null);
      return;
    }
    update({ ...d, dropping: true });
    window.setTimeout(
      () => {
        onMoveRef.current(d.id, d.to);
        setAnnounce(`Moved to position ${d.to + 1} of ${d.ids.length}.`);
        update(null);
      },
      d.reduced ? 0 : SETTLE_MS,
    );
  }, []);

  const startDrag = useCallback(() => {
    const h = holdRef.current;
    holdRef.current = null;
    if (!h) return;
    const ids = groupOf(h.id).map((s) => s.id);
    const rects = ids.map((id) => cardEl(id)?.getBoundingClientRect() ?? new DOMRect());
    const from = ids.indexOf(h.id);
    if (from < 0) return;
    try {
      h.el.setPointerCapture(h.pointerId);
    } catch {
      // the pointer is already gone
    }
    suppressClick.current = h.id;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const g = gridRef.current?.getBoundingClientRect();
    update({ id: h.id, ids, rects, origin: { left: g?.left ?? 0, top: g?.top ?? 0 }, from, to: from, dx: 0, dy: 0, dropping: false, reduced });
    // Moves are measured from where the pointer went down.
    startPoint.current = { x: h.x, y: h.y };
  }, [groupOf]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || renaming || confirming || dragRef.current) return;
    if ((e.target as HTMLElement).closest('[data-no-drag], [role="menu"]')) return;
    suppressClick.current = null;
    const el = e.currentTarget;
    const hold: Hold = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, el, timer: window.setTimeout(() => startDrag(), HOLD_MS) };
    holdRef.current = hold;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== hold.pointerId) return;
      const d = dragRef.current;
      if (!d) {
        if (holdRef.current && Math.hypot(ev.clientX - hold.x, ev.clientY - hold.y) > SLOP_PX) cancelHold();
        return;
      }
      if (d.dropping) return;
      const dx = ev.clientX - startPoint.current.x;
      const dy = ev.clientY - startPoint.current.y;
      const r = d.rects[d.from];
      const cx = r.left + r.width / 2 + dx;
      const cy = r.top + r.height / 2 + dy;
      let to = d.from;
      let best = Infinity;
      d.rects.forEach((q, i) => {
        const dist = Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy);
        if (dist < best) {
          best = dist;
          to = i;
        }
      });
      update({ ...d, dx, dy, to });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== hold.pointerId) return;
      if (dragRef.current) {
        finish(ev.type === "pointerup");
        // The click that follows this release is swallowed; a later click or Enter opens the card as usual.
        window.setTimeout(() => {
          suppressClick.current = null;
        }, 0);
      } else cancelHold();
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && dragRef.current) {
        ev.preventDefault();
        finish(false);
      }
    };
    // While dragging on a touch screen, the page must not scroll under the finger.
    const touch = (ev: TouchEvent) => {
      if (dragRef.current) ev.preventDefault();
    };
    const cancelHold = () => {
      window.clearTimeout(hold.timer);
      if (holdRef.current === hold) holdRef.current = null;
      if (!dragRef.current) endListeners.current();
    };
    endListeners.current();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    window.addEventListener("touchmove", touch, { passive: false });
    endListeners.current = () => {
      window.clearTimeout(hold.timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      window.removeEventListener("touchmove", touch);
      endListeners.current = () => {};
    };
  };

  useEffect(() => () => endListeners.current(), []);

  const moveBy = (id: string, delta: number) => {
    const group = groupOf(id);
    const i = group.findIndex((s) => s.id === id);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= group.length) return;
    refocus.current = id;
    onMove(id, to);
    setAnnounce(`Moved to position ${to + 1} of ${group.length}.`);
  };

  /** Where each card of the dragged group is drawn while dragging. */
  const styleFor = (id: string): CSSProperties | undefined => {
    if (!drag) return undefined;
    const from = drag.ids.indexOf(id);
    if (from < 0) return undefined;
    const ease = drag.reduced ? undefined : `transform ${SETTLE_MS}ms cubic-bezier(.2,.8,.2,1)`;
    if (id === drag.id) {
      const to = drag.rects[drag.to];
      const at = drag.rects[drag.from];
      return drag.dropping
        ? { transform: `translate3d(${to.left - at.left}px, ${to.top - at.top}px, 0)`, transition: ease, zIndex: 10, position: "relative" }
        : { transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0) scale(${drag.reduced ? 1 : 1.03})`, zIndex: 10, position: "relative", cursor: "grabbing" };
    }
    const order = drag.ids.filter((x) => x !== drag.id);
    order.splice(drag.to, 0, drag.id);
    const slot = drag.rects[order.indexOf(id)];
    const home = drag.rects[from];
    return { transform: `translate3d(${slot.left - home.left}px, ${slot.top - home.top}px, 0)`, transition: ease };
  };

  const pinnedCount = sessions.filter((s) => s.pinned).length;

  return (
    <div className="flex min-w-0 flex-col">
    {sessions.length ? (
      <div className="flex items-center gap-3 px-5 pt-5">
        <label className="relative flex h-9 w-full max-w-[320px] min-w-0 items-center">
          <Search width={15} height={15} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute left-3 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="h-9 w-full min-w-0 rounded-lg border border-line/[0.1] bg-surface pl-9 pr-8 text-fs-13.5 text-fore outline-none transition-colors placeholder:text-faint-2 hover:border-line/[0.16] focus-visible:border-line/[0.22] focus-visible:ring-2 focus-visible:ring-line/15 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button type="button" aria-label="Clear search" title="Clear search" onClick={() => setQuery("")} className={`absolute right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-quiet hover:bg-line/[0.06] hover:text-fore ${FOCUS}`}>
              <X width={13} height={13} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </label>
        {q ? (
          <span className="shrink-0 text-fs-12.5 text-quiet" aria-live="polite">
            {shown.length} of {sessions.length}
          </span>
        ) : null}
      </div>
    ) : null}
    <div ref={gridRef} className={`relative grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),220px))] gap-3 p-5 ${drag ? "select-none" : ""}`}>
      {drag ? (
        // Where the card will land.
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-xl border border-dashed border-line/[0.22] bg-line/[0.03]"
          style={{
            left: drag.rects[drag.to].left - drag.origin.left,
            top: drag.rects[drag.to].top - drag.origin.top,
            width: drag.rects[drag.to].width,
            height: drag.rects[drag.to].height,
            transition: drag.reduced ? undefined : `left ${SETTLE_MS}ms cubic-bezier(.2,.8,.2,1), top ${SETTLE_MS}ms cubic-bezier(.2,.8,.2,1)`,
          }}
        />
      ) : null}
      <button type="button" data-lab-card="new" onClick={onNew} className={`${CARD} flex-col items-center justify-center gap-2.5`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-line/[0.05] text-fore-3">
          <Plus width={18} height={18} strokeWidth={1.75} aria-hidden />
        </span>
        <span className="text-fs-14 font-medium text-fore">{LAB_NEW_LABEL}</span>
      </button>
      {!sessions.length ? (
        <div className="col-span-full flex min-w-0 max-w-[460px] items-start gap-3 pt-3 text-fs-13.5 leading-fs-20 text-quiet">
          <FalconMark size={18} className="mt-0.5 text-fore-3" />
          <p>
            Your {ASSISTANT_NAME} sessions show up here. Start one to research a stock, chart a move, read options flow or test a strategy on real history.
          </p>
        </div>
      ) : q && !shown.length ? (
        <p className="col-span-full pt-2 text-fs-13.5 text-quiet">No sessions match “{query.trim()}”.</p>
      ) : null}
      {shown.map((s) => {
        const group = s.pinned ? sessions.slice(0, pinnedCount) : sessions.slice(pinnedCount);
        const index = group.findIndex((x) => x.id === s.id);
        return (
          <SessionCard
            key={s.id}
            session={s}
            style={styleFor(s.id)}
            dragging={drag?.id === s.id}
            renaming={renaming === s.id}
            confirming={confirming === s.id}
            canMoveLeft={!q && index > 0}
            canMoveRight={!q && index < group.length - 1}
            onPointerDown={(e) => {
              if (!q) onPointerDown(e, s.id);
            }}
            onOpen={() => {
              if (suppressClick.current === s.id) {
                suppressClick.current = null;
                return;
              }
              onOpen(s.id);
            }}
            onKeyDown={(e) => {
              if (q || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
              e.preventDefault();
              moveBy(s.id, e.key === "ArrowLeft" ? -1 : 1);
            }}
            onAction={(action) => {
              if (action === "pin" || action === "unpin") {
                refocus.current = s.id;
                onPin(s.id, action === "pin");
                setAnnounce(action === "pin" ? "Pinned." : "Unpinned.");
              } else if (action === "rename") setRenaming(s.id);
              else if (action === "left") moveBy(s.id, -1);
              else if (action === "right") moveBy(s.id, 1);
              else if (action === "delete") setConfirming(s.id);
            }}
            onRenameDone={(title) => {
              setRenaming(null);
              refocus.current = s.id;
              if (title !== null) onRename(s.id, title);
            }}
            onConfirmDone={(ok) => {
              setConfirming(null);
              if (ok) {
                onDelete(s.id);
                setAnnounce("Session deleted.");
                window.setTimeout(() => gridRef.current?.querySelector<HTMLElement>('[data-lab-card="new"]')?.focus(), 0);
              } else refocus.current = s.id;
            }}
          />
        );
      })}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
    </div>
  );
}

type Action = "pin" | "unpin" | "rename" | "left" | "right" | "delete";

function SessionCard({
  session: s,
  style,
  dragging,
  renaming,
  confirming,
  canMoveLeft,
  canMoveRight,
  onPointerDown,
  onOpen,
  onKeyDown,
  onAction,
  onRenameDone,
  onConfirmDone,
}: {
  session: LabSession;
  style?: CSSProperties;
  dragging: boolean;
  renaming: boolean;
  confirming: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onOpen: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onAction: (a: Action) => void;
  /** The new title, or null when cancelled or unchanged. */
  onRenameDone: (title: string | null) => void;
  onConfirmDone: (ok: boolean) => void;
}) {
  const [draft, setDraft] = useState(s.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!renaming) return;
    done.current = false;
    setDraft(s.title);
    // After the menu hands focus back to its trigger.
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
    return () => window.clearTimeout(t);
    // Only when renaming starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming]);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => cancelRef.current?.focus(), 10);
    return () => window.clearTimeout(t);
  }, [confirming]);

  const finishRename = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const t = draft.trim().slice(0, MAX_TITLE);
    onRenameDone(save && t && t !== s.title ? t : null);
  };

  const menu: MenuGroup[] = [
    {
      items: [
        s.pinned ? { id: "unpin", label: "Unpin", icon: PinOff } : { id: "pin", label: "Pin", icon: Pin },
        { id: "rename", label: "Rename", icon: Pencil },
        ...(canMoveLeft ? [{ id: "left", label: "Move left", icon: ArrowLeft, hint: "⌥←" }] : []),
        ...(canMoveRight ? [{ id: "right", label: "Move right", icon: ArrowRight, hint: "⌥→" }] : []),
      ],
    },
    { items: [{ id: "delete", label: "Delete", icon: Trash2, danger: true }] },
  ];

  const title = (
    <span className="flex w-full min-w-0 items-center gap-1.5 pr-7">
      {s.pinned ? <Pin width={13} height={13} strokeWidth={1.75} className="shrink-0 text-quiet" aria-label="Pinned" /> : null}
      <span className="min-w-0 truncate text-fs-14 font-medium text-fore">{s.title}</span>
    </span>
  );
  const last = preview(s);
  const body = (
    <span className="line-clamp-3 w-full break-words text-fs-13 leading-fs-19 text-quiet">
      {last.who ? <span className="text-fore-3">{last.who}: </span> : null}
      {last.text || "No messages yet"}
    </span>
  );
  const footer = (
    <span className="mt-auto flex w-full items-center justify-between gap-2 text-fs-11.5 text-faint [font-variant-numeric:tabular-nums]">
      <time dateTime={new Date(s.updatedAt).toISOString()} title={new Date(s.updatedAt).toLocaleString()}>
        {ago(s.updatedAt)}
      </time>
      {s.messages.length ? <span>{s.messages.length} messages</span> : null}
    </span>
  );

  if (confirming)
    return (
      <div data-session-card={s.id} className={`${CARD} flex-col justify-between gap-2 p-4 hover:bg-surface`} style={style} role="group" aria-label={`Delete ${s.title}?`}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-fs-14 font-medium text-fore">Delete this session?</span>
          <span className="line-clamp-2 break-words text-fs-13 leading-fs-19 text-quiet">“{s.title}” and its messages will be removed.</span>
        </div>
        <div
          className="flex items-center gap-2"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onConfirmDone(false);
            }
          }}
        >
          <button type="button" onClick={() => onConfirmDone(true)} className={`inline-flex h-8 items-center rounded-lg bg-down/10 px-3 text-fs-13.5 font-medium text-down transition-colors hover:bg-down/15 ${FOCUS}`}>
            Delete
          </button>
          <button ref={cancelRef} type="button" onClick={() => onConfirmDone(false)} className={`inline-flex h-8 items-center rounded-lg px-3 text-fs-13.5 font-medium text-fore-3 transition-colors hover:bg-line/[0.05] hover:text-fore ${FOCUS}`}>
            Cancel
          </button>
        </div>
      </div>
    );

  if (renaming)
    return (
      <div data-session-card={s.id} className={`${CARD} flex-col gap-1.5 p-4 hover:bg-surface`} style={style}>
        <input
          ref={inputRef}
          value={draft}
          maxLength={MAX_TITLE}
          aria-label="Session name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finishRename(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              finishRename(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              finishRename(false);
            }
          }}
          className="-mx-1.5 -my-0.5 block min-w-0 rounded-md bg-line/[0.06] px-1.5 py-0.5 text-fs-14 font-medium text-fore outline-none ring-2 ring-line/20"
        />
        {body}
      </div>
    );

  return (
    <div
      data-session-card={s.id}
      className={`group relative min-w-0 touch-manipulation rounded-xl ${dragging ? "shadow-[0_12px_32px_rgba(0,0,0,0.14)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.5)]" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        // A long press on a touch screen is a drag here, not the context menu.
        if (dragging) e.preventDefault();
      }}
    >
      <button
        type="button"
        data-lab-card={s.id}
        data-card-main
        onClick={onOpen}
        onKeyDown={onKeyDown}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        className={`${CARD} flex-col gap-1.5 p-4 ${dragging ? "cursor-grabbing border-line/[0.2] bg-surface hover:bg-surface" : ""}`}
      >
        {title}
        {body}
        {footer}
      </button>
      <Dropdown
        kind="menu"
        label={`Actions for ${s.title}`}
        groups={menu}
        width={184}
        align="right"
        className="!absolute right-2 top-2"
        onSelect={(id) => onAction(id as Action)}
        button={({ open, props }) => (
          <button
            {...props}
            data-no-drag
            title="More"
            className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-quiet transition-[opacity,background-color,color] hover:bg-line/[0.06] hover:text-fore ${FOCUS} ${
              open || dragging ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            } ${dragging ? "invisible" : ""}`}
          >
            <MoreHorizontal width={16} height={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      />
    </div>
  );
}
