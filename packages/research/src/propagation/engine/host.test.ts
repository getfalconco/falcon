import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { enabledFromEnv } from "./host.js";

/**
 * The loop switch for a headless deployment. A service has no Shift+P panel and
 * its config file arrives baked into an image, so whether the always-on engine
 * produces runs must be sayable from the outside.
 */

const KEY = "FALCON_PROPAGATION_ENABLED";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("propagation loop env switch", () => {
  it("unset means the stored config decides — null, not false", () => {
    delete process.env[KEY];
    assert.equal(enabledFromEnv(), null);
  });

  it("accepts the spellings a deployment actually uses", () => {
    for (const on of ["true", "1", "on", "TRUE", " On "]) {
      process.env[KEY] = on;
      assert.equal(enabledFromEnv(), true, on);
    }
    for (const off of ["false", "0", "off", "OFF"]) {
      process.env[KEY] = off;
      assert.equal(enabledFromEnv(), false, off);
    }
  });

  it("a value that is not a boolean is ignored, never read as on", () => {
    process.env[KEY] = "yes please";
    assert.equal(enabledFromEnv(), null);
  });

  it("empty string is unset", () => {
    process.env[KEY] = "";
    assert.equal(enabledFromEnv(), null);
  });
});
