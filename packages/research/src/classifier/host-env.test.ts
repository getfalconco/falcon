import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { classifierEnabledFromEnv } from "./host.js";

const KEY = "FALCON_CLASSIFIER_ENABLED";
const before = process.env[KEY];

describe("FALCON_CLASSIFIER_ENABLED", () => {
  afterEach(() => {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  });

  it("is a boolean when set, null when unset or not a boolean", () => {
    delete process.env[KEY];
    assert.equal(classifierEnabledFromEnv(), null);
    for (const v of ["true", "1", "ON"]) {
      process.env[KEY] = v;
      assert.equal(classifierEnabledFromEnv(), true, v);
    }
    for (const v of ["false", "0", "off"]) {
      process.env[KEY] = v;
      assert.equal(classifierEnabledFromEnv(), false, v);
    }
    process.env[KEY] = "maybe";
    assert.equal(classifierEnabledFromEnv(), null);
  });
});
