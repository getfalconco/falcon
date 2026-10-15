import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createLocalSnaptradeStore,
  legacyOwnerKey,
  snaptradeAccountKey,
  type SafeStorageLike,
} from "./local-secret-store";

const ACCOUNT = "7a1c2e9e-5b2f-4d9c-9f1e-1234567890ab";

/** A stand-in for Electron's safeStorage: reversible, but never the plaintext bytes. */
function fakeSafeStorage(available = true): SafeStorageLike & { calls: number } {
  const s = {
    calls: 0,
    isEncryptionAvailable: () => available,
    encryptString(plain: string) {
      s.calls += 1;
      return Buffer.from(`ENC(${Buffer.from(plain).toString("base64")})`);
    },
    decryptString(bytes: Buffer) {
      const m = /^ENC\((.*)\)$/.exec(bytes.toString());
      if (!m) throw new Error("not ours");
      return Buffer.from(m[1]!, "base64").toString();
    },
  };
  return s;
}

function setup(opts: { available?: boolean; legacy?: unknown } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-snaptrade-"));
  const root = path.join(dir, "data");
  const legacy = path.join(dir, "userData", "snaptrade-user.json");
  if (opts.legacy !== undefined) {
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, typeof opts.legacy === "string" ? opts.legacy : JSON.stringify(opts.legacy));
  }
  const safe = fakeSafeStorage(opts.available ?? true);
  const logs: string[] = [];
  const store = createLocalSnaptradeStore({ root: () => root, legacyFile: () => legacy, safeStorage: safe, log: (m) => logs.push(m) });
  return { root, legacy, store, safe, logs };
}

describe("account keys", () => {
  it("files signed-in accounts by id and everything else as local", () => {
    assert.equal(snaptradeAccountKey(ACCOUNT.toUpperCase()), ACCOUNT);
    assert.equal(snaptradeAccountKey(undefined), "local");
    assert.equal(snaptradeAccountKey("anon"), "local");
    assert.equal(snaptradeAccountKey("../etc"), "local");
    assert.equal(legacyOwnerKey(`falcon-${ACCOUNT}`), ACCOUNT);
    assert.equal(legacyOwnerKey("falcon-random"), "local");
  });
});

describe("local SnapTrade store", () => {
  it("writes an encrypted per-account file and reads it back", () => {
    const { root, store } = setup();
    store.write(ACCOUNT, { userId: `falcon-${ACCOUNT}`, userSecret: "top-secret" });
    const file = path.join(root, "snaptrade", `${ACCOUNT}.bin`);
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.readFileSync(file, "utf8").includes("top-secret"));
    assert.deepEqual(store.read(ACCOUNT), { userId: `falcon-${ACCOUNT}`, userSecret: "top-secret" });
    assert.equal(store.read("local"), null);
  });

  it("migrates the old plaintext file to its account, encrypted, then deletes it", () => {
    const { root, legacy, store } = setup({ legacy: { userId: `falcon-${ACCOUNT}`, userSecret: "legacy-secret" } });
    assert.deepEqual(store.read(ACCOUNT), { userId: `falcon-${ACCOUNT}`, userSecret: "legacy-secret" });
    assert.ok(!fs.existsSync(legacy));
    const file = path.join(root, "snaptrade", `${ACCOUNT}.bin`);
    assert.ok(!fs.readFileSync(file, "utf8").includes("legacy-secret"));
  });

  it("gives a legacy identity of a signed-out session to the local key, not to whoever reads first", () => {
    const { store } = setup({ legacy: { userId: "falcon-0d9a3a2c-random", userSecret: "anon-secret" } });
    assert.equal(store.read(ACCOUNT), null);
    assert.deepEqual(store.read("local"), { userId: "falcon-0d9a3a2c-random", userSecret: "anon-secret" });
  });

  it("does not overwrite an account file that already exists during migration", () => {
    const { store, legacy, root, safe } = setup();
    store.write(ACCOUNT, { userId: `falcon-${ACCOUNT}`, userSecret: "current" });
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ userId: `falcon-${ACCOUNT}`, userSecret: "stale" }));
    const fresh = createLocalSnaptradeStore({ root: () => root, legacyFile: () => legacy, safeStorage: safe, log: () => {} });
    assert.equal(fresh.read(ACCOUNT)?.userSecret, "current");
    assert.ok(!fs.existsSync(legacy));
  });

  it("keeps the identity in memory only, and removes the plaintext, when safeStorage is unavailable", () => {
    const { root, legacy, store, logs } = setup({ available: false, legacy: { userId: `falcon-${ACCOUNT}`, userSecret: "s1" } });
    assert.deepEqual(store.read(ACCOUNT), { userId: `falcon-${ACCOUNT}`, userSecret: "s1" });
    assert.ok(!fs.existsSync(legacy));
    store.write("local", { userId: "falcon-x", userSecret: "s2" });
    assert.deepEqual(store.read("local"), { userId: "falcon-x", userSecret: "s2" });
    assert.ok(!fs.existsSync(path.join(root, "snaptrade")));
    assert.equal(logs.filter((l) => l.includes("safeStorage")).length, 1);
  });

  it("drops an unreadable legacy file rather than keeping plaintext around", () => {
    const { legacy, store } = setup({ legacy: "{not json" });
    assert.equal(store.read(ACCOUNT), null);
    assert.ok(!fs.existsSync(legacy));
  });

  it("removes an account's identity from disk and memory", () => {
    const { root, store } = setup();
    store.write(ACCOUNT, { userId: `falcon-${ACCOUNT}`, userSecret: "x" });
    store.remove(ACCOUNT);
    assert.equal(store.read(ACCOUNT), null);
    assert.ok(!fs.existsSync(path.join(root, "snaptrade", `${ACCOUNT}.bin`)));
    store.remove(ACCOUNT); // already gone: fine
  });
});
