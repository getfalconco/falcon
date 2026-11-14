"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { MAIN_WORKSPACE_ID, MAX_WORKSPACES, MAX_WORKSPACE_NAME, type WorkspaceInfo, type useWorkspaceIndex } from "@/lib/workspace/workspaces";
import { SelectorLabel, selectorClass, usePopover } from "./shell/ui";

export type WorkspaceSwitcherApi = ReturnType<typeof useWorkspaceIndex>;

type Mode = { kind: "none" } | { kind: "new" } | { kind: "rename"; id: string } | { kind: "delete"; id: string };

const ROW_ICON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#9a9a9a] outline-none transition-colors hover:bg-black/[0.07] hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20";
const INPUT =
  "h-8 w-full rounded-lg border border-black/20 bg-white px-2.5 text-[13.5px] text-[#1d1b1b] outline-none placeholder:text-[#9a9a9a] focus:border-black/40";

function describe(w: WorkspaceInfo): string {
  if (w.id === MAIN_WORKSPACE_ID) return "Focus list synced with your account";
  const d = new Date(w.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Created ${d}, this browser only`;
}

/**
 * The top bar's workspace selector: search, the workspaces with a check on
 * the active one, rename and delete per item (Main cannot be deleted), and
 * "New workspace" with an inline name.
 */
export function WorkspaceSwitcher({ api }: { api: WorkspaceSwitcherApi }) {
  const pop = usePopover();
  return (
    <div
      ref={pop.wrapRef}
      className="relative min-w-0"
      onBlur={(e) => {
        // Tabbing out of the menu closes it.
        if (pop.open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) pop.setOpen(false);
      }}
    >
      <button
        ref={pop.triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={pop.open}
        aria-label={`Workspace: ${api.active.name}. Switch workspace`}
        onClick={() => pop.setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !pop.open) {
            e.preventDefault();
            pop.setOpen(true);
          }
        }}
        className={selectorClass(pop.open)}
      >
        <SelectorLabel>{api.active.name}</SelectorLabel>
      </button>
      {pop.open ? <Panel api={api} onClose={(refocus) => pop.close(refocus)} /> : null}
    </div>
  );
}

function Panel({ api, onClose }: { api: WorkspaceSwitcherApi; onClose: (refocus: boolean) => void }) {
  const baseId = useId();
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "none" });
  const [draft, setDraft] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const { list, activeId } = api.index;
  const full = list.length >= MAX_WORKSPACES;

  const shown = useMemo(() => list.filter((w) => !q.trim() || w.name.toLowerCase().includes(q.trim().toLowerCase())), [list, q]);
  // Rows the arrow keys move over: the workspaces shown, then "New workspace".
  const count = shown.length + (full ? 0 : 1);
  const [active, setActive] = useState(() => Math.max(0, list.findIndex((w) => w.id === activeId)));
  const optId = (i: number) => `${baseId}-o${i}`;

  useEffect(() => searchRef.current?.focus(), []);
  useEffect(() => {
    if (active >= count) setActive(Math.max(0, count - 1));
  }, [active, count]);
  useEffect(() => {
    document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
    // optId is stable for this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const back = () => {
    setMode({ kind: "none" });
    setDraft("");
    searchRef.current?.focus();
  };

  const pick = (i: number) => {
    const w = shown[i];
    if (w) {
      onClose(false);
      api.switchTo(w.id);
    } else if (!full) {
      setDraft("");
      setMode({ kind: "new" });
    }
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (count ? (a + 1) % count : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (count ? (a - 1 + count) % count : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "F2" && shown[active]) {
      e.preventDefault();
      setDraft(shown[active].name);
      setMode({ kind: "rename", id: shown[active].id });
    }
  };

  /** Escape inside an inline edit cancels it instead of closing the menu. */
  const editKeys = (e: React.KeyboardEvent, commit: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  };

  return (
    <div
      className="absolute left-0 top-full z-50 mt-1.5 w-[280px] overflow-hidden rounded-xl border border-black/10 bg-white text-[#1d1b1b] shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
      onMouseDown={(e) => {
        // Keep focus where it is when clicking labels or empty space.
        if (!(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement)) e.preventDefault();
      }}
    >
      <div className="flex h-10 items-center gap-2 border-b border-black/[0.08] px-3">
        <Search width={15} height={15} strokeWidth={1.75} className="shrink-0 text-[#9a9a9a]" aria-hidden />
        <input
          ref={searchRef}
          role="combobox"
          aria-expanded
          aria-controls={`${baseId}-list`}
          aria-activedescendant={mode.kind === "none" && count ? optId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Search workspaces"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onSearchKey}
          placeholder="Select a workspace..."
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[#1d1b1b] outline-none placeholder:text-[#9a9a9a]"
        />
      </div>

      <div id={`${baseId}-list`} role="listbox" aria-label="Workspaces" className="max-h-[320px] overflow-y-auto p-1.5">
        <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[#9a9a9a]" aria-hidden>
          Workspaces
        </div>
        {shown.length ? null : <p className="px-2 py-1.5 text-[12.5px] text-[#9a9a9a]">No matches</p>}
        {shown.map((w, i) => {
          const isMain = w.id === MAIN_WORKSPACE_ID;
          const on = w.id === activeId;
          if (mode.kind === "rename" && mode.id === w.id) {
            const commit = () => {
              if (draft.trim() && draft.trim() !== w.name) api.rename(w.id, draft);
              back();
            };
            return (
              <div key={w.id} className="px-1 py-1">
                <input
                  autoFocus
                  aria-label={`New name for ${w.name}`}
                  value={draft}
                  maxLength={MAX_WORKSPACE_NAME}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => editKeys(e, commit)}
                  onBlur={commit}
                  className={INPUT}
                />
              </div>
            );
          }
          if (mode.kind === "delete" && mode.id === w.id) {
            return (
              <div key={w.id} role="alert" className="rounded-lg bg-[#f8f8f6] px-2.5 py-2">
                <p className="text-[13px] text-[#1d1b1b]">Delete &ldquo;{w.name}&rdquo;?</p>
                <p className="mt-0.5 text-[12px] leading-[16px] text-[#8a8a85]">Its focus list, strategies and open tabs in this browser are removed. This cannot be undone.</p>
                <div className="mt-2 flex justify-end gap-1">
                  <button
                    type="button"
                    autoFocus
                    onClick={back}
                    onKeyDown={(e) => editKeys(e, back)}
                    className="h-7 rounded-md px-2.5 text-[12.5px] text-[#3d3b3a] outline-none hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20"
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      api.remove(w.id);
                      if (on) onClose(false);
                      else back();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") editKeys(e, back);
                    }}
                    className="h-7 rounded-md px-2.5 text-[12.5px] text-[#b3432f] outline-none hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          }
          const highlighted = mode.kind === "none" && i === active;
          return (
            <div
              key={w.id}
              id={optId(i)}
              role="option"
              aria-selected={on}
              onMouseMove={() => mode.kind === "none" && active !== i && setActive(i)}
              onClick={() => pick(i)}
              className={`group flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 ${highlighted ? "bg-black/[0.05]" : ""}`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] leading-[20px]">{w.name}</div>
                <div className="truncate text-[12px] leading-[16px] text-[#8a8a85]">{describe(w)}</div>
              </div>
              <span className={`flex shrink-0 items-center gap-0.5 ${highlighted ? "opacity-100" : "opacity-0"} transition-opacity focus-within:opacity-100 group-hover:opacity-100`}>
                <button
                  type="button"
                  aria-label={`Rename ${w.name}`}
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDraft(w.name);
                    setMode({ kind: "rename", id: w.id });
                  }}
                  className={ROW_ICON}
                >
                  <Pencil width={13} height={13} strokeWidth={1.75} aria-hidden />
                </button>
                {isMain ? null : (
                  <button
                    type="button"
                    aria-label={`Delete ${w.name}`}
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMode({ kind: "delete", id: w.id });
                    }}
                    className={ROW_ICON}
                  >
                    <Trash2 width={13} height={13} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </span>
              <span className="flex w-4 shrink-0 justify-center">{on ? <Check width={15} height={15} strokeWidth={2} aria-hidden /> : null}</span>
            </div>
          );
        })}
      </div>

      <div className="border-t border-black/[0.08] p-1.5">
        {mode.kind === "new" ? (
          <div className="px-1 py-1">
            <input
              autoFocus
              aria-label="New workspace name"
              placeholder="Workspace name"
              value={draft}
              maxLength={MAX_WORKSPACE_NAME}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) =>
                editKeys(e, () => {
                  if (!draft.trim()) return;
                  onClose(false);
                  api.create(draft);
                })
              }
              onBlur={() => !draft.trim() && back()}
              className={INPUT}
            />
            <p className="mt-1 px-0.5 text-[11.5px] text-[#9a9a9a]">Enter to create. It starts with an empty focus list.</p>
          </div>
        ) : full ? (
          <p className="px-2 py-1.5 text-[12.5px] text-[#9a9a9a]">Up to {MAX_WORKSPACES} workspaces</p>
        ) : (
          <div
            id={optId(shown.length)}
            role="option"
            aria-selected={false}
            onMouseMove={() => mode.kind === "none" && active !== shown.length && setActive(shown.length)}
            onClick={() => pick(shown.length)}
            className={`flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] ${mode.kind === "none" && active === shown.length ? "bg-black/[0.05]" : ""}`}
          >
            <Plus width={15} height={15} strokeWidth={1.75} className="shrink-0 text-[#767676]" aria-hidden />
            New workspace
          </div>
        )}
      </div>
    </div>
  );
}
