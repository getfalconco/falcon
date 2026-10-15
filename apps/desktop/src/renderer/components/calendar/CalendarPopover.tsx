import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * The calendar's floating card: an event's details, the editor, a day's full
 * list. Placed beside the thing it belongs to (to its right, or its left when
 * the right has no room) and kept inside the window; closed by Escape or a
 * press outside it. Drawn in a portal so the grid's scroll and clipping
 * never cut it.
 */

/**
 * The card surface: the dropdowns' edge and shadow on a solid fill, because a
 * card over a busy grid has to read whether or not the backdrop blurs.
 */
export const POPOVER_SURFACE =
  "rounded-2xl border border-white/60 bg-[#fbfbf9] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.16)] ring-1 ring-black/[0.06]";

export type AnchorRect = { left: number; top: number; right: number; bottom: number };

const EDGE = 12;
const GAP = 10;

export function rectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/**
 * Keeps a drag's pointer on the element that started it. A pointer the
 * browser no longer knows (lifted already, or a synthetic one) cannot be
 * captured; the drag then simply follows window events, which it listens to
 * anyway.
 */
export function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* see above */
  }
}

export default function CalendarPopover({
  anchor,
  width = 320,
  onClose,
  label,
  children,
  className,
}: {
  anchor: AnchorRect;
  width?: number;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const reduce = useReducedMotion();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = anchor.right + GAP;
      if (left + width > vw - EDGE) left = anchor.left - GAP - width;
      if (left < EDGE) left = Math.min(Math.max(EDGE, anchor.left), vw - EDGE - width);
      let top = anchor.top;
      if (top + h > vh - EDGE) top = vh - EDGE - h;
      setPos({ left, top: Math.max(EDGE, top) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, width]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      const target = e.target as Node | null;
      if (!el || !target || el.contains(target)) return;
      // A press inside another calendar card (a picker list opened from this
      // one) is not a press outside.
      if ((target as Element).closest?.("[data-calendar-popover]")) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    // Deferred a frame: the press that opened the card must not close it.
    const timer = window.setTimeout(() => window.addEventListener("pointerdown", onDown, true), 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-calendar-popover
      className={cn("app-no-drag fixed z-[80] font-sans", POPOVER_SURFACE, className)}
      style={{
        width,
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        // A CSS transition rather than a JS-driven one: it settles on its own
        // even when the window draws no frames for a while.
        opacity: pos ? 1 : 0,
        transform: pos || reduce ? "none" : "translateY(4px) scale(0.98)",
        transition: reduce ? "none" : "opacity 140ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1)",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
