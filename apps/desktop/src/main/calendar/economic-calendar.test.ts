import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  FAILURE_RETRY_MS,
  FOREX_FACTORY_URL,
  NEAR_TTL_MS,
  TRADINGVIEW_URL,
  createEconomicCalendar,
  monthsBetween,
  type FetchJson,
} from "./economic-calendar";

let dir: string;
let nowMs: number;
let calls: string[];
let tvDown: boolean;
let ffDown: boolean;

const TV_ROWS = [
  { id: "1", title: "Inflation Rate YoY", country: "US", actual: null, previous: 3.4, forecast: 3.6, unit: "%", currency: "USD", importance: 1, date: "2026-10-14T12:30:00.000Z" },
  { id: "2", title: "Inflation Rate YoY", country: "TR", actual: null, previous: 31.51, forecast: 30.3, unit: "%", currency: "TRY", importance: 0, date: "2026-10-05T07:00:00.000Z" },
  { id: "3", title: "Housing Starts", country: "US", actual: 1.275, previous: 1.309, forecast: 1.31, scale: "M", currency: "USD", importance: 1, date: "2026-09-17T12:30:00.000Z" },
  { id: "4", title: "Housing Starts", country: "US", actual: null, previous: 1.275, forecast: null, currency: "USD", importance: 1, date: "2026-10-20T12:30:00.000Z" },
  { id: "5", title: "GDP Growth Rate", country: "JP", actual: null, previous: 1, forecast: 1, unit: "%", currency: "JPY", importance: 1, date: "2026-11-14T00:00:00.000Z" },
];

const FF_ROWS = [{ title: "CPI m/m", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "0.6%", previous: "0.4%" }];

const fetchJson: FetchJson = async (url) => {
  calls.push(url);
  if (url.startsWith(TRADINGVIEW_URL)) {
    if (tvDown) throw new Error("status 503");
    const from = Date.parse(new URL(url).searchParams.get("from")!);
    const to = Date.parse(new URL(url).searchParams.get("to")!);
    const countries = new URL(url).searchParams.get("countries")!.split(",");
    return { status: "ok", result: TV_ROWS.filter((r) => countries.includes(r.country) && Date.parse(r.date) >= from && Date.parse(r.date) < to) };
  }
  if (url === FOREX_FACTORY_URL) {
    if (ffDown) throw new Error("status 429");
    return FF_ROWS;
  }
  throw new Error(`unexpected ${url}`);
};

function make() {
  return createEconomicCalendar({ file: path.join(dir, "economic.json"), fetchJson, now: () => nowMs });
}

const REQUEST = { from: "2026-10-01", to: "2026-10-31", countries: ["US", "TR"] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-econ-"));
  nowMs = Date.parse("2026-10-16T09:00:00.000Z");
  calls = [];
  tvDown = false;
  ffDown = false;
});

describe("economic calendar: months", () => {
  it("lists every month a range touches", () => {
    assert.deepEqual(monthsBetween("2026-09-28", "2026-11-08"), ["2026-09", "2026-10", "2026-11"]);
    assert.deepEqual(monthsBetween("2026-12-20", "2027-01-05"), ["2026-12", "2027-01"]);
  });
});

describe("economic calendar: reading and caching", () => {
  it("asks once per month for every country, and answers from the cache after", async () => {
    const cal = make();
    const first = await cal.get(REQUEST);
    assert.ok(first.ok);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /countries=TR,US$/);
    assert.deepEqual(first.events.map((e) => e.id), ["tv:2", "tv:1", "tv:4"]);
    assert.equal(first.stale, false);
    assert.equal(first.partial, false);
    await cal.get(REQUEST);
    assert.equal(calls.length, 1);
    nowMs += NEAR_TTL_MS + 1;
    await cal.get(REQUEST);
    assert.equal(calls.length, 2);
  });

  it("keeps the reads on disk for the next start", async () => {
    const cal = make();
    await cal.get(REQUEST);
    cal.flush();
    const again = make();
    const answer = await again.get(REQUEST);
    assert.ok(answer.ok);
    assert.equal(calls.length, 1);
  });

  it("gives a future row the unit and scale its series printed before", async () => {
    const cal = make();
    const answer = await cal.get({ from: "2026-09-01", to: "2026-10-31", countries: ["US"] });
    assert.ok(answer.ok);
    const october = answer.events.find((e) => e.id === "tv:4")!;
    assert.deepEqual([october.unit, october.scale], [null, "M"]);
  });

  it("serves the last good read, marked stale, when the source fails", async () => {
    const cal = make();
    await cal.get(REQUEST);
    tvDown = true;
    nowMs += NEAR_TTL_MS + 1;
    const answer = await cal.get(REQUEST);
    assert.ok(answer.ok);
    assert.equal(answer.stale, true);
    assert.deepEqual(answer.sources, [{ id: "tradingview", ok: false }]);
    assert.equal(answer.events.length, 3);
    // A failure is not asked about again straight away.
    const before = calls.length;
    nowMs += FAILURE_RETRY_MS / 2;
    await cal.get(REQUEST);
    assert.equal(calls.length, before);
  });

  it("falls back to this week's file when there is nothing else, marked partial", async () => {
    tvDown = true;
    const answer = await make().get(REQUEST);
    assert.ok(answer.ok);
    assert.equal(answer.partial, true);
    assert.deepEqual(answer.sources, [{ id: "tradingview", ok: false }, { id: "forexfactory", ok: true }]);
    assert.equal(answer.events.length, 1);
    assert.equal(answer.events[0]!.source, "forexfactory");
    assert.equal(answer.events[0]!.country, "US");
  });

  it("answers unavailable, never a provider's words, when both sources fail", async () => {
    tvDown = true;
    ffDown = true;
    const answer = await make().get(REQUEST);
    assert.deepEqual(answer, { ok: false, error: "unavailable" });
  });

  it("returns only the range asked for, with a day either side", async () => {
    const answer = await make().get({ from: "2026-10-13", to: "2026-10-15", countries: ["US", "TR"] });
    assert.ok(answer.ok);
    assert.deepEqual(answer.events.map((e) => e.id), ["tv:1"]);
  });
});
