import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gauge } from "./compute.js";
import { GaugeSnapshotStore, snapshotKey, toSnapshot } from "./store.js";
import { cfg, coiledQuant, ctx, inputs } from "./test-fixtures.js";

const config = cfg();

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gauge-ledger-"));
}

describe("gauge/store — §10 setup ledger", () => {
  it("a standalone readout becomes one line with the setup, the state and the numbers", () => {
    const s = toSnapshot(gauge(inputs({ quant: coiledQuant() }), config))!;
    assert.equal(s.ticker, "NVDA");
    assert.equal(s.setup, "coiled");
    assert.equal(s.state, "actionable");
    assert.equal(s.session, "2026-08-21");
    assert.equal(s.readable, true);
    assert.equal(s.values.vol_regime, 0.7);
    assert.equal(s.values.volume_ratio, 0.6);
  });

  it("context readouts are never recorded — they describe a thesis, not the tape", () => {
    assert.equal(toSnapshot(gauge(inputs({ quant: coiledQuant() }), config, ctx())), null);
  });

  it("untracked names and readouts with no session are skipped", () => {
    assert.equal(toSnapshot(gauge(inputs({ tracked: false }), config)), null);
    assert.equal(toSnapshot(gauge(inputs({ quant: null }), config)), null);
  });

  it("re-reading the same session writes one line; a changed setup writes another", () => {
    const dir = tmpDir();
    try {
      const store = new GaugeSnapshotStore(dir);
      const coiled = gauge(inputs({ quant: coiledQuant() }), config);
      assert.ok(store.record(coiled));
      assert.equal(store.record(coiled), null, "a recompute is not an event");
      assert.equal(store.count(), 1);

      const moved = gauge(inputs({ quant: coiledQuant(), next_earnings: { due_at: "2026-08-26T20:00:00.000Z", sessions_until: 2, fiscal_period: "Q2" } }), config);
      assert.ok(store.record(moved));
      assert.equal(store.count(), 2);
      assert.deepEqual(store.list().map((s) => s.setup), ["coiled", "coiled_event_ahead"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second process sees the keys already on disk", () => {
    const dir = tmpDir();
    try {
      const readout = gauge(inputs({ quant: coiledQuant() }), config);
      assert.ok(new GaugeSnapshotStore(dir).record(readout));
      assert.equal(new GaugeSnapshotStore(dir).record(readout), null);
      assert.equal(new GaugeSnapshotStore(dir).count(), 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the ledger is trimmed from the front, never unbounded", () => {
    const dir = tmpDir();
    try {
      const store = new GaugeSnapshotStore(dir, 3);
      for (let i = 0; i < 6; i++) {
        const r = gauge(inputs({ ticker: `T${i}`, quant: coiledQuant() }), config);
        store.record(r);
      }
      assert.equal(store.count(), 3);
      assert.deepEqual(store.list().map((s) => s.ticker), ["T3", "T4", "T5"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a torn line never fails a readout", () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "snapshots.jsonl"), "{not json\n", "utf8");
      const store = new GaugeSnapshotStore(dir);
      assert.ok(store.record(gauge(inputs({ quant: coiledQuant() }), config)));
      assert.equal(store.list().length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the key is (ticker, session, setup, state)", () => {
    const s = toSnapshot(gauge(inputs({ quant: coiledQuant() }), config))!;
    assert.equal(snapshotKey(s), "NVDA|2026-08-21|coiled|actionable");
  });
});
