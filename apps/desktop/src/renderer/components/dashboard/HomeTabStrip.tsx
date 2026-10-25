import { useRef, type KeyboardEvent } from "react";
import { Reorder } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export type HomeTabChoice<Id extends string = string> = {
  id: Id;
  label: string;
  icon?: LucideIcon;
};

/**
 * The open tab is the dashboard's primary action (the View Calendar button's
 * dark glass); the others are the account pill's light glass. The dark theme
 * turns both by itself (globals.css, "The buttons"): `cta-primary` to solid
 * off-white with dark type, `btn-quiet` to the quiet button, so the open tab
 * stays the strongest mark either way. `rounded-full` and the sizes beat the
 * layer's own, as on Add Module.
 */
const TAB_BASE =
  "app-no-drag flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-edge-focus";
const TAB_ON = "glass-cta cta-primary text-white";
const TAB_OFF =
  "btn-quiet border border-white/60 bg-white/70 text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl transition-colors duration-150 hover:bg-white/90";

/**
 * The home screen's tab strip, beside the greeting. Pills in a row: press one
 * to open it, drag one sideways to move it. The parent owns the order (and
 * keeps it), the open tab, and what each tab shows; this only draws and
 * reports.
 *
 * A drag that ends on the tab it started on would also count as a click on
 * it, so a press that turned into a drag opens nothing. From the keyboard the
 * arrows move between tabs (and open them, as tabs do), and Alt with an arrow
 * moves the focused tab itself — the drag, for a reader not using a pointer.
 */
export default function HomeTabStrip<Id extends string>({
  tabs,
  active,
  onSelect,
  onReorder,
  className,
}: {
  /** In the order they stand. */
  tabs: ReadonlyArray<HomeTabChoice<Id>>;
  active: Id;
  onSelect: (id: Id) => void;
  onReorder: (order: Id[]) => void;
  className?: string;
}) {
  const t = useT();
  const dragged = useRef(false);
  const buttons = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const order = tabs.map((tab) => tab.id);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: Id) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const at = order.indexOf(id);
    const to = Math.min(order.length - 1, Math.max(0, at + (e.key === "ArrowLeft" ? -1 : 1)));
    if (to === at) return;
    if (e.altKey) {
      const next = [...order];
      next.splice(at, 1);
      next.splice(to, 0, id);
      onReorder(next);
      return;
    }
    const target = order[to];
    onSelect(target);
    buttons.current[target]?.focus();
  };

  return (
    <Reorder.Group
      as="div"
      axis="x"
      values={order}
      onReorder={(next) => onReorder(next as Id[])}
      role="tablist"
      aria-label={t("shell.tabs.label")}
      className={cn("flex items-center gap-1.5", className)}
    >
      {tabs.map(({ id, label, icon: Icon }) => {
        const on = id === active;
        return (
          <Reorder.Item
            key={id}
            as="div"
            value={id}
            className="relative"
            whileDrag={{ scale: 1.05, zIndex: 1 }}
            onDragStart={() => {
              dragged.current = true;
            }}
          >
            <button
              ref={(el) => {
                buttons.current[id] = el;
              }}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              title={t("shell.tabs.dragHint", { label })}
              onPointerDown={() => {
                dragged.current = false;
              }}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                onSelect(id);
              }}
              onKeyDown={(e) => onKeyDown(e, id)}
              className={cn(TAB_BASE, on ? TAB_ON : TAB_OFF)}
            >
              {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden /> : null}
              {label}
            </button>
          </Reorder.Item>
        );
      })}
    </Reorder.Group>
  );
}
