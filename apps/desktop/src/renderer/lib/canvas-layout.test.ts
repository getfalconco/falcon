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
  snapMovedBox,
  snapResizedBox,
  dragSeam,
  limitResizedBox,
  seamsOf,
  zIndexOf,
  type CanvasLayout,
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

describe("snapping a dragged card", () => {
  // The same two cards, on a 1000px canvas: a = 0..400, b = 500..900, both 300
  // tall. `held` puts a third card, 200 wide and 200 tall unless said
  // otherwise, wherever the pointer has carried it.
  const CW = 1000;
  const held = (leftPx: number, topPx: number, wPx = 200, h = 200): CanvasLayout => ({
    boxes: {
      a: { x: 0, y: 0, w: 0.4, h: 300 },
      b: { x: 0.5, y: 0, w: 0.4, h: 300 },
      c: { x: leftPx / CW, y: topPx, w: wPx / CW, h },
    },
    order: ["a", "b", "c"],
  });

  it("takes a neighbour's edge, and the size is untouched", () => {
    const s = snapMovedBox(held(495, 120), "c", CW);
    near(s.layout.boxes.c.x * CW, 500);
    near(s.layout.boxes.c.w * CW, 200);
    assert.equal(s.layout.boxes.c.h, 200);
    assert.deepEqual(s.guides.v, [0.5]);
  });

  it("takes the gutter beside a neighbour", () => {
    // a's right edge is at 400, so a card set down beside it belongs at 416.
    const s = snapMovedBox(held(419, 120), "c", CW);
    near(s.layout.boxes.c.x * CW, 416);
  });

  it("lines a card's top up with a neighbour's top", () => {
    const s = snapMovedBox(held(450, 5), "c", CW);
    assert.equal(s.layout.boxes.c.y, 0);
    assert.deepEqual(s.guides.h, [0]);
  });

  it("centres a card on another when neither pair of edges is near", () => {
    // b runs 500..900, so its middle is 700 and c's is 697.
    const s = snapMovedBox(held(597, 120), "c", CW);
    near(s.layout.boxes.c.x * CW, 600);
    assert.deepEqual(s.guides.v, [0.7]);
  });

  it("snaps to the canvas's own edge", () => {
    const s = snapMovedBox(held(795, 120), "c", CW);
    near((s.layout.boxes.c.x + s.layout.boxes.c.w) * CW, 1000);
  });

  it("leaves a card alone out of reach, and hands back the same layout", () => {
    const dragged = held(450, 120);
    const s = snapMovedBox(dragged, "c", CW);
    assert.equal(s.layout, dragged);
    assert.deepEqual(s.guides, { v: [], h: [], sameW: [], sameH: [] });
  });

  it("passes over a line that would push the card off the canvas for one that fits", () => {
    // c is 100 wide at 893..993. b's right edge (900) and the canvas's own
    // (1000) are both 7px away but would need 7px of room the card has not
    // got; d's right edge, 6px the other way, is the one it can take.
    const withD: CanvasLayout = {
      boxes: { ...held(893, 400, 100).boxes, d: { x: 0.8, y: 0, w: 0.087, h: 300 } },
      order: ["a", "b", "d", "c"],
    };
    const s = snapMovedBox(withD, "c", CW);
    near(s.layout.boxes.c.x * CW, 887);
    near(s.layout.boxes.c.w * CW, 100);
  });

  it("moves nothing but the dragged card", () => {
    const dragged = held(495, 120);
    const s = snapMovedBox(dragged, "c", CW);
    assert.deepEqual(s.layout.boxes.a, dragged.boxes.a);
    assert.deepEqual(s.layout.boxes.b, dragged.boxes.b);
    assert.deepEqual(s.layout.order, dragged.order);
  });
});

describe("snapping a resized edge", () => {
  // Two cards side by side on a 1000px canvas: a = 0..400, b = 500..900, both 300 tall.
  const two = () => ({
    boxes: { a: { x: 0, y: 0, w: 0.4, h: 300 }, b: { x: 0.5, y: 0, w: 0.4, h: 300 } },
    order: ["a", "b"],
  });
  const CW = 1000;

  it("pulls the right edge onto the neighbour's left edge when it comes within reach", () => {
    const dragged = resizeBoxFromEdge(two(), "a", "r", 95, 0, CW); // right edge at 495
    const s = snapResizedBox(dragged, "a", "r", CW);
    near((s.layout.boxes.a.x + s.layout.boxes.a.w) * CW, 500);
    near(s.layout.boxes.a.x, 0);
    assert.deepEqual(s.guides.v, [0.5]);
  });

  it("prefers the gutter when that is the nearer line", () => {
    const dragged = resizeBoxFromEdge(two(), "a", "r", 82, 0, CW); // 482: 2px from the 484 gutter, 18 from the edge
    const s = snapResizedBox(dragged, "a", "r", CW);
    near((s.layout.boxes.a.x + s.layout.boxes.a.w) * CW, 484);
  });

  it("leaves the edge alone out of reach, and hands back the same layout", () => {
    const dragged = resizeBoxFromEdge(two(), "a", "r", 40, 0, CW); // 440
    const s = snapResizedBox(dragged, "a", "r", CW);
    assert.equal(s.layout, dragged);
    assert.deepEqual(s.guides, { v: [], h: [], sameW: [], sameH: [] });
  });

  it("moves only the dragged edge: a left-edge snap keeps the right edge where it is", () => {
    const dragged = resizeBoxFromEdge(two(), "b", "l", -95, 0, CW); // b's left at 405, a's right is 400
    const s = snapResizedBox(dragged, "b", "l", CW);
    near(s.layout.boxes.b.x * CW, 400);
    near((s.layout.boxes.b.x + s.layout.boxes.b.w) * CW, 900);
  });

  it("snaps a bottom edge to the neighbour's bottom, and a corner on both axes at once", () => {
    const taller = { ...two(), boxes: { ...two().boxes, b: { x: 0.5, y: 0, w: 0.4, h: 420 } } };
    const dragged = resizeBoxFromEdge(taller, "a", "br", 97, 115, CW); // right 497, bottom 415
    const s = snapResizedBox(dragged, "a", "br", CW);
    assert.equal(s.layout.boxes.a.h, 420);
    near((s.layout.boxes.a.x + s.layout.boxes.a.w) * CW, 500);
    assert.deepEqual(s.guides, { v: [0.5], h: [420], sameW: [], sameH: [] });
  });

  it("snaps to the canvas's own right edge", () => {
    const dragged = resizeBoxFromEdge(two(), "b", "r", 96, 0, CW); // 996
    const s = snapResizedBox(dragged, "b", "r", CW);
    near((s.layout.boxes.b.x + s.layout.boxes.b.w) * CW, 1000);
  });

  it("does not take a snap that would put the box under its minimum", () => {
    // a is 300px wide (the floor). b's left edge sits 5px inside a's right edge,
    // so snapping a's right edge onto it would make a 295px wide.
    const tight = { boxes: { a: { x: 0, y: 0, w: 0.3, h: 300 }, b: { x: 0.295, y: 400, w: 0.4, h: 300 } }, order: ["a", "b"] };
    const s = snapResizedBox(tight, "a", "r", CW);
    near(s.layout.boxes.a.w * CW, 300);
  });

  it("can be switched off", () => {
    const dragged = resizeBoxFromEdge(two(), "a", "r", 95, 0, CW);
    assert.equal(snapResizedBox(dragged, "a", "r", CW, 300, 0).layout, dragged);
  });
  it("snaps a card narrower than the minimum from BOTH sides of a line", () => {
    // A default quarter card on a 996px canvas is 237px wide. The floor is the
    // width it had at the press, so overshooting the neighbour's edge by 3px is
    // pulled back just as stopping 3px short of it is pulled forward.
    const W2 = 996;
    const l = { boxes: { a: { x: 0, y: 0, w: 237 / W2, h: 560 }, b: { x: 290 / W2, y: 0, w: 300 / W2, h: 560 } }, order: ["a", "b"] };
    const short = snapResizedBox(resizeBoxFromEdge(l, "a", "r", 50, 0, W2), "a", "r", W2, 237);
    near((short.layout.boxes.a.x + short.layout.boxes.a.w) * W2, 290, 1e-6);
    const past = snapResizedBox(resizeBoxFromEdge(l, "a", "r", 56, 0, W2), "a", "r", W2, 237);
    near((past.layout.boxes.a.x + past.layout.boxes.a.w) * W2, 290, 1e-6);
  });

  it("offers a gutter only where a gutter can be: not past a card's far edge", () => {
    // b sits above at 100..500; a is below, its right edge coming in from 550 to
    // line up with b's right edge. There is no line at 516 to be held by.
    const l = { boxes: { a: { x: 0.1, y: 400, w: 0.45, h: 300 }, b: { x: 0.1, y: 0, w: 0.4, h: 300 } }, order: ["a", "b"] };
    const at515 = snapResizedBox(resizeBoxFromEdge(l, "a", "r", -35, 0, CW), "a", "r", CW);
    near((at515.layout.boxes.a.x + at515.layout.boxes.a.w) * CW, 515);
    assert.deepEqual(at515.guides.v, []);
    const at506 = snapResizedBox(resizeBoxFromEdge(l, "a", "r", -44, 0, CW), "a", "r", CW);
    near((at506.layout.boxes.a.x + at506.layout.boxes.a.w) * CW, 500);
    // The gutter before a card's near edge is still a line: a's bottom one gap above a card below it.
    const stacked = { boxes: { a: { x: 0, y: 0, w: 0.4, h: 300 }, c: { x: 0, y: 420, w: 0.4, h: 300 } }, order: ["a", "c"] };
    const down = snapResizedBox(resizeBoxFromEdge(stacked, "a", "b", 0, 99, CW), "a", "b", CW);
    assert.equal(down.layout.boxes.a.h, 404);
  });
});

describe("snapping a resized size", () => {
  const CW = 1000;
  // a = 0..300, 300 tall. b is 400 wide and 420 tall, down and to the right,
  // where none of its edges is a line for anything a's edges can reach here.
  const apart = () => ({
    boxes: { a: { x: 0, y: 0, w: 0.3, h: 300 }, b: { x: 0.55, y: 600, w: 0.4, h: 420 } },
    order: ["a", "b"],
  });

  it("takes another card's width when the dragged width comes within reach of it", () => {
    const dragged = resizeBoxFromEdge(apart(), "a", "r", 95, 0, CW); // 395 wide; b is 400
    const s = snapResizedBox(dragged, "a", "r", CW);
    near(s.layout.boxes.a.w * CW, 400);
    near(s.layout.boxes.a.x, 0);
    assert.deepEqual(s.guides, { v: [], h: [], sameW: ["b"], sameH: [] });
  });

  it("takes a height from the bottom edge, and from the top edge keeps the bottom where it is", () => {
    const down = snapResizedBox(resizeBoxFromEdge(apart(), "a", "b", 0, 115, CW), "a", "b", CW); // 415; b is 420
    assert.equal(down.layout.boxes.a.h, 420);
    assert.deepEqual(down.guides.sameH, ["b"]);

    const lower = {
      boxes: { c: { x: 0, y: 500, w: 0.3, h: 300 }, b: { x: 0.55, y: 600, w: 0.4, h: 420 } },
      order: ["c", "b"],
    };
    const up = snapResizedBox(resizeBoxFromEdge(lower, "c", "t", 0, -115, CW), "c", "t", CW);
    assert.equal(up.layout.boxes.c.h, 420);
    assert.equal(up.layout.boxes.c.y + up.layout.boxes.c.h, 800);
  });

  it("lets a line win over a size on the same axis", () => {
    // a's right edge comes to 405: five from b's left edge at 410, and a width
    // five over b's 400. The edge is the thing in sight, so the edge has it.
    const l = {
      boxes: { a: { x: 0, y: 0, w: 0.3, h: 300 }, b: { x: 0.41, y: 600, w: 0.4, h: 300 } },
      order: ["a", "b"],
    };
    const s = snapResizedBox(resizeBoxFromEdge(l, "a", "r", 105, 0, CW), "a", "r", CW);
    near((s.layout.boxes.a.x + s.layout.boxes.a.w) * CW, 410);
    assert.deepEqual(s.guides.sameW, []);
  });

  it("names every card that shares the size", () => {
    const three = {
      boxes: { ...apart().boxes, c: { x: 0.05, y: 1200, w: 0.4, h: 300 } },
      order: ["a", "b", "c"],
    };
    const s = snapResizedBox(resizeBoxFromEdge(three, "a", "r", 96, 0, CW), "a", "r", CW);
    assert.deepEqual(s.guides.sameW, ["b", "c"]);
  });

  it("is switched off with the rest", () => {
    const dragged = resizeBoxFromEdge(apart(), "a", "r", 95, 0, CW);
    assert.equal(snapResizedBox(dragged, "a", "r", CW, 300, 0).layout, dragged);
  });
});

describe("holding a resized edge off its neighbour", () => {
  const CW = 1000;
  // Side by side: a = 0..400, b = 500..900, both 0..300 down.
  const two = () => ({
    boxes: { a: { x: 0, y: 0, w: 0.4, h: 300 }, b: { x: 0.5, y: 0, w: 0.4, h: 300 } },
    order: ["a", "b"],
  });

  it("stops a right edge one gutter short of the card it faces, however far the pointer goes", () => {
    const origin = two().boxes.a;
    const pushed = resizeBoxFromEdge(two(), "a", "r", 300, 0, CW); // wants 700
    const held = limitResizedBox(pushed, "a", "r", CW, origin);
    near((held.boxes.a.x + held.boxes.a.w) * CW, 484);
    near(held.boxes.a.x, 0);
  });

  it("stops a left edge the same way, and leaves the right edge where it was", () => {
    const origin = two().boxes.b;
    const pushed = resizeBoxFromEdge(two(), "b", "l", -300, 0, CW); // wants 200
    const held = limitResizedBox(pushed, "b", "l", CW, origin);
    near(held.boxes.b.x * CW, 416);
    near((held.boxes.b.x + held.boxes.b.w) * CW, 900);
  });

  it("stops a bottom edge above the card under it", () => {
    const stacked = { boxes: { a: { x: 0, y: 0, w: 0.4, h: 300 }, c: { x: 0, y: 420, w: 0.4, h: 300 } }, order: ["a", "c"] };
    const pushed = resizeBoxFromEdge(stacked, "a", "b", 0, 400, CW);
    assert.equal(limitResizedBox(pushed, "a", "b", CW, stacked.boxes.a).boxes.a.h, 404);
  });

  it("ignores a card that does not face the edge", () => {
    // b is entirely below a: nothing of it is in the way of a's right edge.
    const l = { boxes: { a: { x: 0, y: 0, w: 0.4, h: 300 }, b: { x: 0.5, y: 600, w: 0.4, h: 300 } }, order: ["a", "b"] };
    const pushed = resizeBoxFromEdge(l, "a", "r", 300, 0, CW);
    assert.equal(limitResizedBox(pushed, "a", "r", CW, l.boxes.a), pushed);
  });

  it("does not throw an edge back off a card it already overlapped at the press", () => {
    const l = { boxes: { a: { x: 0, y: 0, w: 0.55, h: 300 }, b: { x: 0.5, y: 0, w: 0.4, h: 300 } }, order: ["a", "b"] };
    const pushed = resizeBoxFromEdge(l, "a", "r", 40, 0, CW);
    assert.equal(limitResizedBox(pushed, "a", "r", CW, l.boxes.a), pushed);
  });
});

describe("seams", () => {
  const CW = 1000;
  // a | b a gutter apart; c stacked a gutter under a.
  const tiled = () => ({
    boxes: {
      a: { x: 0, y: 0, w: 0.4, h: 300 },
      b: { x: 0.416, y: 0, w: 0.4, h: 500 },
      c: { x: 0, y: 316, w: 0.4, h: 184 },
    },
    order: ["a", "b", "c"],
  });

  it("finds the gutter between cards a gutter apart, with everyone on the line", () => {
    const seams = seamsOf(tiled(), CW);
    const v = seams.find((s) => s.kind === "v");
    assert.ok(v);
    assert.deepEqual([...v.before].sort(), ["a", "c"]);
    assert.deepEqual(v.after, ["b"]);
    near(v.at, 408);
    assert.equal(v.from, 0);
    assert.equal(v.to, 500);
    const h = seams.find((s) => s.kind === "h");
    assert.ok(h);
    assert.deepEqual(h.before, ["a"]);
    assert.deepEqual(h.after, ["c"]);
    near(h.at, 308);
  });

  it("finds none between cards that are further apart, or that do not face", () => {
    const apart = { boxes: { a: { x: 0, y: 0, w: 0.4, h: 300 }, b: { x: 0.5, y: 0, w: 0.4, h: 300 } }, order: ["a", "b"] };
    assert.deepEqual(seamsOf(apart, CW), []);
    const diagonal = { boxes: { a: { x: 0, y: 0, w: 0.4, h: 300 }, b: { x: 0.416, y: 600, w: 0.4, h: 300 } }, order: ["a", "b"] };
    assert.deepEqual(seamsOf(diagonal, CW), []);
  });

  it("drags both sides at once and keeps the gutter", () => {
    const l = tiled();
    const v = seamsOf(l, CW).find((s) => s.kind === "v")!;
    const moved = dragSeam(l, v, 60, CW, l.boxes);
    near(moved.boxes.a.w * CW, 460);
    near(moved.boxes.c.w * CW, 460);
    near(moved.boxes.b.x * CW, 476);
    near((moved.boxes.b.x + moved.boxes.b.w) * CW, 816);
    near(moved.boxes.b.x * CW - (moved.boxes.a.x + moved.boxes.a.w) * CW, 16);
  });

  it("stops where the first card on either side reaches its floor", () => {
    const l = tiled();
    const v = seamsOf(l, CW).find((s) => s.kind === "v")!;
    const squeezed = dragSeam(l, v, 500, CW, l.boxes); // b is 400 wide: 100 to give
    near(squeezed.boxes.b.w * CW, MODULE_MIN_W_PX);
    const other = dragSeam(l, v, -500, CW, l.boxes); // a and c are 400 wide
    near(other.boxes.a.w * CW, MODULE_MIN_W_PX);
  });

  it("moves a horizontal seam in whole pixels, the card under it following", () => {
    const l = tiled();
    const h = seamsOf(l, CW).find((s) => s.kind === "h")!;
    // c can only give 184 - MODULE_MIN_H, which is nothing: it is already under the floor.
    const roomy = { ...l, boxes: { ...l.boxes, c: { x: 0, y: 316, w: 0.4, h: 400 } } };
    const moved = dragSeam(roomy, h, 40.4, CW, roomy.boxes);
    assert.equal(moved.boxes.a.h, 340);
    assert.equal(moved.boxes.c.y, 356);
    assert.equal(moved.boxes.c.h, 360);
  });
});
