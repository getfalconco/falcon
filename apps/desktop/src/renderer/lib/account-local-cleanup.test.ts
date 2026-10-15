import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCOUNT_OWNED_SESSION_KEYS, clearAccountStorage } from "./account-local-cleanup";

const ID = "7a1c2e9e-5b2f-4d9c-9f1e-1234567890ab";
const OTHER = "0b8f6a1d-0000-4000-8000-000000000000";

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("clearAccountStorage", () => {
  it("removes the deleted account's keys and the account-owned ones, and nothing else", () => {
    const s = memoryStorage({
      [`falcon.${ID}.paperBalance`]: "1000",
      [`falcon.${ID}.networthHistory`]: "[]",
      [`falcon.ui.heardPrompt.${ID}`]: "1",
      [`falcon.${OTHER}.paperBalance`]: "5",
      "meridian-waitlist-email": "kuzey@yahoo.com",
      "meridian-recent-stock-search": "[\"AAPL\"]",
      "falcon.ui.theme.choice": "dark",
      "falcon.ui.language": "tr-TR",
      "sb-abc-auth-token": "{}",
    });
    assert.equal(clearAccountStorage(s, ID.toUpperCase()), 5);
    assert.deepEqual([...s.map.keys()].sort(), [`falcon.${OTHER}.paperBalance`, "falcon.ui.language", "falcon.ui.theme.choice", "sb-abc-auth-token"]);
  });

  it("clears the session-storage keys it is given", () => {
    const s = memoryStorage({ "meridian-waitlist": "1", other: "x" });
    assert.equal(clearAccountStorage(s, ID, ACCOUNT_OWNED_SESSION_KEYS), 1);
    assert.deepEqual([...s.map.keys()], ["other"]);
  });

  it("does nothing without storage or an id", () => {
    assert.equal(clearAccountStorage(null, ID), 0);
    assert.equal(clearAccountStorage(memoryStorage({ a: "1" }), "  "), 0);
  });
});
