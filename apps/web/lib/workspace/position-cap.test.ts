// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/position-cap.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAP_DEFAULT, cleanCap, readCap, writeCap } from "./position-cap";

test("the position cap is a whole percent from 5 to 50, 10 by default, per person", () => {
  assert.equal(CAP_DEFAULT, 10);
  assert.equal(cleanCap("abc"), 10);
  assert.equal(cleanCap(2), 5);
  assert.equal(cleanCap(80), 50);
  assert.equal(cleanCap("12.6"), 13);
  assert.equal(readCap("u1"), 10);
  writeCap("u1:w-2", 20);
  assert.equal(readCap("u1"), 20, "set in any workspace, it is the person's");
  assert.equal(readCap("u2"), 10);
});
