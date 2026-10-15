import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  DASHBOARD_CARD_ORDER,
  DESK_BY_HOLDING,
  DESK_MODULES,
  HOLDING_PERIODS,
  MODULE_CARDS,
  defaultDeskCards,
  deskCardOrder,
  inCardOrder,
  isHoldingPeriod,
  isPositionsMode,
  parseDeskCards,
} from "./onboarding-desk";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("the desk each holding period opens with", () => {
  it("days: positions, the tape, upcoming earnings and the calendar", () => {
    assert.deepEqual(defaultDeskCards("days"), ["portfolio", "assets", "calendar", "news", "earnings"]);
  });

  it("weeks to months: positions, the tape, earnings and risk", () => {
    assert.deepEqual(defaultDeskCards("weeks_months"), ["portfolio", "assets", "news", "risk", "earnings"]);
  });

  it("years: positions, the earnings record and risk", () => {
    assert.deepEqual(defaultDeskCards("years"), ["portfolio", "assets", "risk", "agents"]);
  });

  it("asks exactly the three holding periods, and maps every one", () => {
    assert.deepEqual([...HOLDING_PERIODS], ["days", "weeks_months", "years"]);
    for (const period of HOLDING_PERIODS) assert.ok(DESK_BY_HOLDING[period].length > 0, period);
  });

  it("draws earnings, upcoming or not, with the Earnings card, and the track record with Agents", () => {
    assert.deepEqual(MODULE_CARDS.earnings, ["earnings"]);
    assert.deepEqual(MODULE_CARDS.earnings_upcoming, ["earnings"]);
    assert.deepEqual(MODULE_CARDS.earnings_track_record, ["agents"]);
  });

  it("draws every part of a desk with at least one card the dashboard has", () => {
    for (const module of DESK_MODULES) {
      assert.ok(MODULE_CARDS[module].length > 0, module);
      for (const card of MODULE_CARDS[module]) assert.ok(DASHBOARD_CARD_ORDER.includes(card), `${module} -> ${card}`);
    }
  });

  it("never turns on a card the build hides", () => {
    for (const period of HOLDING_PERIODS) assert.ok(!defaultDeskCards(period).includes("insight"), period);
  });
});

describe("writing the desk", () => {
  it("keeps the dashboard's order whatever order the cards were picked in", () => {
    assert.deepEqual(deskCardOrder(["risk", "news", "portfolio"]), ["portfolio", "news", "risk"]);
  });

  it("keeps a hidden card in its place, so a later build that shows it again finds it", () => {
    assert.deepEqual(deskCardOrder(["portfolio", "risk"], ["insight"]), ["portfolio", "insight", "risk"]);
  });

  it("drops ids it does not know and repeats", () => {
    assert.deepEqual(inCardOrder(["news", "nope", "news", "assets"]), ["assets", "news"]);
    assert.deepEqual(parseDeskCards(["agents", 3, "tape?", "portfolio"]), ["portfolio", "agents"]);
    assert.deepEqual(parseDeskCards("portfolio"), []);
  });

  it("reads stored ids back only when they are its own", () => {
    assert.ok(isHoldingPeriod("years"));
    assert.ok(!isHoldingPeriod("mixed"));
    assert.ok(isPositionsMode("watch"));
    assert.ok(!isPositionsMode("paper"));
  });
});

describe("the dashboard and the desk agree on the cards", () => {
  const page = fs.readFileSync(path.join(HERE, "..", "renderer", "pages", "HomePage.tsx"), "utf8");

  it("every card kind the dashboard knows is a desk card, and the reverse", () => {
    const union = /type CardBase = ([^;]+);/.exec(page);
    assert.ok(union, "type CardBase is not where this test looks");
    const kinds = [...union[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
    assert.deepEqual([...kinds].sort(), [...DASHBOARD_CARD_ORDER].sort());
  });

  it("the dashboard's fresh order is the desk's order", () => {
    assert.match(page, /const DEFAULT_CARD_ORDER: CardId\[\] = \[\.\.\.DASHBOARD_CARD_ORDER\];/);
  });
});
