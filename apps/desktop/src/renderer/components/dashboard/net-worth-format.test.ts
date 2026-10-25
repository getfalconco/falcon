import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBalance, formatChangeAmount, formatChangePercent, netWorthChange } from "./net-worth-format";
import { matrixColumns } from "./DotMatrixNumber";

describe("net worth figures", () => {
  it("drops the cents from a thousand dollars up, and keeps them below", () => {
    assert.equal(formatBalance(67895.42, "en-US"), "$67,895");
    assert.equal(formatBalance(812.5, "en-US"), "$812.50");
  });

  it("writes money the way the language does", () => {
    assert.equal(formatBalance(67895, "tr-TR"), "$67.895");
    assert.equal(formatBalance(67895, "de-DE"), "67.895 $");
  });

  it("masks the digits as one run, the currency and sign left in place", () => {
    assert.equal(formatBalance(67895, "en-US", true), "$*****");
    assert.equal(formatBalance(67895, "de-DE", true), "***** $");
    assert.equal(formatChangeAmount(34586, "en-US", true), "+$*****");
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

describe("dot matrix width", () => {
  it("gives every digit the same width, so the figure is tabular", () => {
    assert.equal(matrixColumns("0"), 5);
    assert.equal(matrixColumns("11"), matrixColumns("88"));
    // Five digits, a comma and a dollar sign: 6 x 5 + 2, and six one-column gaps.
    assert.equal(matrixColumns("$67,895"), 38);
  });
});
