import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isStaffAccount } from "./staff";

describe("isStaffAccount", () => {
  it("accepts the invited internal roles, case and spaces aside", () => {
    for (const role of ["staff", "deputy", "leader", " Staff "]) {
      assert.equal(isStaffAccount({ role }), true, role);
    }
  });

  it("refuses talent_manager, which runs internships only", () => {
    assert.equal(isStaffAccount({ role: "talent_manager" }), false);
    assert.equal(isStaffAccount({ role: " Talent_Manager " }), false);
  });

  it("matches the engine's list", async () => {
    const { ENGINE_STAFF_ROLES } = await import("./staff");
    const engine = await import("@meridian/research/engine-channels");
    assert.deepEqual([...ENGINE_STAFF_ROLES], [...engine.ENGINE_STAFF_ROLES]);
  });

  it("refuses members and anything without a role", () => {
    assert.equal(isStaffAccount({ approved: true }), false);
    assert.equal(isStaffAccount({ role: "member" }), false);
    assert.equal(isStaffAccount({ role: 1 }), false);
    assert.equal(isStaffAccount(null), false);
    assert.equal(isStaffAccount(undefined), false);
  });
});
