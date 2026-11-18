// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/paper-account.test.ts
// The paper account: balance parsing and validation, the account row, and the holdings task's "paper" source.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAPER_DEFAULT_NAME, balanceError, formatBalanceInput, paperAccount, paperCreatedText, paperName, parseBalance, withPaper } from "./paper-account";
import { clearHoldingsAdded, clearPaperHoldings, markHoldingsAdded, readHoldingsAdded, readHoldingsSources } from "./workspace/own-card";

test("balances are typed with thousand separators and read back as numbers", () => {
  assert.equal(formatBalanceInput("100000"), "100,000");
  assert.equal(formatBalanceInput("$1234567.891"), "1,234,567.89");
  assert.equal(formatBalanceInput("00012a3"), "123");
  assert.equal(formatBalanceInput(""), "");
  assert.equal(parseBalance("$100,000"), 100000);
  assert.equal(parseBalance("2500.5"), 2500.5);
  assert.equal(parseBalance("1e6"), null);
  assert.equal(parseBalance("-5"), null);
  assert.equal(parseBalance("12.345"), null);
});

test("the balance is between $1,000 and $10,000,000, with an inline error otherwise", () => {
  assert.equal(balanceError(""), "Enter a starting balance.");
  assert.equal(balanceError("abc"), "Enter an amount in dollars, like 100,000.");
  assert.equal(balanceError("999.99"), "The starting balance is at least $1,000.");
  assert.equal(balanceError("10,000,000.01"), "The starting balance is at most $10,000,000.");
  assert.equal(balanceError("1,000"), null);
  assert.equal(balanceError("10,000,000"), null);
});

test("the paper account holds the balance as cash, in USD, with no positions; out of range is refused", () => {
  const now = Date.UTC(2026, 10, 17);
  assert.deepEqual(paperAccount(100000, "  My   paper  ", now), {
    id: "paper",
    source: "paper",
    name: "My paper",
    institution: null,
    numberLast4: null,
    currency: "USD",
    totalValue: 100000,
    cash: 100000,
    buyingPower: 100000,
    holdingsUnavailable: false,
    asOf: new Date(now).toISOString(),
  });
  assert.equal(paperAccount(999, null), null);
  assert.equal(paperAccount(Number.NaN, null), null);
  assert.equal(paperName(""), PAPER_DEFAULT_NAME);
  assert.equal(paperName("x".repeat(60)).length, 40);
  assert.equal(paperCreatedText(100000), "Paper account created · $100,000");
});

test("create and clear: the paper account replaces an earlier one and goes alone, other accounts stay", () => {
  const broker = { id: "b_0123456789abcdef01234567" };
  const first = { id: "paper", cash: 1 };
  const second = { id: "paper", cash: 2 };
  assert.deepEqual(withPaper([broker, first], second), [broker, second]);
  assert.deepEqual(withPaper([broker, second], null), [broker]);
});

test("the holdings task: paper counts; Clear paper portfolio undoes it only when nothing else added holdings", () => {
  markHoldingsAdded("p1", "paper");
  assert.equal(readHoldingsAdded("p1"), true);
  clearPaperHoldings("p1");
  assert.equal(readHoldingsAdded("p1"), false);

  markHoldingsAdded("p2:w-1", "paper");
  markHoldingsAdded("p2", "broker");
  clearPaperHoldings("p2");
  assert.deepEqual(readHoldingsSources("p2"), ["broker"], "an import keeps the task done");

  markHoldingsAdded("p3", "demo");
  clearPaperHoldings("p3");
  assert.equal(readHoldingsAdded("p3"), false, "the old tickers-only demo mark goes with it");
  markHoldingsAdded("p3", "paper");
  clearHoldingsAdded("p3");
  assert.equal(readHoldingsAdded("p3"), false);
});
