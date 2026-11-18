// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/bring-portfolio.test.ts
// Pure checks of the "Bring your portfolio" panel's steps; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_LABEL, DONE_AUTO_CLOSE_MS, demoStage, droppedImage, importStage, shownTickers, stageView } from "./bring-portfolio";

test("while the broker window is open or holdings are read, the step spins and offers only Cancel", () => {
  const opening = stageView({ step: "opening" });
  assert.equal(opening.title, "Connecting your broker");
  assert.match(opening.body, /SnapTrade/);
  assert.match(opening.body, /SnapTrade/);
  assert.equal(opening.tone, "busy");
  assert.deepEqual(opening.actions, ["cancel"]);
  assert.equal(stageView({ step: "reading", source: "broker" }).title, "Reading your holdings…");
  assert.equal(stageView({ step: "reading", source: "screenshot" }).title, "Reading your screenshot…");
  assert.deepEqual(stageView({ step: "reading", source: "screenshot" }).actions, ["cancel"]);
});

test("a blocked window offers to open it again; errors and a cancelled window offer Try again and Back", () => {
  const blocked = stageView({ step: "blocked" });
  assert.deepEqual(blocked.actions, ["reopen", "back"]);
  assert.match(blocked.body, /Allow pop-ups for this site to connect your broker\./);
  assert.equal(ACTION_LABEL.reopen, "Open it again");
  const error = stageView({ step: "error", source: "broker", text: "We couldn't reach the broker service." });
  assert.equal(error.body, "We couldn't reach the broker service.", "the flow's own message is shown as is");
  assert.deepEqual(error.actions, ["retry", "back"]);
  assert.equal(error.tone, "problem");
  assert.deepEqual(stageView({ step: "cancelled" }).actions, ["retry", "back"]);
});

test("the preview says there is no account and offers only Back", () => {
  const broker = stageView({ step: "preview", source: "broker" });
  assert.equal(broker.body, "Sign in to connect a broker. The preview has no account.");
  assert.deepEqual(broker.actions, ["back"]);
  assert.equal(stageView({ step: "preview", source: "screenshot" }).body, "Sign in to upload a screenshot. The preview has no account.");
});

test("holdings that came back give the card's imported message and close by themselves", () => {
  const done = importStage("broker", [{ ticker: "AAPL" }, { ticker: "MSFT" }, { ticker: "AAPL" }]);
  assert.deepEqual(done, { step: "done", title: "Holdings added", text: "Added 3 tickers from your broker to your portfolio.", tickers: ["AAPL", "MSFT"] });
  const one = importStage("screenshot", [{ ticker: "NVDA" }]);
  assert.equal(one.step === "done" && one.text, "Added 1 ticker from your screenshot to your portfolio.");
  const sized = importStage("broker", [{ ticker: "AAPL" }], "Added 12 positions and 2 account balances.");
  assert.equal(sized.step === "done" && sized.text, "Added 12 positions and 2 account balances.", "the import's own line when the route sent it");
  if (done.step !== "done") throw new Error("expected done");
  const view = stageView(done);
  assert.deepEqual(view.actions, ["done"]);
  assert.equal(view.autoCloseMs, DONE_AUTO_CLOSE_MS);
  assert.ok(DONE_AUTO_CLOSE_MS >= 1000 && DONE_AUTO_CLOSE_MS <= 1500);
});

test("nothing coming back is an error with the flow's existing wording", () => {
  assert.deepEqual(importStage("broker", []), { step: "error", source: "broker", text: "No holdings came back from your broker. Try again or upload a screenshot." });
  assert.deepEqual(importStage("screenshot", undefined), { step: "error", source: "screenshot", text: "We couldn't find any tickers in that screenshot." });
});

test("the demo's done step names what it added", () => {
  assert.deepEqual(demoStage(["AAPL", "MSFT"]), { step: "done", title: "Paper portfolio added", text: "Added 2 paper tickers to your portfolio.", tickers: ["AAPL", "MSFT"] });
  const none = demoStage([]);
  assert.equal(none.step === "done" && none.text, "The paper portfolio's tickers are already in your portfolio.");
});

test("long ticker lists are cut with a count; only an image is taken from a drop", () => {
  const many = Array.from({ length: 15 }, (_, i) => `T${i}`);
  assert.deepEqual(shownTickers(many), { shown: many.slice(0, 12), more: 3 });
  assert.deepEqual(shownTickers(["A"]), { shown: ["A"], more: 0 });
  const csv = { type: "text/csv", name: "a.csv" };
  const png = { type: "image/png", name: "p.png" };
  const heic = { type: "", name: "IMG_1.HEIC" };
  assert.equal(droppedImage([csv, png]), png);
  assert.equal(droppedImage([heic]), heic);
  assert.equal(droppedImage([csv]), null);
});
