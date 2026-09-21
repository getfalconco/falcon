/**
 * The dashboard as a canvas: every module is a box with its own position,
 * size and place in the stacking order, and the reader puts it wherever
 * they like. Boxes may overlap; whichever one was touched last is on top.
 *
 * Horizontal measures are shares of the canvas width, vertical ones pixels.
 * A module that takes seventy percent of a wide monitor takes seventy percent
 * of a laptop too, instead of a pixel count that runs off its edge; heights
 * have no such edge to run off, and a card's height is about its content.
 *
 * Nothing leaves the canvas sideways: a box is held between the left and
 * right edges whatever is done to it, because a card past the edge is a
 * scrollbar on a page that should never scroll that way. Downward is open;
 * the canvas grows to follow.
 *
 * Pure: nothing here knows about the DOM or React. The page measures the
 * canvas and drives pointer events; this module answers what the layout
 * becomes. Kept apart so the rules can be tested without a window.
 */

export type ModuleBox = {
  /** Left edge, as a share of the canvas width. */
  x: number;
  /** Top edge, in pixels. */
  y: number;
  /** Width, as a share of the canvas width. */
  w: number;
  /** Height, in pixels. */
  h: number;
};

export type CanvasLayout = {
  boxes: Record<string, ModuleBox>;
  /** Stacking order, back to front. Every id in `boxes` appears exactly once. */
  order: string[];
};

export type Edge = "l" | "r" | "t" | "b" | "tl" | "tr" | "bl" | "br";

export const CANVAS_LAYOUT_KEY = "falcon.ui.canvas.v1";

/**
 * How narrow a resize will make a module. A box already narrower than this
 * (a share saved on a wide monitor, drawn on a laptop) keeps the width it
 * has as its floor instead, so touching a handle never makes it jump.
 */
export const MODULE_MIN_W_PX = 300;
export const MODULE_MIN_H = 240;
export const MODULE_MAX_H = 1400;
/** Room under the lowest module, so there is always somewhere to drag to. */
const BOTTOM_ROOM = 120;
/** Where a copy lands relative to its original: a step down and right. */
const COPY_OFFSET_PX = 28;

/** What a saved layout is read from and written to; localStorage in the app. */
export type LayoutStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isBox(v: unknown): v is ModuleBox {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return finite(b.x) && finite(b.y) && finite(b.w) && finite(b.h) && b.w > 0 && b.h > 0;
}

/** A box held inside the canvas sideways and below its top. */
function contain(b: ModuleBox): ModuleBox {
  const w = Math.min(1, b.w);
  const x = Math.min(Math.max(0, b.x), 1 - w);
  return { x, y: Math.max(0, b.y), w, h: b.h };
}

/**
 * The saved layout, or null when there is none or it cannot be trusted. A
 * layout whose order and boxes disagree is treated as absent rather than
 * repaired: the seed is a known-good arrangement, a repair is a guess. A box
 * that had strayed off the canvas is brought back in.
 */
export function loadCanvasLayout(store: LayoutStore): CanvasLayout | null {
  try {
    const raw = store.getItem(CANVAS_LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CanvasLayout>;
    if (!parsed.boxes || !Array.isArray(parsed.order)) return null;
    const boxes: Record<string, ModuleBox> = {};
    for (const [id, box] of Object.entries(parsed.boxes)) {
      if (isBox(box)) boxes[id] = contain(box);
    }
    const order = parsed.order.filter((id): id is string => typeof id === "string" && id in boxes);
    if (order.length === 0) return null;
    if (order.length !== Object.keys(boxes).length || new Set(order).size !== order.length) return null;
    return { boxes, order };
  } catch {
    return null;
  }
}

export function saveCanvasLayout(store: LayoutStore, layout: CanvasLayout): void {
  try {
    const tidy: Record<string, ModuleBox> = {};
    for (const [id, b] of Object.entries(layout.boxes)) {
      tidy[id] = { x: +b.x.toFixed(4), y: Math.round(b.y), w: +b.w.toFixed(4), h: Math.round(b.h) };
    }
    store.setItem(CANVAS_LAYOUT_KEY, JSON.stringify({ boxes: tidy, order: layout.order }));
  } catch {
    /* a full disk must not break the layout */
  }
}

/** A card's size as the old row kept it: a share of the row's width, pixels tall. */
export type FlowSize = { w: number; h: number };

/**
 * The boxes the old wrapping row would have laid out for these cards, so the
 * canvas opens looking exactly as the dashboard did the day before. Cards go
 * left to right at their share of the width, wrap when the next would not
 * fit, and each row is as tall as its tallest card. The row kept fixed pixel
 * gaps and took each card's part of them out of its share (`w·W − gap·(1−w)`),
 * so the same arithmetic is run here in pixels and turned back into shares.
 * No floor is put under the width: the row had none, and the point is to
 * reproduce it.
 */
export function layoutFromFlow(
  ids: readonly string[],
  sizes: Record<string, FlowSize>,
  fallback: FlowSize,
  canvasW: number,
  gap = 16,
): CanvasLayout {
  const W = Math.max(1, canvasW);
  const boxes: Record<string, ModuleBox> = {};
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const id of ids) {
    const size = sizes[id] ?? fallback;
    const px = Math.max(1, size.w * W - gap * (1 - size.w));
    if (x > 0 && x + px > W + 0.5) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    boxes[id] = contain({ x: x / W, y, w: px / W, h: Math.max(MODULE_MIN_H, size.h) });
    x += px + gap;
    rowH = Math.max(rowH, size.h);
  }
  return { boxes, order: [...ids] };
}

/**
 * The layout with any card the page wants but the saved layout lacks laid
 * out underneath (in the old row's manner), and any card it no longer shows
 * dropped. A card that was hidden and comes back should appear somewhere
 * sensible, not vanish. Hands back the same object when nothing changes.
 */
export function reconcileCanvasLayout(
  layout: CanvasLayout,
  ids: readonly string[],
  sizes: Record<string, FlowSize>,
  fallback: FlowSize,
  canvasW: number,
): CanvasLayout {
  const want = new Set(ids);
  const boxes: Record<string, ModuleBox> = {};
  const order = layout.order.filter((id) => want.has(id));
  for (const id of order) boxes[id] = layout.boxes[id];
  const missing = ids.filter((id) => !(id in boxes));
  if (missing.length === 0) {
    return order.length === layout.order.length ? layout : { boxes, order };
  }
  const below = order.length ? canvasHeight({ boxes, order }, 0) - BOTTOM_ROOM + 16 : 0;
  const fresh = layoutFromFlow(missing, sizes, fallback, canvasW);
  for (const id of fresh.order) {
    boxes[id] = { ...fresh.boxes[id], y: fresh.boxes[id].y + below };
    order.push(id);
  }
  return { boxes, order };
}

/** The touched module goes on top; nothing else changes. */
export function bringToFront(layout: CanvasLayout, id: string): CanvasLayout {
  if (!(id in layout.boxes)) return layout;
  if (layout.order[layout.order.length - 1] === id) return layout;
  return { ...layout, order: [...layout.order.filter((o) => o !== id), id] };
}

/**
 * A box moved so its top-left corner is at (px, py) pixels, held inside the
 * canvas sideways and below the top. The bottom is open; the canvas grows.
 */
export function moveBox(layout: CanvasLayout, id: string, px: number, py: number, canvasW: number): CanvasLayout {
  const b = layout.boxes[id];
  if (!b) return layout;
  const W = Math.max(1, canvasW);
  const next = contain({ ...b, x: px / W, y: py });
  if (Math.abs(next.x - b.x) < 1e-6 && next.y === b.y) return layout;
  return { ...layout, boxes: { ...layout.boxes, [id]: next } };
}

/**
 * A box resized by dragging one of its edges or corners by (dx, dy) pixels.
 * The right and bottom edges change only the size; the left and top edges
 * move that edge, so the opposite one stays put under the reader's eye.
 * Neither side leaves the canvas, and the width never drops below the
 * readable minimum — or below what it already was, whichever is smaller,
 * so a handle on an already-narrow box does not jump on the first pixel.
 */
export function resizeBoxFromEdge(
  layout: CanvasLayout,
  id: string,
  edge: Edge,
  dx: number,
  dy: number,
  canvasW: number,
): CanvasLayout {
  const b = layout.boxes[id];
  if (!b) return layout;
  const W = Math.max(1, canvasW);
  let xPx = b.x * W;
  let wPx = b.w * W;
  const minW = Math.min(MODULE_MIN_W_PX, wPx);
  let y = b.y;
  let h = b.h;
  if (edge.includes("r")) wPx = Math.min(W - xPx, Math.max(minW, wPx + dx));
  if (edge.includes("l")) {
    const right = xPx + wPx;
    xPx = Math.max(0, Math.min(right - minW, xPx + dx));
    wPx = right - xPx;
  }
  if (edge.includes("b")) h = Math.min(MODULE_MAX_H, Math.max(MODULE_MIN_H, h + dy));
  if (edge.includes("t")) {
    const bottom = y + h;
    y = Math.max(0, Math.min(bottom - MODULE_MIN_H, y + dy));
    h = Math.min(MODULE_MAX_H, bottom - y);
  }
  const next = contain({ x: xPx / W, y: Math.round(y), w: wPx / W, h: Math.round(h) });
  if (Math.abs(next.x - b.x) < 1e-6 && Math.abs(next.w - b.w) < 1e-6 && next.y === b.y && next.h === b.h) return layout;
  return { ...layout, boxes: { ...layout.boxes, [id]: next } };
}

/** A copy of a module, a step down and right of the original, on top. */
export function duplicateBox(layout: CanvasLayout, id: string, copy: string, canvasW: number): CanvasLayout {
  const b = layout.boxes[id];
  if (!b || copy in layout.boxes) return layout;
  const W = Math.max(1, canvasW);
  const placed = moveBox(
    { boxes: { ...layout.boxes, [copy]: { ...b } }, order: [...layout.order, copy] },
    copy,
    b.x * W + COPY_OFFSET_PX,
    b.y + COPY_OFFSET_PX,
    W,
  );
  return bringToFront(placed, copy);
}

/** How tall the canvas has to be: the lowest module plus room, or the floor. */
export function canvasHeight(layout: CanvasLayout, floor: number): number {
  let bottom = 0;
  for (const b of Object.values(layout.boxes)) bottom = Math.max(bottom, b.y + b.h);
  return Math.max(floor, bottom + BOTTOM_ROOM);
}

/** The z-index a module draws at: its place in the order, front-most highest. */
export function zIndexOf(layout: CanvasLayout, id: string): number {
  const i = layout.order.indexOf(id);
  return i < 0 ? 0 : 10 + i;
}
