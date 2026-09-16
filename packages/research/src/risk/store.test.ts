import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_RISK_CONFIG } from "./config.js";
import { computeRiskSnapshot } from "./compute.js";
import { RiskAccountStore, RiskConfigStore, RiskSnapshotStore } from "./store.js";
import { account, cfg, inputs, position, quant } from "./test-fixtures.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-risk-"));
}

function snap(at: string) {
  return computeRiskSnapshot(inputs({ now: at, account: account([position("NVDA", 1, 100)]), quant: { NVDA: quant() } }), cfg(), { trigger: ["manual"] });
}

describe("risk/store — config", () => {
  it("writes the defaults on first load and merges stored overrides field by field", () => {
    const dir = tmp();
    const store = new RiskConfigStore(dir);
    const first = store.load();
    assert.deepEqual(first, DEFAULT_RISK_CONFIG);
    assert.ok(fs.existsSync(path.join(dir, "config.json")));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ schemaVersion: 3, weights: { network: 0.4 }, riskCardEnabled: true, anchors: { market: "garbage" }, debounceMs: 5 }), "utf8");
    const merged = store.load();
    assert.equal(merged.weights.network, 0.4);
    assert.equal(merged.weights.concentration, 0.18);
    assert.equal(merged.riskCardEnabled, true);
    assert.deepEqual(merged.anchors.market, DEFAULT_RISK_CONFIG.anchors.market);
    assert.equal(merged.debounceMs, 5);
    store.save({ ...merged, riskCardEnabled: false });
    assert.equal(store.load().riskCardEnabled, false);
  });

  it("riskCardEnabled defaults to true (graduated in schema 2)", () => {
    assert.equal(DEFAULT_RISK_CONFIG.riskCardEnabled, true);
    assert.equal(new RiskConfigStore(tmp()).load().riskCardEnabled, true);
  });
});

describe("risk/store — account", () => {
  it("round-trips the renderer's account push and upper-cases tickers", () => {
    const store = new RiskAccountStore(tmp());
    assert.equal(store.load(), null);
    store.save({ account: "paper", cash: 1000, positions: [{ ticker: "nvda", shares: 2, cost_usd: 400, market_value: null }], as_of: "2026-08-24T00:00:00.000Z" });
    const loaded = store.load();
    assert.ok(loaded);
    assert.equal(loaded.cash, 1000);
    assert.deepEqual(loaded.positions, [{ ticker: "NVDA", shares: 2, cost_usd: 400, market_value: null }]);
  });
});

describe("risk/store — snapshots", () => {
  it("appends, returns latest, lists history newest-first", () => {
    const dir = tmp();
    const store = new RiskSnapshotStore(dir, 180);
    assert.equal(store.latest(), null);
    store.append(snap("2026-08-20T21:00:00.000Z"));
    store.append(snap("2026-08-22T21:00:00.000Z"));
    store.append(snap("2026-08-21T21:00:00.000Z"));
    assert.equal(store.count(), 3);
    assert.equal(store.latest()?.computed_at, "2026-08-22T21:00:00.000Z");
    assert.deepEqual(
      store.history().map((h) => h.computed_at),
      ["2026-08-22T21:00:00.000Z", "2026-08-21T21:00:00.000Z", "2026-08-20T21:00:00.000Z"],
    );
    assert.equal(store.history(1).length, 1);
    const item = store.history()[0];
    assert.equal(item.driver_component, "concentration");
    assert.equal(item.band, store.latest()?.band);
    // survives a reload from disk
    const again = new RiskSnapshotStore(dir, 180);
    assert.equal(again.count(), 3);
  });

  it("prunes snapshots older than the retention window", () => {
    const store = new RiskSnapshotStore(tmp(), 2);
    store.append(snap("2026-08-01T21:00:00.000Z"));
    store.append(snap("2026-08-02T21:00:00.000Z"));
    store.append(snap("2026-08-10T21:00:00.000Z"));
    assert.equal(store.count(), 1);
    assert.equal(store.latest()?.computed_at, "2026-08-10T21:00:00.000Z");
  });
});
