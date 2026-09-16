import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useDragControls, type PanInfo } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Press-and-hold to pick a card up: it lifts (scale + drop shadow) and can
 * then be dragged anywhere. Short presses still click through to whatever is
 * underneath, so the card's own buttons keep working. The parent decides
 * what a drop means via `onDragEnd` — the card itself just snaps back.
 */

export type DragPoint = { x: number; y: number };

const HOLD_MS = 220;
/**
 * How far the pointer may wander before the press stops counting as a hold.
 * Dragging across a word to select it is a press that moves; picking a card up
 * is a press that stays put.
 */
const HOLD_SLOP_PX = 6;

export default function LiftableCard({
  children,
  layoutId,
  className,
  onLift,
  onDragMove,
  onDragEnd,
}: {
  children: ReactNode;
  /** Shared across slots so moving between them animates. */
  layoutId?: string;
  className?: string;
  onLift?: () => void;
  onDragMove?: (point: DragPoint) => void;
  onDragEnd?: (point: DragPoint) => void;
}) {
  const controls = useDragControls();
  const [lifted, setLifted] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const draggedRef = useRef(false);
  const downAt = useRef<DragPoint | null>(null);

  const clearHold = () => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  useEffect(() => clearHold, []);

  // A lift that never became a drag has no onDragEnd to unwind it: press and
  // hold without moving, release, and the card would stay scaled and shadowed
  // with its text unselectable. Release always ends a lift that never moved.
  useEffect(() => {
    if (!lifted) return;
    const onUp = () => {
      if (!draggedRef.current) setLifted(false);
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [lifted]);

  return (
    <motion.div
      layoutId={layoutId}
      drag
      dragListener={false}
      dragControls={controls}
      dragMomentum={false}
      dragElastic={0.12}
      dragSnapToOrigin
      animate={{
        scale: lifted ? 1.035 : 1,
        boxShadow: lifted
          ? "0 34px 70px -14px rgba(0,0,0,0.30), 0 12px 24px -10px rgba(0,0,0,0.18)"
          : "0 0px 0px 0px rgba(0,0,0,0)",
      }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Copy the reader is meant to highlight — the headline, the gloss —
        // owns its own drags. Lifting the card out from under a selection is
        // never what was wanted.
        if ((e.target as HTMLElement | null)?.closest?.("[data-selectable]")) return;
        const native = e.nativeEvent;
        clearHold();
        draggedRef.current = false;
        downAt.current = { x: e.clientX, y: e.clientY };
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = null;
          setLifted(true);
          onLift?.();
          controls.start(native, { snapToCursor: false });
        }, HOLD_MS);
      }}
      onPointerMove={(e) => {
        // A press that travels is a swipe or a text drag, not a lift.
        const from = downAt.current;
        if (holdTimer.current == null || !from) return;
        const dx = e.clientX - from.x;
        const dy = e.clientY - from.y;
        if (dx * dx + dy * dy > HOLD_SLOP_PX * HOLD_SLOP_PX) clearHold();
      }}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onPointerLeave={() => {
        // Only cancel the pending hold — once dragging, leaving is expected.
        if (!lifted) clearHold();
      }}
      onDragStart={() => {
        draggedRef.current = true;
      }}
      onDrag={(_e, info: PanInfo) => onDragMove?.({ x: info.point.x, y: info.point.y })}
      onDragEnd={(_e, info: PanInfo) => {
        setLifted(false);
        onDragEnd?.({ x: info.point.x, y: info.point.y });
      }}
      onClickCapture={(e) => {
        // A drag that ends over a button shouldn't also click it.
        if (draggedRef.current) {
          e.stopPropagation();
          e.preventDefault();
          draggedRef.current = false;
        }
      }}
      className={cn(
        "relative rounded-3xl touch-none",
        lifted ? "z-50 cursor-grabbing select-none" : "",
        className,
      )}
      style={{ zIndex: lifted ? 50 : undefined }}
    >
      {children}
    </motion.div>
  );
}
