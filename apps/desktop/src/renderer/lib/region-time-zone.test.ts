import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REGION_KEY, readRegionChoice, systemRegion } from "./region";
import { TIME_ZONE_KEY, isTimeZone, matchesZone, readTimeZoneChoice, resolveTimeZone, utcOffsetLabel, zoneCity, zoneOptions } from "./time-zone";

const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

describe("region", () => {
  it("reads the machine's country from its zone first", () => {
    assert.equal(systemRegion("Europe/Istanbul", ["en-US"]), "TR");
    assert.equal(systemRegion("Europe/Berlin", ["en-US"]), "DE");
    assert.equal(systemRegion("America/New_York", ["tr-TR"]), "US");
  });

  it("falls back to the system languages' region, and to none", () => {
    assert.equal(systemRegion("Etc/UTC", ["tr-TR"]), "TR");
    assert.equal(systemRegion("Etc/UTC", ["ja"]), "JP");
    assert.equal(systemRegion("Etc/UTC", ["es-AR"]), null);
    assert.equal(systemRegion("Etc/UTC", []), null);
  });

  it("keeps only a region the calendar covers, else automatic", () => {
    assert.equal(readRegionChoice(storage({ [REGION_KEY]: "TR" })), "TR");
    assert.equal(readRegionChoice(storage({ [REGION_KEY]: "AR" })), "auto");
    assert.equal(readRegionChoice(storage({})), "auto");
    assert.equal(readRegionChoice(null), "auto");
  });
});

describe("time zone", () => {
  it("keeps a zone the runtime knows, else the system's", () => {
    assert.equal(readTimeZoneChoice(storage({ [TIME_ZONE_KEY]: "Europe/Istanbul" })), "Europe/Istanbul");
    assert.equal(readTimeZoneChoice(storage({ [TIME_ZONE_KEY]: "Mars/Olympus" })), "system");
    assert.equal(isTimeZone("America/New_York"), true);
    assert.equal(isTimeZone(""), false);
    assert.equal(resolveTimeZone("Asia/Tokyo"), "Asia/Tokyo");
    assert.ok(resolveTimeZone("system").length > 0);
  });

  it("labels a zone by its city and its offset on the day", () => {
    assert.equal(zoneCity("America/Sao_Paulo"), "Sao Paulo");
    assert.equal(zoneCity("UTC"), "UTC");
    assert.equal(utcOffsetLabel("Europe/Istanbul", new Date("2026-10-16T12:00:00Z")), "UTC+3");
    assert.equal(utcOffsetLabel("America/New_York", new Date("2026-10-16T12:00:00Z")), "UTC-4");
    assert.equal(utcOffsetLabel("America/New_York", new Date("2026-12-16T12:00:00Z")), "UTC-5");
    assert.equal(utcOffsetLabel("Asia/Kolkata", new Date("2026-10-16T12:00:00Z")), "UTC+5:30");
  });

  it("lists the zones west to east, and finds them by city, name or offset", () => {
    const options = zoneOptions("en-US", new Date("2026-10-16T12:00:00Z"));
    assert.ok(options.length > 30);
    for (let i = 1; i < options.length; i++) assert.ok(options[i - 1]!.offsetMinutes <= options[i]!.offsetMinutes);
    const istanbul = options.find((o) => o.zone === "Europe/Istanbul")!;
    assert.ok(matchesZone(istanbul, "istanbul"));
    assert.ok(matchesZone(istanbul, "UTC+3"));
    assert.equal(matchesZone(istanbul, "tokyo"), false);
  });
});
