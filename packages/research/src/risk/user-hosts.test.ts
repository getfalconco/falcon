import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { computeRiskSnapshot } from "./compute.js";
import type { RiskAccountPush } from "./host-types.js";
import { account, cfg, inputs, position, quant } from "./test-fixtures.js";
import { RiskUserHosts, deleteUserRiskData, isValidRiskUserId } from "./user-hosts.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const roots: RiskUserHosts[] = [];
function registry(): RiskUserHosts {
  const hosts = new RiskUserHosts(fs.mkdtempSync(path.join(os.tmpdir(), "falcon-risk-users-")));
  roots.push(hosts);
  return hosts;
}
// setAccount arms a debounced recompute; stop every host so no timer outlives the test.
after(() => {
  for (const hosts of roots) hosts.stop();
});

function push(ticker: string, shares: number, cash: number): RiskAccountPush {
  return {
    account: "paper",
    cash,
    positions: [{ ticker, shares, cost_usd: shares * 100, market_value: null }],
    as_of: "2026-10-15T14:00:00.000Z",
  };
}

function snap(at: string, ticker: string) {
  return computeRiskSnapshot(
    inputs({ now: at, account: account([position(ticker, 1, 100)]), quant: { [ticker]: quant() } }),
    cfg(),
    { trigger: ["manual"] },
  );
}

describe("risk/user-hosts — per-user isolation", () => {
  it("keeps each user's paper account apart: the second push does not overwrite the first", () => {
    const hosts = registry();
    hosts.get(ALICE).setAccount(push("NVDA", 10, 1_000));
    hosts.get(BOB).setAccount(push("PFE", 3, 50));

    const a = hosts.status(ALICE).account;
    const b = hosts.status(BOB).account;
    assert.equal(a.cash, 1_000);
    assert.equal(b.cash, 50);
    assert.equal(a.positions, 1);

    const aliceFile = JSON.parse(fs.readFileSync(path.join(hosts.userDir(ALICE), "account.json"), "utf8"));
    const bobFile = JSON.parse(fs.readFileSync(path.join(hosts.userDir(BOB), "account.json"), "utf8"));
    assert.equal(aliceFile.positions[0].ticker, "NVDA");
    assert.equal(bobFile.positions[0].ticker, "PFE");
    // Nothing lands in the shared location any more.
    assert.equal(fs.existsSync(path.join(hosts.rootDir, "account.json")), false);
  });

  it("serves latest/history from the caller's own snapshots only", () => {
    const hosts = registry();
    hosts.get(ALICE).snapshotStore.append(snap("2026-10-15T14:00:00.000Z", "NVDA"));
    hosts.get(ALICE).snapshotStore.append(snap("2026-10-15T15:00:00.000Z", "NVDA"));

    assert.equal(hosts.latest(ALICE).snapshot?.computed_at, "2026-10-15T15:00:00.000Z");
    assert.equal(hosts.history(ALICE).length, 2);
    // Bob never pushed anything: he sees nothing, not Alice's data.
    assert.equal(hosts.latest(BOB).snapshot, null);
    assert.deepEqual(hosts.history(BOB), []);
    assert.equal(hosts.status(BOB).account.received, false);
    assert.equal(hosts.status(BOB).snapshotCount, 0);
  });

  it("a read for a user without state creates no directory and starts no host", () => {
    const hosts = registry();
    hosts.start();
    hosts.latest(BOB);
    hosts.history(BOB);
    hosts.status(BOB);
    assert.equal(fs.existsSync(path.join(hosts.usersDir, BOB)), false);
    assert.equal(hosts.liveCount, 0);
  });

  it("refuses ids that are not Supabase user ids (they become path segments)", () => {
    const hosts = registry();
    for (const bad of ["", "../config", "..", "abc", `${ALICE}/x`, "11111111-1111-4111-8111-11111111111g"]) {
      assert.equal(isValidRiskUserId(bad), false, bad);
      assert.throws(() => hosts.get(bad), /invalid user id/);
      assert.throws(() => hosts.latest(bad), /invalid user id/);
      assert.throws(() => deleteUserRiskData(bad, hosts), /invalid user id/);
    }
    // Case-insensitive, one directory per user.
    assert.equal(hosts.userDir(ALICE.toUpperCase()), hosts.userDir(ALICE));
  });

  it("start() brings back a host for every user with state on disk", () => {
    const first = registry();
    first.get(ALICE).setAccount(push("NVDA", 1, 10));
    first.stop();
    const second = new RiskUserHosts(first.rootDir);
    roots.push(second);
    assert.deepEqual(second.start().users, 1);
    assert.equal(second.status(ALICE).account.cash, 10);
  });
});

describe("risk/user-hosts — legacy shared state", () => {
  it("archives the old shared account/snapshots once, never serves them, never deletes them", () => {
    const hosts = registry();
    fs.mkdirSync(hosts.rootDir, { recursive: true });
    fs.writeFileSync(path.join(hosts.rootDir, "account.json"), JSON.stringify(push("TSLA", 5, 999)), "utf8");
    fs.writeFileSync(path.join(hosts.rootDir, "snapshots.json"), JSON.stringify([snap("2026-10-01T00:00:00.000Z", "TSLA")]), "utf8");

    const { archived } = hosts.start();
    assert.ok(archived);
    assert.equal(fs.existsSync(path.join(hosts.rootDir, "account.json")), false);
    assert.equal(fs.existsSync(path.join(hosts.rootDir, "snapshots.json")), false);
    assert.ok(fs.existsSync(path.join(archived, "account.json")));
    assert.ok(fs.existsSync(path.join(archived, "snapshots.json")));

    // No user inherits the shared book.
    assert.equal(hosts.status(ALICE).account.received, false);
    assert.equal(hosts.latest(ALICE).snapshot, null);
    // Idempotent: nothing left to archive.
    assert.equal(hosts.archiveLegacySharedState(), null);
  });
});

describe("risk/user-hosts — deleteUserRiskData", () => {
  it("removes one user's account and history and leaves the other user's intact", () => {
    const hosts = registry();
    hosts.get(ALICE).setAccount(push("NVDA", 10, 1_000));
    hosts.get(ALICE).snapshotStore.append(snap("2026-10-15T14:00:00.000Z", "NVDA"));
    hosts.get(BOB).setAccount(push("PFE", 3, 50));

    const result = deleteUserRiskData(ALICE, hosts);
    assert.equal(result.deleted, true);
    assert.equal(fs.existsSync(hosts.userDir(ALICE)), false);
    assert.equal(hosts.status(ALICE).account.received, false);
    assert.equal(hosts.latest(ALICE).snapshot, null);
    assert.equal(hosts.status(BOB).account.cash, 50);

    // Idempotent.
    assert.equal(deleteUserRiskData(ALICE, hosts).deleted, false);
  });
});

describe("risk/host — clearState (desktop, single user)", () => {
  it("forgets the account and history on disk and in memory", () => {
    const hosts = registry();
    const host = hosts.get(ALICE);
    host.setAccount(push("NVDA", 10, 1_000));
    host.snapshotStore.append(snap("2026-10-15T14:00:00.000Z", "NVDA"));
    assert.deepEqual(host.clearState(), { cleared: true });
    assert.equal(host.status().account.received, false);
    assert.equal(host.latest().snapshot, null);
    assert.equal(fs.existsSync(host.accountStore.file), false);
    assert.equal(fs.existsSync(host.snapshotStore.file), false);
    assert.deepEqual(host.clearState(), { cleared: false });
  });
});

describe("RiskUserHosts — held tickers (Screen's shared emit gate)", () => {
  it("reads each user's own book and unions them without mixing", () => {
    const hosts = registry();
    hosts.get(ALICE).setAccount(push("NVDA", 10, 1_000));
    hosts.get(BOB).setAccount(push("PFE", 0, 50));
    assert.deepEqual(hosts.heldTickers(ALICE), ["NVDA"]);
    // A flat position is not a holding.
    assert.deepEqual(hosts.heldTickers(BOB), []);
    assert.deepEqual(hosts.allHeldTickers(), ["NVDA"]);
    assert.throws(() => hosts.heldTickers("../x"), /invalid user id/);
  });
});
