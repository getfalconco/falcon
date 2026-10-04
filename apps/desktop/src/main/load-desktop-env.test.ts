import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadEnvFile, pinEnvKeys } from "./load-desktop-env";

/**
 * A reload of the .env files must not take back a key the process has taken
 * charge of. The provider proxy sets the model gateway's address to the worker
 * and the key to the reader's session; a service that re-read .env afterwards
 * used to put the gateway's own address back, and every model call failed.
 */

function envFile(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

describe("loadEnvFile", () => {
  it("overrides what the file names, when asked to", () => {
    process.env.FALCON_TEST_PLAIN = "before";
    loadEnvFile(envFile("FALCON_TEST_PLAIN=after\n"), true);
    assert.equal(process.env.FALCON_TEST_PLAIN, "after");
    delete process.env.FALCON_TEST_PLAIN;
  });

  it("leaves a pinned key alone, override or not", () => {
    process.env.FALCON_TEST_PINNED_URL = "https://worker.example/api/anthropic";
    process.env.FALCON_TEST_PINNED_KEY = "session-token";
    pinEnvKeys(["FALCON_TEST_PINNED_URL", "FALCON_TEST_PINNED_KEY"]);
    const file = envFile("FALCON_TEST_PINNED_URL=https://gateway.example\nFALCON_TEST_PINNED_KEY=sk-from-file\n");
    loadEnvFile(file, true);
    loadEnvFile(file, false);
    assert.equal(process.env.FALCON_TEST_PINNED_URL, "https://worker.example/api/anthropic");
    assert.equal(process.env.FALCON_TEST_PINNED_KEY, "session-token");
  });

  it("does not refill a pinned key the process removed (signed out)", () => {
    pinEnvKeys(["FALCON_TEST_SIGNED_OUT_KEY"]);
    delete process.env.FALCON_TEST_SIGNED_OUT_KEY;
    loadEnvFile(envFile("FALCON_TEST_SIGNED_OUT_KEY=sk-from-file\n"), false);
    assert.equal(process.env.FALCON_TEST_SIGNED_OUT_KEY, undefined);
  });
});
