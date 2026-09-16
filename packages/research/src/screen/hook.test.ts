import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeHookKeys, decideScan } from "./hook.js";

describe("screen/hook — close-run fingerprint", () => {
  const friEvening = new Date("2026-08-21T21:30:00.000Z"); // after the 20:00Z close
  const satNoon = new Date("2026-08-22T16:00:00.000Z");
  const monMidday = new Date("2026-08-24T15:00:00.000Z"); // session open, Friday is the completed day
  const monEvening = new Date("2026-08-24T21:30:00.000Z");

  it("keys: completed session + per-ticker close days + landed count", () => {
    const k = computeHookKeys(friEvening, { NVDA: "2026-08-21", MSTR: "2026-08-20" });
    assert.equal(k.session, "2026-08-21");
    assert.equal(k.close, "MSTR:2026-08-20,NVDA:2026-08-21");
    assert.equal(k.landed, 1);
    assert.equal(k.total, 2);
  });

  it("first scan for a session fires once at least one ticker has landed; before that it waits", () => {
    const waiting = computeHookKeys(friEvening, { NVDA: "2026-08-20", MSTR: "2026-08-20" });
    assert.deepEqual(decideScan(null, waiting, "2026-08-20"), { scan: false, session: "2026-08-21", reason: null });
    const landed = computeHookKeys(friEvening, { NVDA: "2026-08-21", MSTR: "2026-08-20" });
    assert.deepEqual(decideScan(waiting, landed, "2026-08-20"), { scan: true, session: "2026-08-21", reason: "first_scan" });
    // Startup with everything already computed → first scan too.
    assert.equal(decideScan(null, landed, null).reason, "first_scan");
  });

  it("weekend / holiday: the completed session is still Friday and nothing moved → no-op", () => {
    const fri = computeHookKeys(friEvening, { NVDA: "2026-08-21", MSTR: "2026-08-21" });
    const sat = computeHookKeys(satNoon, { NVDA: "2026-08-21", MSTR: "2026-08-21" });
    assert.equal(sat.session, "2026-08-21");
    assert.deepEqual(decideScan(fri, sat, "2026-08-21"), { scan: false, session: "2026-08-21", reason: null });
    const monOpen = computeHookKeys(monMidday, { NVDA: "2026-08-21", MSTR: "2026-08-21" });
    assert.equal(monOpen.session, "2026-08-21");
    assert.equal(decideScan(sat, monOpen, "2026-08-21").scan, false);
  });

  it("a late ticker landing for an already-scanned session re-runs it (idempotent re-run)", () => {
    const partial = computeHookKeys(monEvening, { NVDA: "2026-08-24", MSTR: "2026-08-21" });
    const full = computeHookKeys(monEvening, { NVDA: "2026-08-24", MSTR: "2026-08-24" });
    assert.deepEqual(decideScan(partial, full, "2026-08-24"), { scan: true, session: "2026-08-24", reason: "close_run" });
    assert.equal(decideScan(full, full, "2026-08-24").scan, false);
  });

  it("empty universe never scans", () => {
    assert.equal(decideScan(null, computeHookKeys(friEvening, {}), null).scan, false);
  });
});
