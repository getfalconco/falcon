import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CalendarSector } from "./calendar-events";
import { LARGE_CAP_USD, SECTOR_MIN_CAP_USD, calendarSectorsFor, forYouReason, mineReason, reasonRank } from "./earnings-foryou";

const tech = new Set<CalendarSector>(["Technology"]);

describe("why a report is for you", () => {
  it("a filing link comes before a sector fit, and a sector fit before size", () => {
    assert.equal(forYouReason({ ticker: "QCOM", cap: 180e9, sector: "Technology", linked: true }, tech), "linked");
    assert.equal(forYouReason({ ticker: "IBM", cap: 230e9, sector: "Technology", linked: false }, tech), "sector");
    assert.equal(forYouReason({ ticker: "KO", cap: 400e9, sector: "Consumer Staples", linked: false }, tech), "large");
  });

  it("a linked company is listed even without a market value on record", () => {
    assert.equal(forYouReason({ ticker: "AMKR", cap: null, sector: null, linked: true }, tech), "linked");
  });

  it("a sector fit needs a sizeable company; size alone needs a large one", () => {
    assert.equal(forYouReason({ ticker: "SMALL", cap: SECTOR_MIN_CAP_USD - 1, sector: "Technology", linked: false }, tech), null);
    assert.equal(forYouReason({ ticker: "MID", cap: SECTOR_MIN_CAP_USD, sector: "Technology", linked: false }, tech), "sector");
    assert.equal(forYouReason({ ticker: "MID", cap: 20e9, sector: "Energy", linked: false }, tech), null);
    assert.equal(forYouReason({ ticker: "BIG", cap: LARGE_CAP_USD, sector: null, linked: false }, new Set()), "large");
    assert.equal(forYouReason({ ticker: "NONE", cap: null, sector: "Technology", linked: false }, tech), null);
  });

  it("the reader's own names are held first, then watched", () => {
    const held = new Set(["NVDA"]);
    const watch = new Set(["NVDA", "TSM"]);
    assert.equal(mineReason("NVDA", held, watch), "held");
    assert.equal(mineReason("TSM", held, watch), "watchlist");
    assert.equal(mineReason("KO", held, watch), null);
  });

  it("ranks held, watched, linked, sector, large, then anything else", () => {
    const order = (["large", "sector", null, "held", "linked", "watchlist"] as const).slice().sort((a, b) => reasonRank(a) - reasonRank(b));
    assert.deepEqual(order, ["held", "watchlist", "linked", "sector", "large", null]);
  });
});

describe("the sectors picked at onboarding", () => {
  it("map to the calendar's sectors, each once", () => {
    assert.deepEqual(calendarSectorsFor(["semiconductors", "technology"]).sort(), ["Communication Services", "Technology"]);
    assert.deepEqual(calendarSectorsFor(["consumer"]).sort(), ["Consumer Discretionary", "Consumer Staples"]);
    assert.deepEqual(calendarSectorsFor(["crypto", "nonsense"]), []);
  });
});
