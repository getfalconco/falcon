import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { RiskConfigStore } from "./store.js";

function dirWith(config: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risk-migrate-"));
  if (config != null) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
  }
  return dir;
}

describe("risk config graduation (schema 2 then 3)", () => {
  it("a fresh install starts with the card on", () => {
    const store = new RiskConfigStore(dirWith(null));
    assert.equal(store.load().riskCardEnabled, true);
  });

  it("a schema-1 config's frozen default is dropped, once, and persisted", () => {
    const dir = dirWith({ schemaVersion: 1, riskCardEnabled: false, payloadTop: 3 });
    const store = new RiskConfigStore(dir);
    const config = store.load();
    assert.equal(config.riskCardEnabled, true);
    assert.equal(config.schemaVersion, 3);
    // The user's real overrides survive the migration.
    assert.equal(config.payloadTop, 3);
    // And the file on disk is now v2, so this never runs twice.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(onDisk.schemaVersion, 3);
    assert.equal(onDisk.riskCardEnabled, true);
  });

  it("a post-graduation opt-out is honoured", () => {
    const store = new RiskConfigStore(dirWith({ schemaVersion: 3, riskCardEnabled: false }));
    assert.equal(store.load().riskCardEnabled, false);
  });

  it("schema 3 drops a pre-Sharpe blend: five weights summing to 1 must not gain a sixth", () => {
    const dir = dirWith({
      schemaVersion: 2,
      riskCardEnabled: false,
      weights: { concentration: 0.2, market: 0.2, volatility: 0.2, network: 0.25, event: 0.15 },
      payloadTop: 7,
    });
    const config = new RiskConfigStore(dir).load();
    const total = Object.values(config.weights).reduce((s, w) => s + w, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, "weights sum to " + total);
    assert.equal(config.weights.network, 0.22);
    assert.equal(config.weights.sharpe, 0.12);
    // A choice made after the card graduated still stands, and so do other knobs.
    assert.equal(config.riskCardEnabled, false);
    assert.equal(config.payloadTop, 7);
  });

  it("a schema-3 blend is left alone", () => {
    const stored = { concentration: 0.3, market: 0.1, volatility: 0.1, network: 0.2, event: 0.1, sharpe: 0.2 };
    const config = new RiskConfigStore(dirWith({ schemaVersion: 3, weights: stored })).load();
    assert.deepEqual(config.weights, stored);
  });
});
