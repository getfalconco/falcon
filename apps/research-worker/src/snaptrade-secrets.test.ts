import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSealed, openSecret, parseSecretKey, sealSecret, SecretKeyError } from "./secret-box.js";
import { createSnaptradeSecretsStore } from "./snaptrade-secrets.js";

const KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const KEY = Buffer.from(KEY_HEX, "hex");
const USER = "7a1c2e9e-5b2f-4d9c-9f1e-1234567890ab";
/** Pinned in apps/desktop/src/main/snaptrade/secret-box.test.ts too: both sides must read each other's rows. */
const VECTOR = "enc:v1:BwcHBwcHBwcHBwcH:C6tOLN78HDQgZ4Rem5HsDQ:fATHLBt9tpCjsGbz5SPZ6MQ__xb82rArzQ";

describe("secret-box", () => {
  it("parses hex and base64 keys and rejects the wrong size", () => {
    assert.deepEqual(parseSecretKey(KEY_HEX), KEY);
    assert.deepEqual(parseSecretKey(KEY.toString("base64")), KEY);
    assert.deepEqual(parseSecretKey(KEY.toString("base64url")), KEY);
    assert.equal(parseSecretKey(""), null);
    assert.equal(parseSecretKey(undefined), null);
    assert.equal(parseSecretKey("too-short"), null);
    assert.equal(parseSecretKey(Buffer.alloc(16).toString("base64")), null);
  });

  it("round-trips, with a fresh nonce on every seal", () => {
    const a = sealSecret("s3cret", KEY, USER);
    const b = sealSecret("s3cret", KEY, USER);
    assert.ok(isSealed(a));
    assert.notEqual(a, b);
    assert.ok(!a.includes("s3cret"));
    assert.equal(openSecret(a, KEY, USER), "s3cret");
    assert.equal(openSecret(b, KEY, USER), "s3cret");
  });

  it("refuses another account, another key, or altered bytes", () => {
    const sealed = sealSecret("s3cret", KEY, USER);
    assert.throws(() => openSecret(sealed, KEY, "someone-else"));
    assert.throws(() => openSecret(sealed, Buffer.alloc(32, 9), USER));
    const parts = sealed.split(":");
    parts[4] = Buffer.from("tampered").toString("base64url");
    assert.throws(() => openSecret(parts.join(":"), KEY, USER));
    assert.throws(() => openSecret("plaintext", KEY, USER));
  });

  it("reads the pinned vector the desktop also pins", () => {
    assert.equal(sealSecret("snaptrade-user-secret-123", KEY, USER, Buffer.alloc(12, 7)), VECTOR);
    assert.equal(openSecret(VECTOR, KEY, USER), "snaptrade-user-secret-123");
  });
});

type Call = { url: string; method: string; body: unknown };

/** A fake PostgREST holding one snaptrade_secrets row. */
function fakeSupabase(row: { snaptrade_user_id: string; user_secret: string } | null) {
  const calls: Call[] = [];
  let current = row ? { ...row } : null;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === "GET") return new Response(JSON.stringify(current ? [current] : []), { status: 200 });
    if (method === "POST") {
      const b = body as { snaptrade_user_id: string; user_secret: string };
      current = { snaptrade_user_id: b.snaptrade_user_id, user_secret: b.user_secret };
      return new Response("", { status: 201 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { fetchFn, calls, row: () => current };
}

const CONFIG = () => ({ url: "https://db.example", serviceKey: "service-key" });

describe("snaptrade secrets store", () => {
  it("seals on save and opens on load", async () => {
    const db = fakeSupabase(null);
    const store = createSnaptradeSecretsStore({ config: CONFIG, key: () => KEY, fetch: db.fetchFn, warn: () => {} });
    await store.save(USER, { userId: `falcon-${USER}`, userSecret: "abc-123" });
    assert.ok(isSealed(db.row()!.user_secret));
    assert.ok(!db.row()!.user_secret.includes("abc-123"));
    assert.deepEqual(await store.load(USER), { userId: `falcon-${USER}`, userSecret: "abc-123" });
  });

  it("re-encrypts a plaintext row the first time it is read", async () => {
    const db = fakeSupabase({ snaptrade_user_id: `falcon-${USER}`, user_secret: "legacy-plain" });
    const store = createSnaptradeSecretsStore({ config: CONFIG, key: () => KEY, fetch: db.fetchFn, warn: () => {} });
    assert.deepEqual(await store.load(USER), { userId: `falcon-${USER}`, userSecret: "legacy-plain" });
    const writes = db.calls.filter((c) => c.method === "POST");
    assert.equal(writes.length, 1);
    assert.ok(isSealed(db.row()!.user_secret));
    assert.equal(openSecret(db.row()!.user_secret, KEY, USER), "legacy-plain");
    // A second read finds ciphertext and writes nothing more.
    await store.load(USER);
    assert.equal(db.calls.filter((c) => c.method === "POST").length, 1);
  });

  it("keeps working on plaintext without a key, and warns once", async () => {
    const warnings: string[] = [];
    const db = fakeSupabase({ snaptrade_user_id: "falcon-x", user_secret: "plain" });
    const store = createSnaptradeSecretsStore({ config: CONFIG, key: () => null, fetch: db.fetchFn, warn: (m) => warnings.push(m) });
    assert.deepEqual(await store.load(USER), { userId: "falcon-x", userSecret: "plain" });
    await store.save(USER, { userId: "falcon-x", userSecret: "plain-2" });
    assert.equal(db.row()!.user_secret, "plain-2");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /SNAPTRADE_SECRET_KEY/);
  });

  it("refuses a sealed row it has no key for instead of reporting no row", async () => {
    const db = fakeSupabase({ snaptrade_user_id: "falcon-x", user_secret: sealSecret("s", KEY, USER) });
    const store = createSnaptradeSecretsStore({ config: CONFIG, key: () => null, fetch: db.fetchFn, warn: () => {} });
    await assert.rejects(() => store.load(USER), SecretKeyError);
  });

  it("finds the SnapTrade user id and removes both rows", async () => {
    const db = fakeSupabase({ snaptrade_user_id: "falcon-x", user_secret: "s" });
    const store = createSnaptradeSecretsStore({ config: CONFIG, key: () => KEY, fetch: db.fetchFn, warn: () => {} });
    assert.equal(await store.snaptradeUserIdFor(USER), "falcon-x");
    await store.remove(USER);
    const deletes = db.calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname);
    assert.deepEqual(deletes, ["/rest/v1/snaptrade_secrets", "/rest/v1/broker_links"]);
  });
});
