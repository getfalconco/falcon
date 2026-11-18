// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/own-card.test.ts
// Pure checks of the "Start with what you own" setup card and the demo portfolio; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEMO_PORTFOLIO,
  SETUP_TASKS,
  askedFalcon,
  clearDemoHoldings,
  clearHoldingsAdded,
  demoOnList,
  markHoldingsAdded,
  parseHoldingsSources,
  readHoldingsAdded,
  readHoldingsSources,
  mergeHoldings,
  ownCardVisible,
  readDemoTickers,
  readOwnCardDismissed,
  readSightingOpened,
  markSightingOpened,
  scopeUser,
  setupProgress,
  withDemo,
  withoutDemo,
  writeDemoTickers,
  writeOwnCardDismissed,
} from "./own-card";

const item = (ticker: string) => ({ ticker, name: "" });

const none = { holdings: false, sighting: false, ask: false };

test("progress counts only tasks that are done and names the first open one", () => {
  assert.deepEqual(setupProgress(none), { done: 0, total: 3, next: "holdings" });
  assert.deepEqual(setupProgress({ ...none, holdings: true }), { done: 1, total: 3, next: "sighting" });
  assert.deepEqual(setupProgress({ holdings: false, sighting: true, ask: true }), { done: 0, total: 3, next: "holdings" }, "steps count in order");
  assert.deepEqual(setupProgress({ holdings: true, sighting: true, ask: false }), { done: 2, total: 3, next: "ask" });
  assert.deepEqual(setupProgress({ holdings: true, sighting: true, ask: true }), { done: 3, total: 3, next: null });
  assert.deepEqual(SETUP_TASKS.map((t) => t.id), ["holdings", "sighting", "ask"]);
});

test("the card shows once the list has loaded, until every task is done or it is dismissed", () => {
  assert.equal(ownCardVisible({ portfolioLoaded: true, dismissed: false, state: none }), true);
  assert.equal(ownCardVisible({ portfolioLoaded: false, dismissed: false, state: none }), false, "no flash while loading");
  assert.equal(ownCardVisible({ portfolioLoaded: true, dismissed: false, state: { ...none, holdings: true } }), true, "holdings alone do not hide it");
  assert.equal(ownCardVisible({ portfolioLoaded: true, dismissed: false, state: { holdings: true, sighting: true, ask: true } }), false, "hidden once every task is done");
  assert.equal(ownCardVisible({ portfolioLoaded: true, dismissed: true, state: none }), false);
});

test("a Falcon AI question is a stored session with a message from the member", () => {
  const session = (roles: string[]) => ({ id: "s1", title: "t", createdAt: 1, updatedAt: 1, messages: roles.map((role, i) => ({ id: `m${i}`, role, text: "x", at: 1 })) });
  assert.equal(askedFalcon(null), false);
  assert.equal(askedFalcon("not json"), false);
  assert.equal(askedFalcon(JSON.stringify([])), false);
  assert.equal(askedFalcon(JSON.stringify([session([])])), false, "an empty New session is not a question");
  assert.equal(askedFalcon(JSON.stringify([session(["assistant"])])), false);
  assert.equal(askedFalcon(JSON.stringify([session([]), session(["user", "assistant"])])), true);
});

test("the demo is tickers only, unique, and the agreed liquid names", () => {
  const tickers = DEMO_PORTFOLIO.map((d) => d.ticker);
  assert.deepEqual(tickers, ["AAPL", "MSFT", "NVDA", "AMD", "TSM", "AMZN", "GOOGL"]);
  assert.equal(new Set(tickers).size, tickers.length);
  for (const d of DEMO_PORTFOLIO) assert.deepEqual(Object.keys(d).sort(), ["name", "ticker"]);
});

test("adding the demo keeps what is there and records only what it added", () => {
  const empty = withDemo([]);
  assert.equal(empty.items.length, DEMO_PORTFOLIO.length);
  assert.deepEqual(empty.added, DEMO_PORTFOLIO.map((d) => d.ticker));

  const some = withDemo([item("XOM"), item("NVDA")]);
  assert.deepEqual(
    some.items.map((f) => f.ticker),
    ["XOM", "NVDA", "AAPL", "MSFT", "AMD", "TSM", "AMZN", "GOOGL"],
  );
  assert.ok(!some.added.includes("NVDA"), "a ticker the member had is not the demo's to clear");
});

test("the demo mark follows the list; clearing keeps the member's own tickers", () => {
  const { items, added } = withDemo([]);
  assert.deepEqual(demoOnList(items, added), added);
  assert.deepEqual(demoOnList(items, null), []);
  assert.deepEqual(demoOnList([item("XOM")], added), [], "every demo ticker removed: no demo");

  const edited = [...items.filter((f) => f.ticker !== "AMD"), item("XOM")];
  assert.deepEqual(demoOnList(edited, added), ["AAPL", "MSFT", "NVDA", "TSM", "AMZN", "GOOGL"]);
  assert.deepEqual(withoutDemo(edited, added), [item("XOM")]);
  assert.deepEqual(withoutDemo(edited, null), edited);
});

test("imported holdings are merged as tickers, deduplicated", () => {
  const merged = mergeHoldings([item("AAPL")], [
    { ticker: "AAPL", name: "Apple" },
    { ticker: "MSFT", name: "Microsoft" },
    { ticker: "MSFT", name: "Microsoft" },
    { ticker: "BRK.B", name: null },
  ]);
  assert.deepEqual(merged, [item("AAPL"), { ticker: "MSFT", name: "Microsoft" }, { ticker: "BRK.B", name: "" }]);
});

test("dismissal and the Sighting mark are per person; the demo mark is per workspace scope", () => {
  assert.equal(scopeUser("u1:w-abc"), "u1");
  assert.equal(readOwnCardDismissed("u1"), false);
  writeOwnCardDismissed("u1:w-abc", true);
  assert.equal(readOwnCardDismissed("u1"), true, "dismissing in one workspace dismisses for the person");
  assert.equal(readOwnCardDismissed("u2"), false);
  writeOwnCardDismissed("u1", false);
  assert.equal(readOwnCardDismissed("u1"), false);

  assert.equal(readSightingOpened("u1"), false);
  markSightingOpened("u1:w-abc");
  assert.equal(readSightingOpened("u1"), true, "a Sighting opened in any workspace counts for the person");
  assert.equal(readSightingOpened("u2"), false);

  writeDemoTickers("u1", ["AAPL", "MSFT"]);
  assert.deepEqual(readDemoTickers("u1"), ["AAPL", "MSFT"]);
  assert.equal(readDemoTickers("u1:w-abc"), null);
  writeDemoTickers("u1", []);
  assert.equal(readDemoTickers("u1"), null);
});

test("the holdings task is done only by an import or the demo, per person, and Clear demo takes back only the demo's part", () => {
  assert.equal(readHoldingsAdded("h1"), false, "nothing recorded: 0 of 3, whatever the portfolio holds");
  assert.deepEqual(parseHoldingsSources(null), []);
  assert.deepEqual(parseHoldingsSources("demo,bogus,broker,broker"), ["broker", "demo"], "known sources only, deduplicated");

  markHoldingsAdded("h1:w-abc", "demo");
  assert.equal(readHoldingsAdded("h1"), true, "the demo the person added counts, for the person");
  assert.equal(readHoldingsAdded("h2"), false);
  clearDemoHoldings("h1");
  assert.equal(readHoldingsAdded("h1"), false, "Clear demo with the demo as the only source undoes the task");

  markHoldingsAdded("h1", "demo");
  markHoldingsAdded("h1", "broker");
  clearDemoHoldings("h1:w-abc");
  assert.deepEqual(readHoldingsSources("h1"), ["broker"], "an import keeps the task done after Clear demo");
  markHoldingsAdded("h1", "screenshot");
  markHoldingsAdded("h1", "screenshot");
  assert.deepEqual(readHoldingsSources("h1"), ["broker", "screenshot"]);

  markHoldingsAdded("preview", "demo");
  assert.equal(readHoldingsAdded("preview"), true, "the preview keeps it in memory");
  clearDemoHoldings("preview");
  assert.equal(readHoldingsAdded("preview"), false);
});

test("Clear portfolio opens the holdings task again, whatever added the holdings", () => {
  markHoldingsAdded("h3", "broker");
  markHoldingsAdded("h3", "demo");
  clearHoldingsAdded("h3:w-abc");
  assert.equal(readHoldingsAdded("h3"), false);
  assert.equal(setupProgress({ holdings: readHoldingsAdded("h3"), sighting: true, ask: true }).done, 0, "back to 0 of 3 while the first task is open");
});
