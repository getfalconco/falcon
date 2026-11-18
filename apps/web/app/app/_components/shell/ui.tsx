"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ComponentType, ReactNode, Ref, SVGProps } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";

/**
 * Desktop shell primitives: card header, quiet icon and text buttons, the
 * selector button with an up/down chevron, and the dropdown (search, grouped
 * options, check on the selected one).
 */

export type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }>;

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/20";

export const ICON_BUTTON = `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-quiet transition-colors hover:bg-line/[0.05] hover:text-fore disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`;

export function IconButton({
  label,
  onClick,
  pressed,
  icon: I,
  disabled,
  className = "",
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  icon: Icon;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`${ICON_BUTTON} ${pressed ? "bg-line/[0.05] text-fore" : ""} ${className}`}
    >
      <I width={16} height={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** "Clear" / "History" style: icon and a word, no border. */
export function TextButton({
  icon: I,
  children,
  onClick,
  pressed,
  disabled,
  title,
}: {
  icon?: Icon;
  children: ReactNode;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-fs-13.5 transition-colors hover:bg-line/[0.05] hover:text-fore disabled:pointer-events-none disabled:opacity-40 ${FOCUS} ${
        pressed ? "bg-line/[0.05] text-fore" : "text-fore-4"
      }`}
    >
      {I ? <I width={15} height={15} strokeWidth={1.75} aria-hidden /> : null}
      {children}
    </button>
  );
}

/** The white card's top row: title left, actions right. */
export function CardHeader({
  title,
  actions,
  titleMono = false,
  hideTitle = false,
  serif = false,
  overlay = false,
  lead,
}: {
  title: ReactNode;
  actions?: ReactNode;
  titleMono?: boolean;
  /** Keep the title for screen readers only; the row then carries just the actions, with no rule under it. */
  hideTitle?: boolean;
  /** Large serif title like the dashboard greeting, with no rule under the row. */
  serif?: boolean;
  /** Float the row over the content with a transparent background (the Graph canvas runs underneath it). */
  overlay?: boolean;
  /** Shown at the left of the row in place of the visible title (e.g. the dashboard greeting). */
  lead?: ReactNode;
}) {
  return (
    <div
      data-pane-header
      className={`flex shrink-0 items-center justify-between gap-4 px-5 ${lead || serif ? "pb-2 pt-8" : "h-14"} ${hideTitle || serif ? "" : "border-b border-line/[0.08]"} ${
        overlay ? "pointer-events-none absolute inset-x-0 top-0 z-10 bg-transparent [&>*]:pointer-events-auto" : ""
      }`}
    >
      <h1
        className={
          hideTitle
            ? "sr-only"
            : serif
              ? "min-w-0 truncate pl-1.5 text-fs-26 leading-fs-34 text-fore"
              : "min-w-0 truncate text-fs-18 font-medium leading-fs-24 tracking-[-0.01em] text-fore"
        }
        style={
          titleMono
            ? { fontFamily: "var(--font-geist-mono), monospace" }
            : serif && !hideTitle
              ? { fontFamily: "var(--font-libre-baskerville), Georgia, serif" }
              : undefined
        }
      >
        {title}
      </h1>
      {lead ? <div className="min-w-0 truncate">{lead}</div> : null}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

/** Scrolling body of the card for a single view. */
export function CardBody({ children, fill = false, roundTop = false }: { children: ReactNode; fill?: boolean; roundTop?: boolean }) {
  // roundTop: the body reaches the card's top edge (its header floats over it), so it needs the top corners too.
  return <div className={`min-h-0 min-w-0 flex-1 ${roundTop ? "rounded-xl" : "rounded-b-xl"} ${fill ? "overflow-hidden" : "overflow-y-auto"}`}>{children}</div>;
}

type TriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & { ref: Ref<HTMLButtonElement> };

/** Label plus up/down chevron; light gray fill while its menu is open. */
export function selectorClass(open: boolean, size: "md" | "sm" = "md"): string {
  return `inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg ${size === "md" ? "h-8 px-2.5 text-fs-14" : "h-7 px-2 text-fs-13.5"} font-medium text-fore transition-colors hover:bg-line/[0.05] ${FOCUS} ${
    open ? "bg-line/[0.06]" : ""
  }`;
}

export function SelectorLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="min-w-0 truncate">{children}</span>
      <ChevronsUpDown width={14} height={14} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
    </>
  );
}

/* ------------------------------------------------------------------ menus */

export type MenuItem = {
  id: string;
  label: ReactNode;
  /** Text the search matches; defaults to the label when it is a string. */
  text?: string;
  description?: string;
  selected?: boolean;
  icon?: Icon;
  mono?: boolean;
  danger?: boolean;
  /** Keyboard shortcut shown at the right, e.g. "⌘,". */
  hint?: string;
};

export type MenuGroup = { label?: string; items: MenuItem[] };

/** Open state for a dropdown: closes on a click outside or Escape, then returns focus to the trigger. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    // After this key event finishes, or Enter would land on the trigger and open it again.
    if (refocus) setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [close, open]);

  return { open, setOpen, close, wrapRef, triggerRef };
}

/**
 * A button that opens a dropdown. `kind: "select"` is a listbox (search,
 * check on the selected option); `"menu"` is a list of actions.
 */
export function Dropdown({
  button,
  groups,
  onSelect,
  searchPlaceholder,
  label,
  kind = "select",
  width = 240,
  align = "left",
  side = "bottom",
  className = "",
  footer,
}: {
  button: (state: { open: boolean; props: TriggerProps }) => ReactNode;
  groups: MenuGroup[] | (() => MenuGroup[]);
  onSelect: (id: string) => void;
  searchPlaceholder?: string;
  label: string;
  kind?: "select" | "menu";
  width?: number;
  align?: "left" | "right";
  side?: "bottom" | "top";
  className?: string;
  footer?: ReactNode;
}) {
  const pop = usePopover();
  return (
    <div ref={pop.wrapRef} className={`relative min-w-0 ${className}`}>
      {button({
        open: pop.open,
        props: {
          ref: pop.triggerRef,
          type: "button",
          onClick: () => pop.setOpen((o) => !o),
          onKeyDown: (e) => {
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !pop.open) {
              e.preventDefault();
              pop.setOpen(true);
            }
          },
          "aria-haspopup": kind === "select" ? "listbox" : "menu",
          "aria-expanded": pop.open,
          "aria-label": label,
        },
      })}
      {pop.open ? (
        <MenuPanel
          groups={typeof groups === "function" ? groups() : groups}
          kind={kind}
          label={label}
          searchPlaceholder={searchPlaceholder}
          width={width}
          align={align}
          side={side}
          footer={footer}
          onClose={(refocus) => pop.close(refocus)}
          onSelect={(id) => {
            pop.close(true);
            onSelect(id);
          }}
        />
      ) : null}
    </div>
  );
}

function matches(item: MenuItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.text ?? (typeof item.label === "string" ? item.label : "")} ${item.description ?? ""}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function MenuPanel({
  groups,
  kind,
  label,
  searchPlaceholder,
  width,
  align,
  side,
  footer,
  onClose,
  onSelect,
}: {
  groups: MenuGroup[];
  kind: "select" | "menu";
  label: string;
  searchPlaceholder?: string;
  width: number;
  align: "left" | "right";
  side: "bottom" | "top";
  footer?: ReactNode;
  onClose: (refocus: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const baseId = useId();
  const [q, setQ] = useState("");
  const shown = useMemo(() => groups.map((g) => ({ ...g, items: g.items.filter((i) => matches(i, q.trim())) })).filter((g) => g.items.length), [groups, q]);
  const flat = useMemo(() => shown.flatMap((g) => g.items), [shown]);
  const [active, setActive] = useState(() => Math.max(0, flat.findIndex((i) => i.selected)));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optId = (i: number) => `${baseId}-o${i}`;

  useEffect(() => {
    (searchPlaceholder ? inputRef.current : listRef.current)?.focus();
  }, [searchPlaceholder]);

  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [active, flat.length]);

  useEffect(() => {
    document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
    // optId is stable for this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, flat.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[active];
      if (item) onSelect(item.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "Tab") {
      onClose(false);
    }
  };

  const listId = `${baseId}-list`;
  const activeId = flat.length ? optId(active) : undefined;
  let index = -1;

  return (
    <div
      className={`absolute z-50 overflow-hidden rounded-xl border border-line/10 bg-raised text-fore shadow-[0_12px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.45)] ${
        side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5"
      } ${align === "left" ? "left-0" : "right-0"}`}
      style={{ width }}
    >
      {searchPlaceholder ? (
        <div className="flex h-10 items-center gap-2 border-b border-line/[0.08] px-3">
          <Search width={15} height={15} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={`Search: ${label}`}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-fs-13.5 text-fore outline-none placeholder:text-faint"
          />
        </div>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role={kind === "select" ? "listbox" : "menu"}
        aria-label={label}
        tabIndex={searchPlaceholder ? -1 : 0}
        aria-activedescendant={searchPlaceholder ? undefined : activeId}
        onKeyDown={searchPlaceholder ? undefined : onKeyDown}
        className="max-h-[340px] overflow-y-auto p-1.5 outline-none"
      >
        {shown.length ? (
          shown.map((g, gi) => (
            <div key={`${g.label ?? ""}-${gi}`} role="group" aria-label={g.label} className={gi > 0 ? "mt-1" : ""}>
              {g.label ? (
                <div className="px-2 pb-1 pt-1.5 text-fs-11 font-medium uppercase tracking-[0.08em] text-faint" aria-hidden>
                  {g.label}
                </div>
              ) : null}
              {g.items.map((item) => {
                index += 1;
                const i = index;
                const on = i === active;
                const I = item.icon;
                return (
                  <div
                    key={item.id}
                    id={optId(i)}
                    role={kind === "select" ? "option" : "menuitem"}
                    aria-selected={kind === "select" ? Boolean(item.selected) : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => active !== i && setActive(i)}
                    onClick={() => onSelect(item.id)}
                    className={`flex cursor-default items-start gap-2 rounded-lg px-2 py-1.5 ${on ? "bg-line/[0.05]" : ""}`}
                  >
                    {I ? <I width={15} height={15} strokeWidth={1.75} className="mt-[2px] shrink-0 text-quiet" aria-hidden /> : null}
                    <div className="min-w-0 flex-1">
                      <div
                        className={`truncate text-fs-13.5 leading-fs-20 ${item.danger ? "text-down" : "text-fore"}`}
                        style={item.mono ? { fontFamily: "var(--font-geist-mono), monospace" } : undefined}
                      >
                        {item.label}
                      </div>
                      {item.description ? <div className="line-clamp-2 text-fs-12 leading-fs-16 text-quiet-2">{item.description}</div> : null}
                    </div>
                    {item.hint ? (
                      <kbd className="mt-[2px] shrink-0 [font-family:inherit] text-fs-12 leading-fs-16 text-faint" aria-hidden>
                        {item.hint}
                      </kbd>
                    ) : null}
                    {item.selected ? <Check width={15} height={15} strokeWidth={2} className="mt-[2px] shrink-0 text-fore" aria-hidden /> : null}
                  </div>
                );
              })}
            </div>
          ))
        ) : (
          <p className="px-2 py-2 text-fs-12.5 text-faint">No matches</p>
        )}
      </div>
      {footer}
    </div>
  );
}
