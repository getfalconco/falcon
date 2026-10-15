import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENGINE_CHANNELS,
  STAFF_ENGINE_CHANNELS,
  isEngineStaff,
  isStaffEngineChannel,
} from "./engine-channels.js";

describe("engine channels — staff-only switches", () => {
  it("every staff-only channel is a real engine channel", () => {
    const all = new Set<string>(ENGINE_CHANNELS);
    for (const c of STAFF_ENGINE_CHANNELS) assert.ok(all.has(c), c);
  });

  it("gates the shared switches and run buttons, not the per-user writes", () => {
    for (const c of ["classifier:set-enabled", "classifier:set-rescore", "risk:set-card-enabled", "propagation:set-surfacing", "analyst:set-enabled", "gauge:reload-config", "tracker:remove-ticker"]) {
      assert.equal(isStaffEngineChannel(c), true, c);
    }
    for (const c of ["tracker:add-ticker", "risk:account-update", "risk:recompute", "risk:delete-user-data", "screen:set-watchlist", "news:feed", "risk:status"]) {
      assert.equal(isStaffEngineChannel(c), false, c);
    }
  });

  it("reads staff from the invited role only", () => {
    for (const role of ["staff", "deputy", "leader", " Leader "]) {
      assert.equal(isEngineStaff({ role }), true, role);
    }
    // Internships only: an invited role, but not engine staff.
    assert.equal(isEngineStaff({ role: "talent_manager" }), false);
    assert.equal(isEngineStaff({ role: " Talent_Manager " }), false);
    assert.equal(isEngineStaff({ approved: true }), false);
    assert.equal(isEngineStaff({ role: "member" }), false);
    assert.equal(isEngineStaff(null), false);
    assert.equal(isEngineStaff(undefined), false);
  });
});
