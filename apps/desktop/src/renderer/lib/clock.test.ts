import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOCK_KEY, clockLabel, readClockChoice, withClock } from "./clock";

const store = (value: string | null) => ({ getItem: (k: string) => (k === CLOCK_KEY ? value : null) });

describe("clock", () => {
  it("reads auto when nothing, or nonsense, is kept", () => {
    assert.equal(readClockChoice(store(null)), "auto");
    assert.equal(readClockChoice(store("13")), "auto");
    assert.equal(readClockChoice(null), "auto");
  });

  it("reads a kept choice", () => {
    assert.equal(readClockChoice(store("24")), "24");
    assert.equal(readClockChoice(store("12")), "12");
  });

  it("leaves the caller's options alone on auto", () => {
    const opts = { hour: "2-digit", hour12: true } as const;
    assert.equal(withClock(opts, "auto"), opts);
  });

  it("replaces the caller's cycle on 12 or 24", () => {
    assert.deepEqual(withClock({ hour: "2-digit", hour12: true }, "24"), { hour: "2-digit", hourCycle: "h23" });
    assert.deepEqual(withClock({ hour: "2-digit", hourCycle: "h23" }, "12"), { hour: "2-digit", hour12: true });
  });

  it("formats with the chosen cycle", () => {
    const d = new Date(2026, 0, 2, 14, 5);
    const fmt = (choice: "12" | "24") =>
      d.toLocaleTimeString("en-US", withClock({ hour: "2-digit", minute: "2-digit", hour12: true }, choice));
    assert.equal(fmt("24"), "14:05");
    assert.match(fmt("12"), /^02:05\sPM$/);
  });

  it("builds axis labels on either clock", () => {
    assert.equal(clockLabel(14, 0, "24", "auto"), "14:00");
    assert.equal(clockLabel(14, 0, "24", "12"), "2:00 PM");
    assert.equal(clockLabel(0, 30, "24", "12"), "12:30 AM");
    assert.equal(clockLabel(9, 5, "12", "24"), "09:05");
  });
});
