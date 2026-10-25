import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatChangeAmount, formatChangePercent, netWorthChange } from "./net-worth-format";

describe("net worth figures", () => {
  it("drops the cents from a hundred dollars up, and keeps them below", () => {
    assert.equal(formatChangeAmount(34586.42, "en-US"), "+$34,586");
    assert.equal(formatChangeAmount(81.5, "en-US"), "+$81.50");
  });

  it("writes money the way the language does", () => {
    assert.equal(formatChangeAmount(34581, "tr-TR"), "+$34.581");
    assert.equal(formatChangeAmount(-34581, "de-DE"), "-34.581 $");
  });

  it("masks the digits as one run, the currency and sign left in place", () => {
    assert.equal(formatChangeAmount(34586, "en-US", true), "+$*****");
    assert.equal(formatChangeAmount(34586, "de-DE", true), "+***** $");
  });

  it("signs the change both ways and leaves zero unsigned", () => {
    assert.equal(formatChangeAmount(34586, "en-US"), "+$34,586");
    assert.equal(formatChangeAmount(-12.5, "en-US"), "-$12.50");
    assert.equal(formatChangeAmount(0, "en-US"), "$0.00");
    assert.equal(formatChangePercent(1.038, "en-US"), "+103.8%");
    assert.equal(formatChangePercent(1.038, "tr-TR"), "+%103,8");
    assert.equal(formatChangePercent(-0.052, "en-US", false), "5.2%");
  });

  it("has no change without a start, and no share of a start of zero", () => {
    assert.equal(netWorthChange(100, null), null);
    assert.deepEqual(netWorthChange(150, 100), { amount: 50, ratio: 0.5 });
    assert.deepEqual(netWorthChange(150, 0), { amount: 150, ratio: null });
  });
});
