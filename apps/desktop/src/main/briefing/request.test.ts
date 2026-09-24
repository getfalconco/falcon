import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_HOLDINGS, parseBriefingRequest, parseNarrativeRequest } from "./request";
import { ANONYMOUS_USER_KEY, userKeyFromAccessToken } from "./user-key";

const holding = (symbol: unknown, shares: unknown = 10, cost: unknown = 1000) => ({ symbol, shares, cost_usd: cost });

describe("parseBriefingRequest", () => {
  it("accepts a plain book and upper-cases its symbols", () => {
    assert.deepEqual(parseBriefingRequest({ holdings: [holding(" aapl "), holding("BRK-B", -2, -900)], cash: 2500.5 }), {
      holdings: [
        { symbol: "AAPL", shares: 10, cost_usd: 1000 },
        { symbol: "BRK-B", shares: -2, cost_usd: -900 },
      ],
      cash: 2500.5,
      demo: false,
      force: false,
    });
  });

  it("accepts every symbol shape the provider uses", () => {
    for (const symbol of ["^GSPC", "ES=F", "000001.SS", "DX-Y.NYB", "BTC-USD", "EURUSD=X"]) {
      assert.notEqual(parseBriefingRequest({ holdings: [holding(symbol)], cash: 0 }), null, symbol);
    }
  });

  it("accepts an empty book: cash alone still has a morning", () => {
    assert.deepEqual(parseBriefingRequest({ holdings: [], cash: 100 })?.holdings, []);
  });

  it("reads the flags strictly", () => {
    const parsed = parseBriefingRequest({ holdings: [], cash: 0, demo: "yes", force: 1 });
    assert.equal(parsed?.demo, false);
    assert.equal(parsed?.force, false);
    const flagged = parseBriefingRequest({ holdings: [], cash: 0, demo: true, force: true });
    assert.equal(flagged?.demo, true);
    assert.equal(flagged?.force, true);
  });

  it("refuses anything that is not a request", () => {
    for (const raw of [null, undefined, "AAPL", 7, [], { cash: 0 }, { holdings: "AAPL", cash: 0 }, { holdings: [] }]) {
      assert.equal(parseBriefingRequest(raw), null);
    }
  });

  it("refuses a symbol that could not be a ticker", () => {
    for (const symbol of ["", "AAPL/../x", "AAPL?x=1", "A B", "WAYTOOLONGSYMBOL", "AA\nPL", 42, null]) {
      assert.equal(parseBriefingRequest({ holdings: [holding(symbol)], cash: 0 }), null, String(symbol));
    }
  });

  it("refuses numbers that are not finite", () => {
    assert.equal(parseBriefingRequest({ holdings: [holding("AAPL", Number.NaN)], cash: 0 }), null);
    assert.equal(parseBriefingRequest({ holdings: [holding("AAPL", 1, Number.POSITIVE_INFINITY)], cash: 0 }), null);
    assert.equal(parseBriefingRequest({ holdings: [holding("AAPL", "10")], cash: 0 }), null);
    assert.equal(parseBriefingRequest({ holdings: [holding("AAPL")], cash: Number.NaN }), null);
    assert.equal(parseBriefingRequest({ holdings: [holding("AAPL")], cash: "0" }), null);
  });

  it("refuses a book past the size limit and takes one at it", () => {
    const rows = Array.from({ length: MAX_HOLDINGS }, (_, i) => holding(`T${i}`));
    assert.equal(parseBriefingRequest({ holdings: rows, cash: 0 })?.holdings.length, MAX_HOLDINGS);
    assert.equal(parseBriefingRequest({ holdings: [...rows, holding("ONEMORE")], cash: 0 }), null);
  });

  it("drops fields it does not know instead of passing them on", () => {
    const parsed = parseBriefingRequest({ holdings: [{ ...holding("AAPL"), note: "x" }], cash: 0, extra: true });
    assert.deepEqual(Object.keys(parsed ?? {}).sort(), ["cash", "demo", "force", "holdings"]);
    assert.deepEqual(Object.keys(parsed?.holdings[0] ?? {}).sort(), ["cost_usd", "shares", "symbol"]);
  });
});

describe("parseNarrativeRequest", () => {
  it("accepts a session date and a facts hash", () => {
    assert.deepEqual(parseNarrativeRequest({ target_session_ymd: "2026-09-21", facts_hash: "1x9k2ab", other: 1 }), {
      target_session_ymd: "2026-09-21",
      facts_hash: "1x9k2ab",
    });
  });

  it("refuses values that would reach a file name in another shape", () => {
    assert.equal(parseNarrativeRequest({ target_session_ymd: "2026-09-21/..", facts_hash: "abc" }), null);
    assert.equal(parseNarrativeRequest({ target_session_ymd: "2026-09-21", facts_hash: "../abc" }), null);
    assert.equal(parseNarrativeRequest({ target_session_ymd: "2026-09-21", facts_hash: "" }), null);
    assert.equal(parseNarrativeRequest({ target_session_ymd: 20260921, facts_hash: "abc" }), null);
    assert.equal(parseNarrativeRequest(null), null);
  });
});

describe("userKeyFromAccessToken", () => {
  const token = (claims: unknown): string =>
    `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  it("uses the account id in the token, lower-cased", () => {
    assert.equal(
      userKeyFromAccessToken(token({ sub: "3F2504E0-4F89-41D3-9A0C-0305E82C3301", email: "a@b.c" })),
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    );
  });

  it("stays the same when the token is refreshed for the same account", () => {
    const a = userKeyFromAccessToken(token({ sub: "user-1", exp: 1 }));
    const b = userKeyFromAccessToken(token({ sub: "user-1", exp: 2 }));
    assert.equal(a, b);
  });

  it("falls back to the anonymous key for anything it cannot read", () => {
    for (const raw of [null, undefined, "", "not-a-token", "a.b.c", token({}), token({ sub: 12 }), token({ sub: "../../etc" }), token("text")]) {
      assert.equal(userKeyFromAccessToken(raw), ANONYMOUS_USER_KEY);
    }
  });
});
