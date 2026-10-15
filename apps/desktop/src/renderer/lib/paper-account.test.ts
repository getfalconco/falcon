import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createPaperAccount,
  executePaperTrade,
  paperTradeErrorKey,
  paperTradeErrorText,
  readPaperAccount,
  type PaperTradeErrorCode,
} from "./paper-account";
import { translate } from "./i18n/translate";
import { MESSAGES, en, type MessageKey } from "./i18n/messages";
import { LANGUAGES } from "./i18n/languages";

// The account lives in localStorage and announces changes on the window; a
// small in-memory stand-in for both is all it needs under node (both are
// only touched when a function runs, never on import).
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
if (!g.window) g.window = new EventTarget();

const CODES: PaperTradeErrorCode[] = [
  "demoMode",
  "noAccount",
  "noPrice",
  "noAmount",
  "coverFirst",
  "sellFirst",
  "noLong",
  "noShort",
  "buyingPower",
  "cashToCover",
];

function failure(result: ReturnType<typeof executePaperTrade>) {
  assert.equal(result.ok, false, "expected the trade to be refused");
  if (result.ok) throw new Error("unreachable");
  return result;
}

describe("executePaperTrade refusals", () => {
  beforeEach(() => store.clear());

  it("refuses without an account, with a code and an English sentence", () => {
    const r = failure(executePaperTrade({ side: "buy", symbol: "nvda", amountUsd: 100, price: 10 }));
    assert.equal(r.code, "noAccount");
    assert.equal(r.error, "No Falcon paper account yet.");
  });

  it("names the missing price and amount", () => {
    createPaperAccount(1000);
    assert.equal(failure(executePaperTrade({ side: "buy", symbol: "NVDA", amountUsd: 100, price: 0 })).code, "noPrice");
    assert.equal(failure(executePaperTrade({ side: "buy", symbol: "NVDA", amountUsd: 0, price: 10 })).code, "noAmount");
  });

  it("carries the symbol and the amount as params, not baked into prose", () => {
    createPaperAccount(1000);
    const over = failure(executePaperTrade({ side: "buy", symbol: "NVDA", amountUsd: 5000, price: 10 }));
    assert.equal(over.code, "buyingPower");
    assert.deepEqual(over.params, { amount: "$1,000.00" });
    assert.equal(over.error, "Not enough buying power: $1,000.00 available.");

    const sell = failure(executePaperTrade({ side: "sell", symbol: " nvda ", amountUsd: 10, price: 10 }));
    assert.deepEqual([sell.code, sell.params], ["noLong", { symbol: "NVDA" }]);
    const cover = failure(executePaperTrade({ side: "cover", symbol: "NVDA", amountUsd: 10, price: 10 }));
    assert.deepEqual([cover.code, cover.params], ["noShort", { symbol: "NVDA" }]);
  });

  it("keeps one direction per symbol", () => {
    createPaperAccount(1000);
    assert.equal(executePaperTrade({ side: "buy", symbol: "AAPL", amountUsd: 100, price: 10 }).ok, true);
    assert.equal(failure(executePaperTrade({ side: "short", symbol: "AAPL", amountUsd: 50, price: 10 })).code, "sellFirst");
    assert.equal(executePaperTrade({ side: "short", symbol: "TSLA", amountUsd: 100, price: 10 }).ok, true);
    assert.equal(failure(executePaperTrade({ side: "buy", symbol: "TSLA", amountUsd: 50, price: 10 })).code, "coverFirst");
  });

  it("refuses a cover the cash cannot pay for", () => {
    createPaperAccount(100);
    assert.equal(executePaperTrade({ side: "short", symbol: "TSLA", amountUsd: 100, price: 10 }).ok, true);
    // Spend the short's proceeds and the rest of the cash on a long.
    assert.equal(executePaperTrade({ side: "buy", symbol: "AAPL", amountUsd: 100, price: 10 }).ok, true);
    const before = readPaperAccount().cash;
    const r = failure(executePaperTrade({ side: "cover", symbol: "TSLA", amountUsd: 1000, price: 30 }));
    assert.equal(r.code, "cashToCover");
    assert.equal(r.params.amount, `$${before.toFixed(2)}`);
  });

  it("still trades: a buy then a full sell leaves the account flat", () => {
    createPaperAccount(1000);
    const buy = executePaperTrade({ side: "buy", symbol: "MSFT", amountUsd: 400, price: 20 });
    assert.equal(buy.ok, true);
    const sell = executePaperTrade({ side: "sell", symbol: "MSFT", amountUsd: 10_000, price: 20 });
    assert.equal(sell.ok, true);
    assert.deepEqual(readPaperAccount(), { cash: 1000, positions: {} });
  });
});

describe("paper trade error sentences", () => {
  it("read in the reader's language through the key", () => {
    const params = { symbol: "NVDA" };
    const tr = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => translate("tr-TR", key, vars);
    const text = paperTradeErrorText({ code: "noLong", params }, tr);
    assert.equal(text, translate("tr-TR", "stock.paper.error.noLong", params));
    assert.match(text, /NVDA/);
    assert.notEqual(text, paperTradeErrorText({ code: "noLong", params }));
  });

  it("exist for every code in every language, with no dash", () => {
    for (const code of CODES) {
      const key = paperTradeErrorKey(code);
      assert.ok(en[key], `${key} missing in English`);
      for (const { code: lang } of LANGUAGES) {
        const text = MESSAGES[lang][key];
        assert.ok(text?.trim(), `${key} missing in ${lang}`);
        assert.ok(!/[–—]/.test(text!), `${lang} ${key} has a dash`);
      }
    }
  });

  it("the English fallback never carries a dash", () => {
    store.clear();
    createPaperAccount(10);
    const results = [
      executePaperTrade({ side: "buy", symbol: "NVDA", amountUsd: 100, price: 0 }),
      executePaperTrade({ side: "buy", symbol: "NVDA", amountUsd: 100, price: 10 }),
    ];
    for (const r of results) assert.ok(!r.ok && !/[–—]/.test(r.error));
  });
});
