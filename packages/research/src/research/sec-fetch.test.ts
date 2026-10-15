import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSecLimiter, sharedSecLimiter } from "./sec-fetch.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("createSecLimiter", () => {
  it("spaces request starts by the minimum gap", async () => {
    const limiter = createSecLimiter({ minGapMs: 40, maxInFlight: 4 });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.schedule(async () => {
          starts.push(Date.now());
        }),
      ),
    );
    assert.equal(starts.length, 5);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 35, `gap ${starts[i]! - starts[i - 1]!}ms`);
  });

  it("never runs more than maxInFlight at once", async () => {
    const limiter = createSecLimiter({ minGapMs: 0, maxInFlight: 2 });
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.schedule(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await sleep(15);
          running -= 1;
        }),
      ),
    );
    assert.equal(peak, 2);
    assert.equal(limiter.stats().started, 8);
  });

  it("keeps going after a failed task and hands the failure to its caller", async () => {
    const limiter = createSecLimiter({ minGapMs: 0 });
    const failed = limiter.schedule(async () => {
      throw new Error("boom");
    });
    const ok = limiter.schedule(async () => "next");
    await assert.rejects(failed, /boom/);
    assert.equal(await ok, "next");
    assert.deepEqual(limiter.stats(), { started: 2, queued: 0, inFlight: 0 });
  });

  it("is one queue per process", () => {
    assert.equal(sharedSecLimiter(), sharedSecLimiter());
  });
});
