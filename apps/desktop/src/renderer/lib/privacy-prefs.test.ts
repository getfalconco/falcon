import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NEWS_READ_KEY,
  REMEMBER_SEARCHES_KEY,
  readNewsRead,
  readRememberSearches,
  writeNewsRead,
  writeRememberSearches,
} from "./privacy-prefs";

function memory(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("privacy preferences", () => {
  it("are on until turned off", () => {
    const s = memory();
    assert.equal(readRememberSearches(s), true);
    assert.equal(readNewsRead(s), true);
    assert.equal(readNewsRead(null), true);
  });

  it("keep each switch under its own key", () => {
    const s = memory();
    writeRememberSearches(false, s);
    assert.equal(s.data.get(REMEMBER_SEARCHES_KEY), "0");
    assert.equal(readRememberSearches(s), false);
    assert.equal(readNewsRead(s), true);
    writeNewsRead(false, s);
    writeRememberSearches(true, s);
    assert.equal(s.data.get(NEWS_READ_KEY), "0");
    assert.equal(readNewsRead(s), false);
    assert.equal(readRememberSearches(s), true);
  });

  it("fall back to on when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(readNewsRead(broken), true);
    assert.doesNotThrow(() => writeNewsRead(false, broken));
  });
});
