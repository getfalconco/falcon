import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, isSessionKey, snapshotBrowserStorage, summarizeBrowserStorage } from "./browser-storage";

function storage(data: Record<string, string>) {
  const keys = Object.keys(data);
  return {
    length: keys.length,
    key: (i: number) => keys[i] ?? null,
    getItem: (k: string) => (k in data ? data[k]! : null),
  };
}

const DATA = {
  "falcon.ui.theme.choice": "dark",
  "meridian-watchlist": '[{"ticker":"NVDA"}]',
  "sb-abcdefgh-auth-token": '{"access_token":"secret","refresh_token":"secret"}',
  "sb-abcdefgh-auth-token-code-verifier": "verifier",
};

describe("browser storage", () => {
  it("recognises the sign-in session keys", () => {
    assert.equal(isSessionKey("sb-abcdefgh-auth-token"), true);
    assert.equal(isSessionKey("sb-abcdefgh-auth-token-code-verifier"), true);
    assert.equal(isSessionKey("falcon.ui.theme.choice"), false);
  });

  it("counts app keys apart from the session and never copies the session out", () => {
    const s = storage(DATA);
    const summary = summarizeBrowserStorage(s);
    assert.equal(summary.keys, 2);
    assert.equal(summary.sessionKeys, 2);
    assert.equal(summary.bytes, "falcon.ui.theme.choice".length + 4 + "meridian-watchlist".length + DATA["meridian-watchlist"].length);
    const snap = snapshotBrowserStorage(s);
    assert.deepEqual(Object.keys(snap).sort(), ["falcon.ui.theme.choice", "meridian-watchlist"]);
    assert.equal(JSON.stringify(snap).includes("secret"), false);
  });

  it("formats sizes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(11 * 1024 * 1024), "11 MB");
  });
});
