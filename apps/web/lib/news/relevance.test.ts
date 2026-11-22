import assert from "node:assert/strict";
import test from "node:test";
import { firstSentence, isClickbait, nameAliases, relevantSymbols } from "./relevance";

const names = new Map([
  ["AMZN", "AMAZON COM INC"],
  ["WMT", "Walmart Inc."],
  ["T", "AT&T INC."],
  ["BAC", "BANK OF AMERICA CORP /DE/"],
  ["IBM", "INTERNATIONAL BUSINESS MACHINES CORP"],
  ["AI", "C3.ai, Inc."],
]);

test("company aliases", () => {
  assert.deepEqual(nameAliases("AMAZON COM INC"), ["amazon"]);
  assert.deepEqual(nameAliases("AT&T INC."), ["at&t"]);
  assert.deepEqual(nameAliases("BANK OF AMERICA CORP /DE/"), ["bank of america"]);
  assert.equal(firstSentence("Amazon said sales rose. SpaceX also launched."), "Amazon said sales rose.");
});

test("an article keeps only the tickers it is about", () => {
  assert.deepEqual(relevantSymbols(["AMZN"], "SpaceX launches 30 more Starlink satellites", "SpaceX said on Friday it launched a batch. Amazon's Kuiper is a rival.", names), []);
  assert.deepEqual(relevantSymbols(["AMZN"], "Sam's Club opens 15 new stores", "The warehouse club, owned by Walmart, plans more.", names), []);
  assert.deepEqual(relevantSymbols(["AMZN", "WMT"], "Walmart CFO expects better years ahead", "Walmart beat and raised again.", names), ["WMT"]);
  assert.deepEqual(relevantSymbols(["AMZN"], "Amazon's AWS signs a new deal", "", names), ["AMZN"]);
  assert.deepEqual(relevantSymbols(["AMZN"], "Retail stocks rise", "Shares of Amazon.com Inc. (NASDAQ:AMZN) rose 2% after the report.", names), ["AMZN"]);
  assert.deepEqual(relevantSymbols(["T"], "AT&T raises its dividend", "", names), ["T"]);
  assert.deepEqual(relevantSymbols(["BAC"], "Bank of America sees a year-end rally", "", names), ["BAC"]);
  assert.deepEqual(relevantSymbols(["IBM"], "IBM shares jump on quantum news", "", names), ["IBM"]);
  // An ordinary-word ticker needs a $ or exchange prefix.
  assert.deepEqual(relevantSymbols(["AI"], "AI stocks sell off as Nvidia slides", "", names), []);
  assert.deepEqual(relevantSymbols(["AI"], "C3.ai beats estimates", "", names), ["AI"]);
  // No known name: kept.
  assert.deepEqual(relevantSymbols(["ZZZZ"], "Something else", "", names), ["ZZZZ"]);
});

test("clickbait and listicle headlines", () => {
  for (const h of [
    "5 Stocks to Buy in 2027",
    "3 Great Robotics Stocks To Own In November 2026",
    "Top 3 Growth Stocks To Watch In November 2026",
    "Should You Buy Nvidia Stock Before Earnings?",
    "Is Bank of America Stock a Buy at 25% Below Its 52-Week High?",
    "The Best AI Stocks to Buy Right Now",
    "This Could Be a Millionaire-Maker Stock",
    "Prediction: This Stock Will Double by 2030",
    "1 No-Brainer Dividend Stock to Buy With $500",
    "Here's Why You Should Retain Doximity Stock in Your Portfolio for Now",
  ]) {
    assert.equal(isClickbait(h), true, h);
  }
  for (const h of [
    "Abeona Therapeutics Acquires Phase 3-Ready APT-1011",
    "Walmart Raises Full-Year Outlook After Strong Quarter",
    "Bank of America Names New CFO",
    "Nvidia Falls 4% as Chip Stocks Slide",
    "Magnificent Seven stocks shed $4 trillion",
    "Why Is Cloudflare Stock Falling on Friday?",
  ]) {
    assert.equal(isClickbait(h), false, h);
  }
});

test("a unit or brand stands for its parent, and a company name is not a listicle", () => {
  const names = new Map([["GOOGL", "Alphabet Inc."], ["AMZN", "AMAZON COM INC"], ["WMT", "Walmart Inc."], ["FUN", "Six Flags Entertainment Corp"]]);
  assert.deepEqual(relevantSymbols(["GOOGL", "AMZN"], "Waymo recalls 1,200 robotaxis after crashes", "", names), ["GOOGL"]);
  assert.deepEqual(relevantSymbols(["AMZN", "WMT"], "Sam's Club expands same-day delivery", "", names), ["WMT"]);
  assert.deepEqual(relevantSymbols(["AMZN"], "SpaceX launches 30 satellites", "", names), []);
  assert.equal(isClickbait("Six Flags and 4 More Stocks See Action From Activist Investors"), false);
  assert.equal(isClickbait("Three Great Robotics Stocks To Own"), true);
});
