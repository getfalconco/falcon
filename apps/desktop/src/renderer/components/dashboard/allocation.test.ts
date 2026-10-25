import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../shared/copy-rules";
import * as area from "../../lib/i18n/messages/areas/allocation";
import { buildAllocation, classAt, classifySymbol, parsePlan, roundedPercents } from "./allocation";

describe("allocation: what a holding is", () => {
  it("files companies as stocks and known funds as funds", () => {
    assert.equal(classifySymbol("NVDA"), "stocks");
    assert.equal(classifySymbol("aapl"), "stocks");
    assert.equal(classifySymbol("SPY"), "funds");
    assert.equal(classifySymbol(" ibit "), "funds");
  });

  it("files coin pairs as crypto, but leaves a bare coin name as a security", () => {
    for (const s of ["BTC-USD", "eth/usdt", "X:BTCUSD", "SOLUSD", "DOGE-USD"]) assert.equal(classifySymbol(s), "crypto", s);
    assert.equal(classifySymbol("BTC"), "stocks");
    assert.equal(classifySymbol("ABCUSD"), "stocks");
    assert.equal(classifySymbol("ABC-USD"), "stocks");
  });

  it("files option contracts as options", () => {
    assert.equal(classifySymbol("AAPL250117C00150000"), "options");
    assert.equal(classifySymbol("SPY   251219P00500000"), "options");
    assert.equal(classifySymbol("O:TSLA250620C00300000"), "options");
  });
});

describe("allocation: whole percents", () => {
  it("add up to exactly 100", () => {
    assert.deepEqual(roundedPercents([1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(roundedPercents([32206, 14613, 21076]), [47, 22, 31]);
    for (const set of [[0.1, 0.2, 99.7], [5, 5, 5, 5, 5, 5, 5], [1e6, 1, 1]]) {
      assert.equal(roundedPercents(set).reduce((s, v) => s + v, 0), 100, set.join());
    }
  });

  it("are zeros when there is nothing", () => {
    assert.deepEqual(roundedPercents([0, 0]), [0, 0]);
    assert.deepEqual(roundedPercents([]), []);
  });
});

describe("allocation: the book by class", () => {
  it("splits the reference book into 47, 22 and 31, and calls 69 invested", () => {
    const a = buildAllocation({
      cash: 21076,
      holdings: [
        { symbol: "NVDA", value: 20000 },
        { symbol: "AAPL", value: 12206 },
        { symbol: "BTC-USD", value: 14613 },
      ],
    })!;
    assert.deepEqual(
      a.slices.map((s) => [s.key, s.percent]),
      [["stocks", 47], ["crypto", 22], ["cash", 31]],
    );
    assert.equal(a.investedPercent, 69);
    assert.equal(a.total, 67895);
    assert.ok(Math.abs(a.investedShare - (1 - 21076 / 67895)) < 1e-12);
  });

  it("keeps classes in gauge order with cash last, and hides the empty ones", () => {
    const a = buildAllocation({
      cash: 1000,
      holdings: [
        { symbol: "QQQ", value: 3000 },
        { symbol: "ETH-USD", value: 2000 },
        { symbol: "MSFT", value: 4000 },
      ],
      linked: 0,
    })!;
    assert.deepEqual(a.slices.map((s) => s.key), ["stocks", "funds", "crypto", "cash"]);
    assert.equal(a.slices.reduce((s, x) => s + x.percent, 0), 100);
  });

  it("carries linked brokerage totals as their own class", () => {
    const a = buildAllocation({ cash: 500, holdings: [], linked: 1500 })!;
    assert.deepEqual(a.slices.map((s) => [s.key, s.percent]), [["linked", 75], ["cash", 25]]);
    assert.equal(a.investedPercent, 75);
  });

  it("folds two or more tiny classes into Other, and leaves a lone one alone", () => {
    const folded = buildAllocation({
      cash: 10000,
      holdings: [
        { symbol: "NVDA", value: 89000 },
        { symbol: "BTC-USD", value: 600 },
        { symbol: "AAPL250117C00150000", value: 400 },
      ],
    })!;
    assert.deepEqual(folded.slices.map((s) => s.key), ["stocks", "other", "cash"]);
    assert.equal(folded.slices.find((s) => s.key === "other")!.value, 1000);

    const lone = buildAllocation({ cash: 10000, holdings: [{ symbol: "NVDA", value: 89000 }, { symbol: "BTC-USD", value: 1000 }] })!;
    assert.deepEqual(lone.slices.map((s) => s.key), ["stocks", "crypto", "cash"]);
    assert.equal(lone.slices[1]!.percent, 1);
  });

  it("nets shorts inside their class and drops a class that nets below zero", () => {
    const a = buildAllocation({
      cash: 6000,
      holdings: [
        { symbol: "NVDA", value: 4000 },
        { symbol: "INTC", value: -1000 },
        { symbol: "SPY", value: -500 },
      ],
    })!;
    assert.deepEqual(a.slices.map((s) => [s.key, s.value]), [["stocks", 3000], ["cash", 6000]]);
    assert.equal(a.investedPercent, 33);
  });

  it("is all cash for a new paper account, and nothing for an empty one", () => {
    const fresh = buildAllocation({ cash: 10000, holdings: [] })!;
    assert.deepEqual(fresh.slices.map((s) => [s.key, s.percent]), [["cash", 100]]);
    assert.equal(fresh.investedPercent, 0);
    assert.equal(fresh.investedShare, 0);
    assert.equal(buildAllocation({ cash: 0, holdings: [] }), null);
    assert.equal(buildAllocation({ cash: -50, holdings: [{ symbol: "NVDA", value: 0.001 }] }), null);
  });

  it("is all invested when there is no cash", () => {
    const a = buildAllocation({ cash: 0, holdings: [{ symbol: "NVDA", value: 100 }] })!;
    assert.equal(a.investedPercent, 100);
    assert.equal(a.investedShare, 1);
  });
});

describe("allocation: the arc", () => {
  it("finds the class under each point of the arc", () => {
    const slices = [
      { key: "stocks" as const, share: 0.5 },
      { key: "crypto" as const, share: 0.25 },
      { key: "cash" as const, share: 0.25 },
    ];
    assert.equal(classAt(slices, 0), "stocks");
    assert.equal(classAt(slices, 0.49), "stocks");
    assert.equal(classAt(slices, 0.5), "crypto");
    assert.equal(classAt(slices, 0.8), "cash");
    assert.equal(classAt(slices, 1), "cash");
    assert.equal(classAt([], 0.3), null);
  });
});

describe("allocation: the reader's plan", () => {
  it("reads a whole invested percent, or nothing", () => {
    assert.equal(parsePlan("60"), 60);
    assert.equal(parsePlan(" 60/40 "), 60);
    assert.equal(parsePlan("72.6%"), 73);
    assert.equal(parsePlan(0), 0);
    assert.equal(parsePlan("100"), 100);
    for (const bad of ["", "abc", "101", "-5", null, undefined, "6O"]) assert.equal(parsePlan(bad), null, String(bad));
  });
});

describe("allocation: copy", () => {
  it("the English table follows the copy rules, and the plan is never a target", () => {
    const problems = Object.entries(area.en).flatMap(([key, text]) => textProblems(text).map((p) => `${key}: ${p}`));
    assert.deepEqual(problems, []);
    for (const [key, text] of Object.entries(area.en)) assert.ok(!/target/i.test(text), key);
  });

  it("every language names every class and keeps the pill short", () => {
    for (const lang of ["tr", "de", "fr", "es", "it", "ptBR", "ja", "zhCN", "ko"] as const) {
      const table = area[lang];
      for (const key of Object.keys(area.en)) assert.ok(table[key as keyof typeof area.en]?.trim(), `${lang} ${key}`);
      assert.ok(table["allocation.plan.pill"]!.replace("{invested}", "60").replace("{cash}", "40").length <= 14, `${lang} pill`);
    }
  });

  it("the card carries no sentence of its own", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "AllocationCard.tsx"), "utf8");
    assert.deepEqual(copyProblems(src, { jsxText: true }), []);
  });
});
