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

/** How close, in pixels, a dragged edge has to come to a line before it takes it. */
export const SNAP_PX = 8;
/** The gutter the old row kept between cards; an edge snaps to it as well as to the card. */
export const SNAP_GAP_PX = 16;

/**
 * The lines an edge is currently held to, for the page to draw. Vertical
 * lines are shares of the canvas width, like everything else horizontal, so
 * a guide stays on its edge if the canvas changes width mid-gesture (a
 * scrollbar appearing is enough); horizontal lines are pixels.
 */
export type SnapGuides = {
  v: number[];
  h: number[];
  /**
   * The cards whose width (or height) the resized one has just been made
   * equal to — the other thing a design tool snaps to. An edge has lines; a
   * size has peers, so these are ids, and the page marks the cards themselves.
   */
  sameW: string[];
  sameH: string[];
};
export const NO_GUIDES: SnapGuides = { v: [], h: [], sameW: [], sameH: [] };

/**
 * The nearest of `lines` to `at`, if any is within reach. Ties go to the
 * first, which is the card's own edge rather than its gutter.
 */
function nearest(at: number, lines: readonly number[], reach: number): number | null {
  let best: number | null = null;
  let bestD = reach + 1e-9;
  for (const l of lines) {
    const d = Math.abs(l - at);
    if (d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

/**
 * A box that has just been resized, with the edges that were dragged pulled
 * onto any line they came close to: another card's edge, the gutter beside
 * it, or the canvas's own edge. Only the dragged edges move — the opposite
 * ones stay where they are, so a snap never shifts the card — and a snap
 * that would take the box under its minimum or off the canvas is not taken.
 *
 * Each edge has its own lines. A card's two edges are lines for any edge; its
 * gutter is a line only on the side where a gutter can exist, which is this
 * card's right edge one gap before that card's left, its left edge one gap
 * after that card's right, and the same for bottom against top. The other
 * pairings describe nothing on the canvas, and held an edge sixteen pixels
 * short of the line the reader was heading for.
 *
 * `floorWPx` is the narrowest the box may get, which is the resize's own
 * floor: the readable minimum, or the width the box had when the gesture
 * began if that was already less. Taken from the box as it is now, the floor
 * would rise and fall with the pointer, and a narrow card would snap when
 * approached from one side and not from the other.
 *
 * Where no line takes an edge, a size can: a width or height that comes
 * within reach of another card's is made equal to it, the way a design tool
 * matches dimensions. Same rule — only the dragged edge moves.
 *
 * Returns the lines that were taken and the cards whose size was matched, so
 * they can be shown while they hold.
 */
export function snapResizedBox(
  layout: CanvasLayout,
  id: string,
  edge: Edge,
  canvasW: number,
  floorWPx: number = MODULE_MIN_W_PX,
  reach: number = SNAP_PX,
): { layout: CanvasLayout; guides: SnapGuides } {
  const b = layout.boxes[id];
  if (!b || reach <= 0) return { layout, guides: NO_GUIDES };
  const W = Math.max(1, canvasW);
  const forRight: number[] = [];
  const forLeft: number[] = [];
  const forBottom: number[] = [];
  const forTop: number[] = [];
  for (const [other, o] of Object.entries(layout.boxes)) {
    if (other === id) continue;
    const l = o.x * W;
    const r = (o.x + o.w) * W;
    const t = o.y;
    const bt = o.y + o.h;
    forRight.push(l, r, l - SNAP_GAP_PX);
    forLeft.push(l, r, r + SNAP_GAP_PX);
    forBottom.push(t, bt, t - SNAP_GAP_PX);
    forTop.push(t, bt, bt + SNAP_GAP_PX);
  }
  forRight.push(W);
  forLeft.push(0);
  forTop.push(0);

  let left = b.x * W;
  let right = (b.x + b.w) * W;
  let top = b.y;
  let bottom = b.y + b.h;
  const minW = Math.min(MODULE_MIN_W_PX, Math.max(1, floorWPx));
  const v: number[] = [];
  const h: number[] = [];

  if (edge.includes("r")) {
    const to = nearest(right, forRight, reach);
    if (to != null && to <= W + 1e-6 && to - left >= minW - 1e-6) {
      right = to;
      v.push(to / W);
    }
  }
  if (edge.includes("l")) {
    const to = nearest(left, forLeft, reach);
    if (to != null && to >= -1e-6 && right - to >= minW - 1e-6) {
      left = to;
      v.push(to / W);
    }
  }
  if (edge.includes("b")) {
    const to = nearest(bottom, forBottom, reach);
    if (to != null && to - top >= MODULE_MIN_H && to - top <= MODULE_MAX_H) {
      bottom = to;
      h.push(to);
    }
  }
  if (edge.includes("t")) {
    const to = nearest(top, forTop, reach);
    if (to != null && to >= 0 && bottom - to >= MODULE_MIN_H && bottom - to <= MODULE_MAX_H) {
      top = to;
      h.push(to);
    }
  }
  // Sizes, where no line took the edge. A width within reach of another
  // card's width becomes that width — the dragged edge moves, the opposite
  // one stays — and the same for height. A line wins over a size on its own
  // axis: the line is where the reader can see they were heading, and taking
  // both would move the edge twice.
  const sameW: string[] = [];
  const sameH: string[] = [];
  const others = Object.entries(layout.boxes).filter(([other]) => other !== id);
  if ((edge.includes("r") || edge.includes("l")) && v.length === 0) {
    const to = nearest(
      right - left,
      others.map(([, o]) => o.w * W),
      reach,
    );
    if (to != null && to >= minW - 1e-6) {
      const nl = edge.includes("l") ? right - to : left;
      const nr = edge.includes("l") ? right : left + to;
      if (nl >= -1e-6 && nr <= W + 1e-6) {
        left = nl;
        right = nr;
        for (const [other, o] of others) if (Math.abs(o.w * W - to) < 0.5) sameW.push(other);
      }
    }
  }
  if ((edge.includes("b") || edge.includes("t")) && h.length === 0) {
    const to = nearest(
      bottom - top,
      others.map(([, o]) => o.h),
      reach,
    );
    if (to != null && to >= MODULE_MIN_H && to <= MODULE_MAX_H) {
      const nt = edge.includes("t") ? bottom - to : top;
      if (nt >= 0) {
        top = nt;
        bottom = nt + to;
        for (const [other, o] of others) if (Math.abs(o.h - to) < 0.5) sameH.push(other);
      }
    }
  }

  if (v.length === 0 && h.length === 0 && sameW.length === 0 && sameH.length === 0) {
    return { layout, guides: NO_GUIDES };
  }
  const next = contain({ x: left / W, y: Math.round(top), w: (right - left) / W, h: Math.round(bottom - top) });
  return { layout: { ...layout, boxes: { ...layout.boxes, [id]: next } }, guides: { v, h, sameW, sameH } };
}

/**
 * The nearest correction, within reach, that puts one of a box's edges on a
 * line and keeps the box on the canvas. Candidates are tried in the order
 * they are given, so a tie goes to the edge listed first and, within an edge,
 * to a card's own edge rather than the gutter beside it.
 */
function nearestShift(
  pairs: ReadonlyArray<readonly [number, readonly number[]]>,
  reach: number,
  min: number,
  max: number,
): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null;
  let bestD = reach + 1e-9;
  for (const [at, lines] of pairs) {
    for (const line of lines) {
      const delta = line - at;
      if (delta < min - 1e-6 || delta > max + 1e-6) continue;
      const d = Math.abs(delta);
      if (d < bestD) {
        bestD = d;
        best = { delta, line };
      }
    }
  }
  return best;
}

/**
 * A box that is being dragged, pulled onto any line it came close to. A move
 * never changes the size: the whole box shifts by the smallest correction
 * that puts one of its edges — or its middle — on a line, at most one
 * correction per axis, and only one that keeps the box on the canvas.
 *
 * The lines are the ones a resized edge takes: another card's two edges, the
 * gutter beside it on the side where a gutter can exist, and the canvas's own
 * sides. A middle lines up with another middle as well, which is how two
 * cards of different sizes are centred on each other.
 *
 * Nothing here stops a card being dropped over another: overlapping on
 * purpose is what moving a card is for. The snap only decides where it rests
 * when the reader brings it near a line, and the lines that were taken come
 * back so the page can draw them while they hold.
 */
export function snapMovedBox(
  layout: CanvasLayout,
  id: string,
  canvasW: number,
  reach: number = SNAP_PX,
): { layout: CanvasLayout; guides: SnapGuides } {
  const b = layout.boxes[id];
  if (!b || reach <= 0) return { layout, guides: NO_GUIDES };
  const W = Math.max(1, canvasW);
  const left = b.x * W;
  const wPx = b.w * W;
  const right = left + wPx;
  const top = b.y;
  const bottom = top + b.h;

  const forLeft: number[] = [0];
  const forRight: number[] = [W];
  const forMidX: number[] = [];
  const forTop: number[] = [0];
  const forBottom: number[] = [];
  const forMidY: number[] = [];
  for (const [other, o] of Object.entries(layout.boxes)) {
    if (other === id) continue;
    const l = o.x * W;
    const r = (o.x + o.w) * W;
    const t = o.y;
    const bt = o.y + o.h;
    forLeft.push(l, r, r + SNAP_GAP_PX);
    forRight.push(l, r, l - SNAP_GAP_PX);
    forMidX.push((l + r) / 2);
    forTop.push(t, bt, bt + SNAP_GAP_PX);
    forBottom.push(t, bt, t - SNAP_GAP_PX);
    forMidY.push((t + bt) / 2);
  }

  // Sideways the box is held inside the canvas, so a correction may not take
  // either side past it. Downward there is no floor to hit: the canvas grows.
  const x = nearestShift(
    [
      [left, forLeft],
      [right, forRight],
      [left + wPx / 2, forMidX],
    ],
    reach,
    -left,
    W - right,
  );
  const y = nearestShift(
    [
      [top, forTop],
      [bottom, forBottom],
      [top + b.h / 2, forMidY],
    ],
    reach,
    -top,
    Number.POSITIVE_INFINITY,
  );
  if (!x && !y) return { layout, guides: NO_GUIDES };

  const next = contain({ ...b, x: (left + (x?.delta ?? 0)) / W, y: Math.round(top + (y?.delta ?? 0)) });
  const guides: SnapGuides = { v: x ? [x.line / W] : [], h: y ? [y.line] : [], sameW: [], sameH: [] };
  return { layout: { ...layout, boxes: { ...layout.boxes, [id]: next } }, guides };
}

/** How much two spans share; negative when they do not meet. */
function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/**
 * How much two cards must share on the cross axis to count as facing one
 * another. Corners that merely pass each other are not neighbours, and
 * should neither stop an edge nor grow a seam between them.
 */
const FACING_MIN_PX = 24;

/**
 * A resized box, held a gutter away from the cards its edge is being pushed
 * at. Moving a card is free to overlap anything — that is what the canvas is
 * for — but an edge dragged into a neighbour is nearly always an overshoot,
 * and the gutter is where the reader meant to stop. So a dragged edge stops
 * one gutter short of any card that faces it, and stays there however far
 * the pointer goes on.
 *
 * Only cards the edge was on the near side of AT THE PRESS can stop it: a
 * card already overlapped, or already closer than a gutter, is left alone,
 * or the first touch of a handle would throw the edge back.
 */
export function limitResizedBox(
  layout: CanvasLayout,
  id: string,
  edge: Edge,
  canvasW: number,
  origin: ModuleBox,
  gap: number = SNAP_GAP_PX,
): CanvasLayout {
  const b = layout.boxes[id];
  if (!b) return layout;
  const W = Math.max(1, canvasW);
  let left = b.x * W;
  let right = (b.x + b.w) * W;
  let top = b.y;
  let bottom = b.y + b.h;
  const oLeft = origin.x * W;
  const oRight = (origin.x + origin.w) * W;
  const oTop = origin.y;
  const oBottom = origin.y + origin.h;
  const eps = 0.5;

  for (const [other, o] of Object.entries(layout.boxes)) {
    if (other === id) continue;
    const l = o.x * W;
    const r = (o.x + o.w) * W;
    const t = o.y;
    const bt = o.y + o.h;
    if (overlap(top, bottom, t, bt) >= FACING_MIN_PX) {
      if (edge.includes("r") && oRight <= l - gap + eps) right = Math.min(right, l - gap);
      if (edge.includes("l") && oLeft >= r + gap - eps) left = Math.max(left, r + gap);
    }
    if (overlap(left, right, l, r) >= FACING_MIN_PX) {
      if (edge.includes("b") && oBottom <= t - gap + eps) bottom = Math.min(bottom, t - gap);
      if (edge.includes("t") && oTop >= bt + gap - eps) top = Math.max(top, bt + gap);
    }
  }

  const next = contain({ x: left / W, y: Math.round(top), w: (right - left) / W, h: Math.round(bottom - top) });
  if (Math.abs(next.x - b.x) < 1e-9 && Math.abs(next.w - b.w) < 1e-9 && next.y === b.y && next.h === b.h) return layout;
  return { ...layout, boxes: { ...layout.boxes, [id]: next } };
}

/**
 * The gutter two (or more) cards share: the cards whose right — or bottom —
 * edge is on one side of it, the cards whose left — or top — edge is on the
 * other, and the stretch of it they have in common. It is what a reader takes
 * hold of to resize both sides at once.
 */
export type Seam = {
  /** "v": a vertical gutter between side-by-side cards. "h": a horizontal one. */
  kind: "v" | "h";
  before: string[];
  after: string[];
  /** The middle of the gutter, in px from the canvas's left ("v") or top ("h"). */
  at: number;
  /** The shared stretch, in px on the other axis. */
  from: number;
  to: number;
};

/**
 * Every seam in the layout: pairs of cards exactly a gutter apart that face
 * one another. Cards on the same line are one seam, so a column of two beside
 * one tall card moves as a unit and stays in line.
 */
export function seamsOf(layout: CanvasLayout, canvasW: number, gap: number = SNAP_GAP_PX): Seam[] {
  const W = Math.max(1, canvasW);
  const found = new Map<string, Seam>();
  const add = (kind: "v" | "h", at: number, a: string, b: string, from: number, to: number) => {
    const key = `${kind}${Math.round(at)}`;
    const s = found.get(key);
    if (!s) {
      found.set(key, { kind, before: [a], after: [b], at, from, to });
      return;
    }
    if (!s.before.includes(a)) s.before.push(a);
    if (!s.after.includes(b)) s.after.push(b);
    s.from = Math.min(s.from, from);
    s.to = Math.max(s.to, to);
  };
  const ids = Object.keys(layout.boxes);
  for (const a of ids) {
    const A = layout.boxes[a];
    const aR = (A.x + A.w) * W;
    const aB = A.y + A.h;
    for (const b of ids) {
      if (a === b) continue;
      const B = layout.boxes[b];
      const bL = B.x * W;
      if (Math.abs(aR + gap - bL) < 0.75 && overlap(A.y, aB, B.y, B.y + B.h) >= FACING_MIN_PX) {
        add("v", aR + gap / 2, a, b, Math.max(A.y, B.y), Math.min(aB, B.y + B.h));
      }
      const aL = A.x * W;
      const bR = (B.x + B.w) * W;
      if (Math.abs(aB + gap - B.y) < 0.75 && overlap(aL, aR, bL, bR) >= FACING_MIN_PX) {
        add("h", aB + gap / 2, a, b, Math.max(aL, bL), Math.min(aR, bR));
      }
    }
  }
  return [...found.values()].sort((p, q) => (p.kind === q.kind ? p.at - q.at : p.kind < q.kind ? 1 : -1));
}

/**
 * A seam dragged by `delta` pixels: the cards before it grow by that much and
 * the cards after it give the same up, so the gutter between them travels and
 * keeps its width. The move is clamped to what every card on both sides can
 * take — nobody goes under their floor — and measured from the boxes as they
 * were at the press (`origins`), for the same reason a resize is.
 */
export function dragSeam(
  layout: CanvasLayout,
  seam: Seam,
  delta: number,
  canvasW: number,
  origins: Record<string, ModuleBox>,
): CanvasLayout {
  const W = Math.max(1, canvasW);
  const before = seam.before.filter((id) => origins[id] && layout.boxes[id]);
  const after = seam.after.filter((id) => origins[id] && layout.boxes[id]);
  if (before.length === 0 || after.length === 0) return layout;

  let lo = -Infinity;
  let hi = Infinity;
  if (seam.kind === "v") {
    for (const id of before) {
      const w = origins[id].w * W;
      lo = Math.max(lo, Math.min(MODULE_MIN_W_PX, w) - w);
    }
    for (const id of after) {
      const w = origins[id].w * W;
      hi = Math.min(hi, w - Math.min(MODULE_MIN_W_PX, w));
    }
  } else {
    for (const id of before) {
      lo = Math.max(lo, MODULE_MIN_H - origins[id].h);
      hi = Math.min(hi, MODULE_MAX_H - origins[id].h);
    }
    for (const id of after) {
      hi = Math.min(hi, origins[id].h - MODULE_MIN_H);
      lo = Math.max(lo, origins[id].h - MODULE_MAX_H);
    }
  }
  if (lo > hi) return layout;
  const d = seam.kind === "v" ? Math.min(hi, Math.max(lo, delta)) : Math.round(Math.min(hi, Math.max(lo, delta)));

  const boxes = { ...layout.boxes };
  for (const id of before) {
    const o = origins[id];
    boxes[id] = contain(seam.kind === "v" ? { ...o, w: o.w + d / W } : { ...o, h: o.h + d });
  }
  for (const id of after) {
    const o = origins[id];
    boxes[id] = contain(
      seam.kind === "v" ? { ...o, x: o.x + d / W, w: o.w - d / W } : { ...o, y: o.y + d, h: o.h - d },
    );
  }
  return { ...layout, boxes };
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
