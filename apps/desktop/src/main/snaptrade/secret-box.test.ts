import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSealed, openSecret, parseSecretKey, sealSecret } from "./secret-box";

const KEY = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
const USER = "7a1c2e9e-5b2f-4d9c-9f1e-1234567890ab";
/** Pinned in apps/research-worker/src/snaptrade-secrets.test.ts too: both sides must read each other's rows. */
const VECTOR = "enc:v1:BwcHBwcHBwcHBwcH:C6tOLN78HDQgZ4Rem5HsDQ:fATHLBt9tpCjsGbz5SPZ6MQ__xb82rArzQ";

describe("desktop secret-box (copy of the worker's)", () => {
  it("opens the worker's pinned vector and seals it identically", () => {
    assert.equal(openSecret(VECTOR, KEY, USER), "snaptrade-user-secret-123");
    assert.equal(sealSecret("snaptrade-user-secret-123", KEY, USER, Buffer.alloc(12, 7)), VECTOR);
  });

  it("round-trips and refuses another account", () => {
    const sealed = sealSecret("abc", KEY, USER);
    assert.ok(isSealed(sealed));
    assert.equal(openSecret(sealed, KEY, USER), "abc");
    assert.throws(() => openSecret(sealed, KEY, "other"));
    assert.deepEqual(parseSecretKey(KEY.toString("base64")), KEY);
    assert.equal(parseSecretKey("nope"), null);
  });
});
