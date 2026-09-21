import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANVAS_LAYOUT_KEY,
  MODULE_MIN_H,
  MODULE_MIN_W_PX,
  bringToFront,
  canvasHeight,
  duplicateBox,
  layoutFromFlow,
  loadCanvasLayout,
  moveBox,
  reconcileCanvasLayout,
  resizeBoxFromEdge,
  saveCanvasLayout,
  zIndexOf,
  type LayoutStore,
} from "./canvas-layout";

function memoryStore(initial: Record<string, string> = {}): LayoutStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const W = 1856;
const GAP = 16;
const FALLBACK = { w: 0.25, h: 560 };
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

describe("seeding from the old row", () => {
  it("lays a full-width card, then a quarter card on the next row, exactly as the row did", () => {
    const l = layoutFromFlow(["portfolio", "assets"], { portfolio: { w: 1, h: 560 }, assets: { w: 0.25, h: 560 } }, FALLBACK, W, GAP);
    near(l.boxes.portfolio.x, 0);
    near(l.boxes.portfolio.w, 1);
    assert.equal(l.boxes.portfolio.y, 0);
    near(l.boxes.assets.x, 0);
    assert.equal(l.boxes.assets.y, 560 + GAP);
    // A quarter share gives up three quarters of a gap, like the row's calc().
    near(l.boxes.assets.w * W, 0.25 * W - GAP * 0.75);
    assert.deepEqual(l.order, ["portfolio", "assets"]);
  });

  it("keeps two cards on one row when their shares fit, and wraps when they do not", () => {
    const fits = layoutFromFlow(["a", "b"], { a: { w: 0.7, h: 400 }, b: { w: 0.3, h: 300 } }, FALLBACK, W, GAP);
    assert.equal(fits.boxes.b.y, 0);
    near(fits.boxes.b.x * W, 0.7 * W - GAP * 0.3 + GAP);
    const wraps = layoutFromFlow(["a", "b"], { a: { w: 0.7, h: 400 }, b: { w: 0.4, h: 300 } }, FALLBACK, W, GAP);
    assert.equal(wraps.boxes.b.y, 400 + GAP);
    near(wraps.boxes.b.x, 0);
  });

  it("reproduces the row on a narrow window too, without a pixel floor of its own", () => {
    // The old row drew a quarter card at 0.25·W − 12 whatever W was; so does the seed.
    const l = layoutFromFlow(["x"], { x: { w: 0.25, h: 560 } }, FALLBACK, 656, GAP);
    near(l.boxes.x.w * 656, 0.25 * 656 - 12);
  });

  it("uses the fallback size for a card it has no size for", () => {
    const l = layoutFromFlow(["x"], {}, FALLBACK, W, GAP);
    assert.equal(l.boxes.x.h, 560);
  });
});

describe("stacking order", () => {
  it("brings the touched module to the front and leaves the rest in place", () => {
    const l = layoutFromFlow(["a", "b", "c"], {}, FALLBACK, W);
    const after = bringToFront(l, "a");
    assert.deepEqual(after.order, ["b", "c", "a"]);
    assert.ok(zIndexOf(after, "a") > zIndexOf(after, "c"));
    assert.ok(zIndexOf(after, "c") > zIndexOf(after, "b"));
  });

  it("is a no-op for the one already on top, and for an unknown id", () => {
    const l = layoutFromFlow(["a", "b"], {}, FALLBACK, W);
    assert.equal(bringToFront(l, "b"), l);
    assert.equal(bringToFront(l, "nope"), l);
  });
});

describe("moving", () => {
  it("follows the requested pixel point, stored as a share of the width", () => {
    const l = layoutFromFlow(["a", "b"], {}, FALLBACK, W);
    const m = moveBox(l, "b", 40, 300, W);
    near(m.boxes.b.x * W, 40);
    assert.equal(m.boxes.b.y, 300);
    // Overlap is allowed: b now sits over a.
    assert.ok(m.boxes.b.x < m.boxes.a.x + m.boxes.a.w);
  });

  it("never lets a module leave the canvas sideways or above the top", () => {
    const l = layoutFromFlow(["a"], {}, FALLBACK, W);
    const far = moveBox(l, "a", -5000, -5000, W);
    near(far.boxes.a.x, 0);
    assert.equal(far.boxes.a.y, 0);
    const right = moveBox(l, "a", 5000, 10, W);
    near((right.boxes.a.x + right.boxes.a.w) * W, W);
    assert.equal(right.boxes.a.y, 10);
  });

  it("does not allocate when nothing changes", () => {
    const l = layoutFromFlow(["a"], {}, FALLBACK, W);
    assert.equal(moveBox(l, "a", 0, 0, W), l);
  });

  it("keeps the same share on a narrower canvas", () => {
    const l = moveBox(layoutFromFlow(["a"], { a: { w: 0.5, h: 400 } }, FALLBACK, W), "a", 928, 0, W);
    near(l.boxes.a.x, 0.5);
    // Rendered on a 1200px laptop the box starts at 600px and is half the width.
    near(l.boxes.a.x * 1200, 600);
  });
});

describe("resizing from an edge", () => {
  const base = () => layoutFromFlow(["a"], { a: { w: 0.5, h: 400 } }, FALLBACK, W);

  it("the right and bottom edges change only the size", () => {
    const r = resizeBoxFromEdge(base(), "a", "br", 100, 50, W);
    near(r.boxes.a.x, base().boxes.a.x);
    near(r.boxes.a.w * W, base().boxes.a.w * W + 100);
    assert.equal(r.boxes.a.h, 450);
    assert.equal(r.boxes.a.y, 0);
  });

  it("the left and top edges move that edge and keep the opposite one put", () => {
    const moved = moveBox(base(), "a", 400, 200, W);
    const r = resizeBoxFromEdge(moved, "a", "tl", 60, 40, W);
    near(r.boxes.a.x * W, 460);
    near((r.boxes.a.x + r.boxes.a.w) * W, (moved.boxes.a.x + moved.boxes.a.w) * W);
    assert.equal(r.boxes.a.y, 240);
    assert.equal(r.boxes.a.y + r.boxes.a.h, moved.boxes.a.y + moved.boxes.a.h);
  });

  it("stops at the readable minimum instead of inverting", () => {
    const r = resizeBoxFromEdge(base(), "a", "l", 5000, 0, W);
    near(r.boxes.a.w * W, MODULE_MIN_W_PX);
    const s = resizeBoxFromEdge(base(), "a", "t", 5000, 5000, W);
    assert.equal(s.boxes.a.h, MODULE_MIN_H);
    const tiny = resizeBoxFromEdge(base(), "a", "br", -5000, -5000, W);
    near(tiny.boxes.a.w * W, MODULE_MIN_W_PX);
    assert.equal(tiny.boxes.a.h, MODULE_MIN_H);
  });

  it("stays inside the canvas: the right edge stops at the edge, the left at zero", () => {
    const moved = moveBox(base(), "a", 400, 0, W);
    const r = resizeBoxFromEdge(moved, "a", "r", 5000, 0, W);
    near((r.boxes.a.x + r.boxes.a.w) * W, W);
    near(r.boxes.a.x * W, 400);
    const l = resizeBoxFromEdge(moved, "a", "l", -5000, 0, W);
    near(l.boxes.a.x, 0);
    near((l.boxes.a.x + l.boxes.a.w) * W, (moved.boxes.a.x + moved.boxes.a.w) * W);
  });

  it("does not make an already-narrow box jump on the first pixel", () => {
    // A quarter share saved on a wide monitor, drawn on a 656px canvas: 152px wide.
    const narrow = layoutFromFlow(["a"], { a: { w: 0.25, h: 400 } }, FALLBACK, 656, GAP);
    const w0 = narrow.boxes.a.w * 656;
    assert.ok(w0 < MODULE_MIN_W_PX);
    // Already under the minimum, it neither jumps up to it nor shrinks further:
    // a nudge inward leaves it exactly as it is.
    const nudged = resizeBoxFromEdge(narrow, "a", "l", 1, 0, 656);
    near(nudged.boxes.a.x * 656, 0, 1e-3);
    near(nudged.boxes.a.w * 656, w0, 1e-3);
    const grown = resizeBoxFromEdge(narrow, "a", "r", 20, 0, 656);
    near(grown.boxes.a.w * 656, w0 + 20, 1e-3);
  });
});

describe("duplicating", () => {
  it("lands the copy a step down and right, on top", () => {
    const l = layoutFromFlow(["a", "b"], {}, FALLBACK, W);
    const d = duplicateBox(l, "a", "a#1", W);
    near(d.boxes["a#1"].x * W, l.boxes.a.x * W + 28);
    assert.equal(d.boxes["a#1"].y, l.boxes.a.y + 28);
    near(d.boxes["a#1"].w, l.boxes.a.w);
    assert.equal(d.order[d.order.length - 1], "a#1");
  });
});

describe("canvas height", () => {
  it("is the lowest module plus room, or the floor", () => {
    const l = layoutFromFlow(["a"], { a: { w: 1, h: 560 } }, FALLBACK, W);
    assert.equal(canvasHeight(l, 0), 560 + 120);
    assert.equal(canvasHeight(l, 2000), 2000);
    const moved = moveBox(l, "a", 100, 1500, W);
    assert.equal(canvasHeight(moved, 0), 1500 + 560 + 120);
  });
});

describe("persistence", () => {
  it("round-trips through the store", () => {
    const store = memoryStore();
    const l = moveBox(layoutFromFlow(["a", "b"], {}, FALLBACK, W), "b", 12.6, 7.2, W);
    saveCanvasLayout(store, l);
    const back = loadCanvasLayout(store);
    assert.ok(back);
    assert.deepEqual(back.order, l.order);
    assert.equal(back.boxes.b.y, 7); // rounded on the way out
    near(back.boxes.b.x, l.boxes.b.x, 1e-4);
  });

  it("brings a box that had strayed off the canvas back inside", () => {
    const strayed = JSON.stringify({ boxes: { a: { x: -0.4, y: -30, w: 0.5, h: 300 }, b: { x: 0.9, y: 0, w: 0.5, h: 300 } }, order: ["a", "b"] });
    const back = loadCanvasLayout(memoryStore({ [CANVAS_LAYOUT_KEY]: strayed }));
    assert.ok(back);
    near(back.boxes.a.x, 0);
    assert.equal(back.boxes.a.y, 0);
    near(back.boxes.b.x + back.boxes.b.w, 1);
  });

  it("refuses a layout whose order and boxes disagree, and garbage", () => {
    assert.equal(loadCanvasLayout(memoryStore()), null);
    assert.equal(loadCanvasLayout(memoryStore({ [CANVAS_LAYOUT_KEY]: "{not json" })), null);
    const bad = JSON.stringify({ boxes: { a: { x: 0, y: 0, w: 0.5, h: 300 } }, order: ["a", "a"] });
    assert.equal(loadCanvasLayout(memoryStore({ [CANVAS_LAYOUT_KEY]: bad })), null);
    const halfBox = JSON.stringify({ boxes: { a: { x: 0, y: "no", w: 0.5, h: 300 } }, order: ["a"] });
    assert.equal(loadCanvasLayout(memoryStore({ [CANVAS_LAYOUT_KEY]: halfBox })), null);
  });
});

describe("reconcile", () => {
  it("adds a wanted card below what is there, and drops one no longer shown", () => {
    const saved = layoutFromFlow(["a", "b"], { a: { w: 1, h: 560 } }, FALLBACK, W);
    const r = reconcileCanvasLayout(saved, ["a", "c"], {}, FALLBACK, W);
    assert.deepEqual(r.order, ["a", "c"]);
    assert.ok(!("b" in r.boxes));
    assert.ok(r.boxes.c.y >= saved.boxes.a.y + saved.boxes.a.h);
    assert.deepEqual(r.boxes.a, saved.boxes.a);
  });

  it("hands back the same object when nothing is missing or extra", () => {
    const saved = layoutFromFlow(["a", "b"], {}, FALLBACK, W);
    assert.equal(reconcileCanvasLayout(saved, ["a", "b"], {}, FALLBACK, W), saved);
  });
});
