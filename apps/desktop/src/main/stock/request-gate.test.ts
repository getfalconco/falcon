import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asBulk, createRequestGate, inBulkLane } from "./request-gate";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("createRequestGate", () => {
  it("holds bulk reads to bulkMax and all reads to max", async () => {
    const gate = createRequestGate({ max: 6, bulkMax: 4, maxWaitMs: 5_000 });
    const work = () => sleep(10);
    await Promise.all([
      ...Array.from({ length: 40 }, () => asBulk(() => gate.run(work))),
      ...Array.from({ length: 10 }, () => gate.run(work)),
    ]);
    const s = gate.stats();
    assert.equal(s.peakBulk, 4);
    assert.ok(s.peak <= 6, `peak ${s.peak}`);
    assert.deepEqual({ inFlight: s.inFlight, bulkInFlight: s.bulkInFlight, waiting: s.waiting }, { inFlight: 0, bulkInFlight: 0, waiting: 0 });
  });

  it("lets an interactive read start before queued bulk reads", async () => {
    const gate = createRequestGate({ max: 2, bulkMax: 2, maxWaitMs: 5_000 });
    const order: string[] = [];
    const bulkReads = Array.from({ length: 6 }, (_, i) =>
      asBulk(() =>
        gate.run(async () => {
          order.push(`b${i}`);
          await sleep(10);
        }),
      ),
    );
    await sleep(1);
    const chart = gate.run(async () => {
      order.push("chart");
    });
    await Promise.all([...bulkReads, chart]);
    // Two bulk reads were already running; the chart takes the first slot that frees.
    assert.equal(order.indexOf("chart"), 2);
  });

  it("fails soft when no slot frees within the wait", async () => {
    const gate = createRequestGate({ max: 1, bulkMax: 1, maxWaitMs: 20 });
    const long = gate.run(() => sleep(80));
    await assert.rejects(gate.run(async () => "late"), /timed out/);
    await long;
    assert.equal(await gate.run(async () => "after"), "after");
    assert.equal(gate.stats().waiting, 0);
  });

  it("releases the slot when the task throws", async () => {
    const gate = createRequestGate({ max: 1, bulkMax: 1, maxWaitMs: 1_000 });
    await assert.rejects(gate.run(async () => Promise.reject(new Error("503"))), /503/);
    assert.equal(await gate.run(async () => 1), 1);
  });

  it("carries the bulk lane through awaits", async () => {
    assert.equal(inBulkLane(), false);
    const seen = await asBulk(async () => {
      await sleep(1);
      return inBulkLane();
    });
    assert.equal(seen, true);
  });
});
