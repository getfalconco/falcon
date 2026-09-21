import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import { motion, useDragControls, useMotionValue, type PanInfo } from "framer-motion";
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

/** The lift's own pop. Never applied to position or size. */
const LIFT_SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

export default function LiftableCard({
  children,
  layoutId,
  className,
  style,
  onLift,
  onDragMove,
  onDragEnd,
  instant = false,
  free = false,
}: {
  children: ReactNode;
  /** Shared across slots so moving between them animates. */
  layoutId?: string;
  className?: string;
  /** Layout the caller owns — the grid span and height of a resized card. */
  style?: CSSProperties;
  onLift?: () => void;
  onDragMove?: (point: DragPoint) => void;
  /** Where the pointer let go, and how far it travelled from the press. */
  onDragEnd?: (point: DragPoint, offset: DragPoint) => void;
  /**
   * The card is being moved or resized right now, so it must track the
   * pointer rather than chase it. Framer's layout projection would otherwise
   * spring the box towards each new size, which reads as the card lagging
   * behind the hand that is dragging it.
   */
  instant?: boolean;
  /**
   * The card lives on a canvas rather than in a flow: a drop is a place, not
   * a slot, so the card stays where it was let go instead of springing back.
   * The caller moves the box by the offset it is handed; the drag transform
   * is zeroed on the same frame, and nothing appears to move.
   */
  free?: boolean;
}) {
  const controls = useDragControls();
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
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
      // No rubber band and no throw: the card sits exactly where the pointer
      // put it, for as long as the pointer is down.
      dragElastic={0}
      dragSnapToOrigin={!free}
      animate={{
        scale: lifted ? 1.035 : 1,
        boxShadow: lifted
          ? "0 34px 70px -14px rgba(0,0,0,0.30), 0 12px 24px -10px rgba(0,0,0,0.18)"
          : "0 0px 0px 0px rgba(0,0,0,0)",
      }}
      transition={{
        scale: LIFT_SPRING,
        boxShadow: LIFT_SPRING,
        // Position and size follow the handle with nothing in between; once
        // the gesture is over, a move between slots is worth animating.
        layout: instant ? { duration: 0 } : LIFT_SPRING,
        default: instant ? { duration: 0 } : LIFT_SPRING,
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Copy the reader is meant to highlight — the headline, the gloss —
        // owns its own drags. Lifting the card out from under a selection is
        // never what was wanted.
        // The resize grip owns its own drag, as selectable copy does.
        if ((e.target as HTMLElement | null)?.closest?.("[data-selectable],[data-no-lift]"))
          return;
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
        onDragEnd?.({ x: info.point.x, y: info.point.y }, { x: info.offset.x, y: info.offset.y });
        // On a canvas the caller has just moved the box by this offset, so the
        // transform that carried the card there is zeroed in the same frame:
        // the box lands under the card and nothing is seen to move.
        if (free) {
          dragX.jump(0);
          dragY.jump(0);
        }
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
        // `pan-y`, not `none`. touch-action is intersected down the tree, so a
        // card that claimed the whole gesture also took it from anything
        // scrollable inside it — the holdings list could be dragged nowhere and
        // scrolled not at all by touch or pen. Framer does not set this itself
        // here (the lift starts from `dragControls`, not from its own
        // listener), so the class was the only thing saying `none`. Vertical
        // panning belongs to whatever is under the finger; the lift is a hold,
        // which no pan cancels.
        "relative touch-pan-y rounded-3xl",
        lifted ? "z-50 cursor-grabbing select-none" : "",
        className,
      )}
      // A lifted card rides above the others; otherwise the box keeps the
      // z-index the caller gave it (a canvas orders its cards by touch), and
      // everything else about it is the caller's. The drag transform lives
      // in motion values so a free drop can zero it without a re-render.
      style={{ ...style, x: dragX, y: dragY, zIndex: lifted ? 50 : style?.zIndex }}
    >
      {children}
    </motion.div>
  );
}
