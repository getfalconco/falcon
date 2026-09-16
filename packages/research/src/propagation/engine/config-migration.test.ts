import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PropagationConfigStore } from "./store.js";

function dirWith(config: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prop-migrate-"));
  if (config != null) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
  }
  return dir;
}

describe("propagation config graduation (v2)", () => {
  it("a fresh install starts with surfacing on", () => {
    const store = new PropagationConfigStore(dirWith(null));
    assert.equal(store.load().propagationSurfacingEnabled, true);
  });

  it("a pre-v2 config's frozen default is dropped, once, and persisted", () => {
    const dir = dirWith({ propagationSurfacingEnabled: false, enabled: false, maxTargets: 7 });
    const store = new PropagationConfigStore(dir);
    const config = store.load();
    assert.equal(config.propagationSurfacingEnabled, true);
    assert.equal(config.configVersion, 2);
    // The engine loop stays off, and real overrides survive.
    assert.equal(config.enabled, false);
    assert.equal(config.maxTargets, 7);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(onDisk.configVersion, 2);
    assert.equal(onDisk.propagationSurfacingEnabled, true);
  });

  it("a post-graduation opt-out is honoured", () => {
    const store = new PropagationConfigStore(
      dirWith({ configVersion: 2, propagationSurfacingEnabled: false }),
    );
    assert.equal(store.load().propagationSurfacingEnabled, false);
  });
});
