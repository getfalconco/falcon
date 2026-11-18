"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * A full-page backdrop: the whole page softly blurs under a light, frosted
 * veil, without darkening (the animation is `.blur-overlay` in
 * app/globals.css), with an optional panel (`children`) centred in front; the
 * panel brings its own look, the overlay adds none. Escape or a click on the
 * backdrop calls `onClose`; it animates out the same way, then focus goes back
 * to `returnFocus`. While open, Tab stays inside (on the panel's controls, or
 * on the overlay itself when there are none).
 *
 * Used by the setup card's "Get started" (tabs/OwnCard.tsx, with
 * tabs/BringPortfolio.tsx in front).
 */

/** The longest transition in .blur-overlay (320ms) plus a frame. */
const EXIT_MS = 340;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function BlurOverlay({
  open,
  onClose,
  label,
  returnFocus,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name. */
  label: string;
  returnFocus?: RefObject<HTMLElement>;
  children?: ReactNode;
}) {
  // Mounted from opening until the exit animation ends; `shown` drives the transition.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      setMounted(true);
      return;
    }
    setShown(false);
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const t = setTimeout(() => {
      setMounted(false);
      returnFocus?.current?.focus({ preventScroll: true });
    }, EXIT_MS);
    return () => clearTimeout(t);
  }, [open, returnFocus]);

  // Once mounted closed: style it (reading layout does that), then open, so the blur and veil transition in.
  useEffect(() => {
    if (!open || !mounted) return;
    void rootRef.current?.offsetHeight;
    setShown(true);
  }, [open, mounted]);

  // Focus moves into the overlay: the panel's [data-autofocus] control, its first one, or the overlay itself.
  useEffect(() => {
    if (!open || !mounted) return;
    const root = rootRef.current;
    if (!root || root.contains(document.activeElement)) return;
    (root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? root).focus({ preventScroll: true });
  }, [open, mounted]);

  // Escape closes and Tab stays inside, wherever focus is on the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = rootRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      const inside = root.contains(document.activeElement);
      if (!first || !last) {
        e.preventDefault();
        root.focus({ preventScroll: true });
      } else if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      data-open={shown}
      className="blur-overlay fixed inset-0 z-[100] flex overflow-y-auto overscroll-contain px-4 py-6 outline-none sm:p-6"
      style={{ pointerEvents: open ? undefined : "none" }}
      onMouseDown={(e) => {
        // The backdrop, not the panel in front of it.
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div className="blur-overlay-blur pointer-events-none fixed inset-0" aria-hidden />
      <div className="blur-overlay-veil pointer-events-none fixed inset-0" aria-hidden />
      {/* m-auto centres the panel, and lets a tall one scroll from its top. */}
      {children ? <div className="blur-overlay-panel relative m-auto">{children}</div> : null}
    </div>,
    document.body,
  );
}
