// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/streaming-reveal.test.ts
// Word reveal pacing: reading pace when slow, keeps up with fast streams, never far behind; words never re-fade.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REVEAL_PACE, RevealClock, revealStep, splitWords, wordEnd } from "./streaming-reveal";

const FRAME = 1 / 60;

/** Runs the reveal against a stream that grows `cps` characters a second for `seconds`; returns the largest lag seen. */
function simulate(cps: number, seconds: number, burst = 0): { maxLag: number; endLag: number; settle: number } {
  let pos = 0;
  let target = burst;
  let maxLag = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    target += cps * FRAME;
    pos = revealStep(pos, Math.floor(target), FRAME);
    maxLag = Math.max(maxLag, Math.floor(target) - pos);
  }
  const endLag = Math.floor(target) - pos;
  let settle = 0;
  while (pos < Math.floor(target)) {
    pos = revealStep(pos, Math.floor(target), FRAME);
    settle += FRAME;
  }
  return { maxLag, endLag, settle };
}

test("a slow stream is shown at the reading pace, close behind", () => {
  // 40 characters a second: slower than the reading pace, so the reveal waits on the stream.
  const r = simulate(40, 5);
  assert.ok(r.maxLag < 10, `lag ${r.maxLag}`);
});

test("a fast stream is followed about half a second behind, not further", () => {
  // ~400 characters a second (a fast model).
  const r = simulate(400, 10);
  assert.ok(r.endLag <= 400 * 0.6, `lag ${r.endLag}`);
  assert.ok(r.maxLag <= REVEAL_PACE.maxLag);
});

test("a burst (a whole answer at once) types out within about two seconds", () => {
  const r = simulate(0, 0, 3_000);
  assert.ok(r.settle < 2.6, `settled in ${r.settle.toFixed(2)} s`);
  // and never more than maxLag behind
  let pos = 0;
  pos = revealStep(pos, 5_000, FRAME);
  assert.ok(5_000 - pos <= REVEAL_PACE.maxLag);
});

test("the reading pace is about 80 ms a word", () => {
  let pos = 0;
  pos = revealStep(pos, 10_000_000, 0.08, { ...REVEAL_PACE, catchUpS: 1e9, maxLag: 1e9 });
  assert.ok(pos > 4 && pos < 7, `${pos} chars in 80 ms`);
});

test("text that shrank is followed at once; a frozen tab catches up in one step", () => {
  assert.equal(revealStep(50, 20, FRAME), 20);
  assert.equal(revealStep(0, 300, 5), 300);
});

test("words are never cut in half", () => {
  const t = "Revenue grew 8% to $94.9B";
  assert.equal(wordEnd(t, 3), 7);
  assert.equal(wordEnd(t, 8), 8);
  assert.equal(wordEnd(t, 0), 0);
  assert.equal(wordEnd(t, 99), t.length);
  assert.deepEqual(splitWords("a  b c"), ["a  ", "b ", "c"]);
});

test("a word fades once: later renders and re-keyed parses do not fade it again", () => {
  const c = new RevealClock(250);
  assert.equal(c.fresh("w0", 1000), true);
  assert.equal(c.fresh("w0", 1100), true);
  assert.equal(c.fresh("w0", 1300), false);
  assert.equal(c.fresh("w0", 5000), false);
  c.settle("w1");
  assert.equal(c.fresh("w1", 0), false);
  // settle never makes a fading word old
  c.settle("w0");
  assert.equal(c.fresh("w0", 1001), true);
});
