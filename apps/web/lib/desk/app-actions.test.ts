// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/app-actions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionInputError,
  actionFromTool,
  actionLabel,
  actionTicker,
  appContextText,
  cleanAppContext,
  describeFilterToken,
  graphFilterTokens,
  parseAppAction,
  portfolioWeightsText,
  showInGraphFilters,
} from "./app-actions";
import { deskToolCommand } from "./tools/command";

test("tickers normalize to the graph's form and bad ones are refused", () => {
  assert.equal(actionTicker(" nvda "), "NVDA");
  assert.equal(actionTicker("$brk.b"), "BRK-B");
  assert.throws(() => actionTicker("Nvidia Corporation"), ActionInputError);
  assert.throws(() => actionTicker(42), ActionInputError);
});

test("action tools become checked actions", () => {
  assert.deepEqual(actionFromTool("open_ticker", { ticker: "aapl" }), { type: "open_ticker", ticker: "AAPL" });
  assert.deepEqual(actionFromTool("open_dashboard", {}), { type: "open_dashboard" });
  assert.deepEqual(actionFromTool("open_dashboard", { view: "sightings" }), { type: "open_sightings" });
  assert.deepEqual(actionFromTool("show_in_graph", { ticker: "NVDA", relations: ["supplier", "peer"] }), { type: "show_in_graph", ticker: "NVDA", relations: ["supplier", "partner"] });
  assert.throws(() => actionFromTool("show_in_graph", { ticker: "NVDA", relations: ["friend"] }), ActionInputError);
  assert.throws(() => actionFromTool("open_sighting", { card_id: "bad id with spaces" }), ActionInputError);
  assert.throws(() => actionFromTool("delete_everything", {}), ActionInputError);
});

test("set_graph_filters maps to filter-bar tokens", () => {
  const { filters, summary } = graphFilterTokens({ sectors: ["Information Technology"], opportunities: true, relations: ["customer"], strength: ["critical"], implied_vol: "high", min_links: 4 });
  assert.deepEqual(
    filters.map((f) => [f.field, f.operator, f.values]),
    [
      ["sector", "is_any", ["Information Technology"]],
      ["relation", "is_any", ["1"]],
      ["strength", "is_any", ["3"]],
      ["opportunity", "is", ["has"]],
      ["iv", "is_any", ["high"]],
      ["size", "at_least", ["3"]],
    ],
  );
  assert.match(summary, /Information Technology/);
  assert.deepEqual(graphFilterTokens({ clear: true }).filters, []);
  assert.throws(() => graphFilterTokens({}), ActionInputError);
  assert.throws(() => graphFilterTokens({ sectors: ["<script>"] }), ActionInputError);
  assert.throws(() => graphFilterTokens({ implied_vol: "huge" }), ActionInputError);
});

test("stream and storage actions are re-checked", () => {
  const a = actionFromTool("set_graph_filters", { sectors: ["Energy"] });
  assert.deepEqual(parseAppAction(JSON.parse(JSON.stringify(a))), a);
  assert.equal(parseAppAction({ type: "trade", ticker: "NVDA" }), null);
  assert.equal(parseAppAction({ type: "open_ticker", ticker: "not a ticker" }), null);
  assert.equal(parseAppAction(null), null);
  const odd = parseAppAction({ type: "set_graph_filters", filters: [{ field: "evil", operator: "is", values: ["x"] }, { field: "sector", operator: "is_any", values: ["Energy"] }] });
  assert.equal(odd?.type === "set_graph_filters" && odd.filters.length, 1);
});

test("labels, graph tokens and commands", () => {
  const show = actionFromTool("show_in_graph", { ticker: "NVDA" });
  assert.equal(actionLabel(show), "Showed NVDA in the Graph");
  assert.deepEqual(showInGraphFilters(show as Extract<typeof show, { type: "show_in_graph" }>), [{ id: "ai-company", field: "company", operator: "is_any", values: ["NVDA"] }]);
  assert.equal(describeFilterToken({ id: "x", field: "relation", operator: "is_any", values: ["0", "1"] }), "relation is any supplier, customer");
  assert.equal(deskToolCommand("falcon_graph", { ticker: "nvda" }).cmd, "/graph NVDA");
  assert.equal(deskToolCommand("falcon_sightings", { list: "opportunities" }).cmd, "/sightings opportunities");
  assert.equal(deskToolCommand("falcon_options", { ticker: "NVDA" }).cmd, "/options NVDA");
  assert.equal(deskToolCommand("falcon_options", { ticker: "aapl", detail: "surface" }).cmd, "/options AAPL surface");
  assert.equal(deskToolCommand("falcon_options", { ticker: "SOUN", detail: "smile", expiration: "2026-12-18", live: true }).cmd, "/options SOUN smile 2026-12-18 live");
  assert.equal(deskToolCommand("show_in_graph", { ticker: "NVDA" }).cmd, "/show-graph NVDA");
});

test("app context is trimmed and described", () => {
  assert.equal(cleanAppContext("nope"), null);
  assert.equal(cleanAppContext({}), null);
  const c = cleanAppContext({ view: "Ticker page for NVDA", ticker: "nvda", tabs: ["NVDA", 3, "Graph"], focus: ["AAPL", "bad ticker!"], extra: "ignored", sighting: { id: "c1", title: "NVDA beat", ticker: "NVDA" } });
  assert.deepEqual(c, { view: "Ticker page for NVDA", ticker: "NVDA", tabs: ["NVDA", "Graph"], focus: ["AAPL"], sighting: { id: "c1", title: "NVDA beat", ticker: "NVDA" } });
  const text = appContextText(c);
  assert.match(text, /Company on screen: NVDA/);
  assert.match(text, /card_id c1/);
  assert.match(text, /Portfolio \(tickers the member imported, or their paper portfolio's\): AAPL/, "the focus field carries the portfolio");
  assert.equal(appContextText(null), "");
});

test("set_graph_filters takes portfolio, and focus_list as its old name", () => {
  const on = graphFilterTokens({ portfolio: true });
  assert.deepEqual(on.filters.map((f) => [f.field, f.operator, f.values]), [["focus", "is", ["in"]]]);
  assert.equal(on.summary, "portfolio");
  assert.deepEqual(graphFilterTokens({ focus_list: false }).filters.map((f) => f.operator), ["is_not"]);
  assert.equal(describeFilterToken(on.filters[0]), "in portfolio");
});

test("the sizes block gives whole percents only, never amounts, and names the paper portfolio", () => {
  const text = portfolioWeightsText(
    [
      { ticker: "NVDA", kind: "equity", weightPct: 31, unrealisedPct: 152 },
      { ticker: "INTC", kind: "equity", weightPct: -2, unrealisedPct: -71 },
      { ticker: "BTC", kind: "crypto", weightPct: 5, unrealisedPct: null },
      { ticker: "THYAO.IS", kind: "equity", weightPct: null, unrealisedPct: 4 },
    ],
    true,
  );
  assert.match(text, /NVDA 31%, \+152% vs cost; INTC -2%, -71% vs cost; BTC \(crypto\) 5%; THYAO\.IS no weight \(other currency\), \+4% vs cost/);
  assert.match(text, /none may be stated or guessed/);
  assert.match(text, /paper portfolio/);
  assert.doesNotMatch(text, /\$/, "no dollar sign anywhere");
  assert.equal(portfolioWeightsText([], false), "");
});
