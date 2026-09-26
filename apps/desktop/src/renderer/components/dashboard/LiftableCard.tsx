import { useRef, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import { motion, useDragControls, useMotionValue, type PanInfo } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Grab a card anywhere and drag it, the way a window is dragged by its title
 * bar: no press-and-hold, no lift, and a shadow only while it is travelling,
 * so the card the hand is holding reads as the one off the page. The press
 * starts a drag on the spot; the drag only counts once the pointer has travelled a few pixels, so
 * a plain click still reaches whatever was under it. The card's own controls
 * keep their gestures: a button, a link, selectable copy, a resize grip and a
 * scrollbar all own the press that lands on them. The parent decides what a
 * drop means via `onDragEnd`.
 */

export type DragPoint = { x: number; y: number };

/**
 * A press on any of these belongs to the element, not to the card. Selectable
 * copy (the gloss hosts) and the resize grips say so themselves; the rest are
 * the controls a reader clicks or types into.
 */
const OWNS_ITS_PRESS = "[data-selectable],[data-no-lift],button,a,input,textarea,select,[contenteditable]";

/** How a move between slots animates once the gesture is over. */
const SETTLE_SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

/**
 * Whether the press landed on a scrollbar of some scroller between the target
 * and the card. A scrollbar is drawn inside its element's box, past the client
 * area, so a press there is a press on the element with a coordinate outside
 * `clientWidth`/`clientHeight`. Dragging the holdings list's thumb must scroll
 * the list, not move the card.
 */
function onScrollbar(target: HTMLElement, root: HTMLElement, x: number, y: number): boolean {
  for (let el: HTMLElement | null = target; el && el !== root; el = el.parentElement) {
    const vertical = el.offsetWidth - el.clientWidth;
    const horizontal = el.offsetHeight - el.clientHeight;
    if (vertical <= 0 && horizontal <= 0) continue;
    const rect = el.getBoundingClientRect();
    if (vertical > 0 && x >= rect.left + el.clientLeft + el.clientWidth) return true;
    if (horizontal > 0 && y >= rect.top + el.clientTop + el.clientHeight) return true;
  }
  return false;
}

/** Alt, from whichever kind of event framer hands the drag callbacks. */
function altOf(e: MouseEvent | TouchEvent | PointerEvent): boolean {
  return "altKey" in e ? e.altKey : false;
}

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
  /** The drag has begun: the pointer has moved far enough for the press to be a drag. */
  onLift?: () => void;
  /**
   * The drag is under way: where the pointer is, how far it has travelled
   * from the press, and whether Alt is down (the key that holds a snap off).
   *
   * On a canvas the caller may answer with a correction in pixels — the
   * distance between where the pointer has taken the card and where it would
   * actually land. The card carries that correction for as long as it holds,
   * which is how a snap is seen while it is happening rather than on release.
   */
  onDragMove?: (point: DragPoint, offset: DragPoint, alt: boolean) => DragPoint | void;
  /** Where the pointer let go, how far it travelled from the press, and Alt. */
  onDragEnd?: (point: DragPoint, offset: DragPoint, alt: boolean) => void;
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
  const [dragging, setDragging] = useState(false);
  /**
   * The press has landed somewhere that a drag can start from, and has not
   * been let go. The card takes on the held look here rather than waiting for
   * the drag to begin: the reader has hold of it from the first moment, and
   * the hand and the shadow are how the card says so.
   */
  const [held, setHeld] = useState(false);
  /** The pointer that began this press has not been let go yet. */
  const down = useRef(false);
  /** This drag has been settled: the caller has been told where it ended. */
  const settled = useRef(false);

  /**
   * The end of a drag, wherever it comes from — framer's own report, or the
   * start of a drag that had already been let go. Runs once per gesture.
   *
   * On a canvas the caller has just moved the box to where the card is, so
   * the transform that carried it there is zeroed in the same frame: the box
   * lands under the card and nothing is seen to move.
   */
  const settle = (e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (settled.current) return;
    settled.current = true;
    setDragging(false);
    onDragEnd?.({ x: info.point.x, y: info.point.y }, { x: info.offset.x, y: info.offset.y }, altOf(e));
    if (free) {
      dragX.jump(0);
      dragY.jump(0);
    }
  };

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
      transition={{
        // Position and size follow the handle with nothing in between; once
        // the gesture is over, a move between slots is worth animating.
        layout: instant ? { duration: 0 } : SETTLE_SPRING,
        default: instant ? { duration: 0 } : SETTLE_SPRING,
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest?.(OWNS_ITS_PRESS)) return;
        if (target && onScrollbar(target, e.currentTarget, e.clientX, e.clientY)) return;
        // The held look starts now, not at the drag: a press on a card the
        // reader can move should feel like one. Let go anywhere — the card,
        // another window, off the screen — and it is over, so the release is
        // listened for on the window rather than on the card.
        setHeld(true);
        down.current = true;
        settled.current = false;
        const release = () => {
          setHeld(false);
          down.current = false;
          window.removeEventListener("pointerup", release);
          window.removeEventListener("pointercancel", release);
        };
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);
        // Handed to framer at once. Its pan session waits for a few pixels of
        // travel before it reports a drag, which is what keeps a click a click.
        controls.start(e.nativeEvent, { snapToCursor: false });
      }}
      onDragStart={(e, info: PanInfo) => {
        setDragging(true);
        onLift?.();
        // A flick can be let go before the drag it started has been worked
        // out — the release arrives while the move is still queued, and the
        // end of the gesture is then never reported. The card would keep the
        // travel in its transform and the caller would never learn where it
        // came to rest. Settle it here instead: the button is already up, so
        // this drag is over as soon as it has begun.
        if (!down.current) settle(e, info);
      }}
      onDrag={(e, info: PanInfo) => {
        // Settled already — a drag that was let go before it started. Framer
        // still has this one move to deliver; the card must not take it.
        if (settled.current) {
          if (free) {
            dragX.jump(0);
            dragY.jump(0);
          }
          return;
        }
        const nudge = onDragMove?.(
          { x: info.point.x, y: info.point.y },
          { x: info.offset.x, y: info.offset.y },
          altOf(e),
        );
        // The drag transform is framer's travelled distance; the correction
        // rides on top of it. Framer takes its own reading from where the
        // card started, not from this value, so writing to it here moves the
        // card without the next frame compounding what was written.
        if (free && nudge) {
          dragX.set(info.offset.x + nudge.x);
          dragY.set(info.offset.y + nudge.y);
        }
      }}
      onDragEnd={(e, info: PanInfo) => settle(e, info)}
      onClickCapture={(e) => {
        // A drag that ends over a button shouldn't also click it. The click
        // fires on the release that ends the drag, before the state flips.
        if (dragging) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      className={cn(
        // `pan-y`, not `none`. touch-action is intersected down the tree, so a
        // card that claimed the whole gesture also took it from anything
        // scrollable inside it — the holdings list could be dragged nowhere and
        // scrolled not at all by touch or pen. Vertical panning belongs to
        // whatever is under the finger.
        "relative touch-pan-y rounded-3xl transition-shadow duration-150",
        // Off the page by a little for as long as it is held: enough to tell
        // the held card from the ones it passes over, not enough to make a
        // shape of its own. The closed hand says the same thing.
        held || dragging ? "cursor-grabbing shadow-[0_10px_28px_-12px_rgba(29,27,27,0.28)]" : "",
        dragging ? "z-50 select-none" : "",
        className,
      )}
      // A card being dragged rides above the others; otherwise the box keeps
      // the z-index the caller gave it (a canvas orders its cards by touch).
      // The drag transform lives in motion values so a free drop can zero it
      // without a re-render.
      style={{ ...style, x: dragX, y: dragY, zIndex: dragging ? 50 : style?.zIndex }}
    >
      {children}
    </motion.div>
  );
}
