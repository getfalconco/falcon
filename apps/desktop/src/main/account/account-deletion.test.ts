import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { deleteAccountFromDesktop, retryPendingCleanups, type DesktopDeletionDeps, type ServerDeleteResult } from "./account-deletion";
import { readPendingCleanups, wipeLocalAccountData, writePendingCleanups, type PendingCleanup, type WipeResult } from "./local-account-wipe";

const ID = "7a1c2e9e-5b2f-4d9c-9f1e-1234567890ab";
const OTHER = "0b8f6a1d-0000-4000-8000-000000000000";
const TOKEN = "header.payload.sig";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-account-"));
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("wipeLocalAccountData", () => {
  it("removes the account's agents, calendar events, briefings, narratives, photo and SnapTrade identity, and nobody else's", async () => {
    const root = tempRoot();
    write(path.join(root, "agents", ID, "agents.json"), "{}");
    write(path.join(root, "agents", OTHER, "agents.json"), "{}");
    write(
      path.join(root, "calendar", "user-events.json"),
      JSON.stringify({ schema_version: 1, users: { [ID]: [{ id: "a" }], [OTHER]: [{ id: "b" }] } }),
    );
    write(path.join(root, "briefing", `report.${ID}.2026-10-14.abc123.json`), "{}");
    write(path.join(root, "briefing", "_dev", `report.${ID}.2026-10-14.abc123.json`), "{}");
    write(path.join(root, "briefing", `report.${OTHER}.2026-10-14.abc123.json`), "{}");
    write(
      path.join(root, "briefing", "narratives.json"),
      JSON.stringify({ schema_version: 1, sessions: { [`${ID}:2026-10-14`]: {}, [`${OTHER}:2026-10-14`]: {} } }),
    );
    write(path.join(root, "profile", "avatars", `${ID}.webp`), Buffer.from([1, 2, 3]));
    write(path.join(root, "profile", "avatars", `${OTHER}.webp`), Buffer.from([1]));
    write(path.join(root, "research", "AAPL.meta.json"), "{}"); // shared cache: stays

    let snaptradeRemoved = false;
    const result = await wipeLocalAccountData(root, ID, { removeSnaptradeIdentity: () => void (snaptradeRemoved = true) });

    assert.deepEqual(result.failed, []);
    assert.ok(snaptradeRemoved);
    assert.ok(!fs.existsSync(path.join(root, "agents", ID)));
    assert.ok(fs.existsSync(path.join(root, "agents", OTHER, "agents.json")));
    const cal = JSON.parse(fs.readFileSync(path.join(root, "calendar", "user-events.json"), "utf8"));
    assert.deepEqual(Object.keys(cal.users), [OTHER]);
    assert.ok(!fs.existsSync(path.join(root, "briefing", `report.${ID}.2026-10-14.abc123.json`)));
    assert.ok(!fs.existsSync(path.join(root, "briefing", "_dev", `report.${ID}.2026-10-14.abc123.json`)));
    assert.ok(fs.existsSync(path.join(root, "briefing", `report.${OTHER}.2026-10-14.abc123.json`)));
    const nar = JSON.parse(fs.readFileSync(path.join(root, "briefing", "narratives.json"), "utf8"));
    assert.deepEqual(Object.keys(nar.sessions), [`${OTHER}:2026-10-14`]);
    assert.ok(!fs.existsSync(path.join(root, "profile", "avatars", `${ID}.webp`)));
    assert.ok(fs.existsSync(path.join(root, "profile", "avatars", `${OTHER}.webp`)));
    assert.ok(fs.existsSync(path.join(root, "research", "AAPL.meta.json")));
  });

  it("reports a step that failed and still runs the rest", async () => {
    const root = tempRoot();
    write(path.join(root, "profile", "avatars", `${ID}.png`), Buffer.from([1]));
    const result = await wipeLocalAccountData(root, ID, {
      removeSnaptradeIdentity: () => {
        throw new Error("locked");
      },
    });
    assert.deepEqual(result.failed, ["snaptrade"]);
    assert.ok(result.removed.includes("profile-photo"));
    assert.ok(!fs.existsSync(path.join(root, "profile", "avatars", `${ID}.png`)));
  });

  it("refuses the signed-out pool and anything that is not an id", async () => {
    await assert.rejects(() => wipeLocalAccountData(tempRoot(), "local"));
    await assert.rejects(() => wipeLocalAccountData(tempRoot(), "../x"));
  });

  it("keeps the pending record on disk, and removes the file once empty", () => {
    const root = tempRoot();
    writePendingCleanups(root, [{ accountId: ID, since: "2026-10-15T00:00:00.000Z" }]);
    assert.equal(readPendingCleanups(root).length, 1);
    writePendingCleanups(root, []);
    assert.equal(fs.existsSync(path.join(root, "account-cleanup.json")), false);
  });
});

type Fake = DesktopDeletionDeps & { calls: string[]; store: PendingCleanup[] };

function fakeDeps(over: Partial<DesktopDeletionDeps> & { wipeResult?: WipeResult; server?: ServerDeleteResult } = {}): Fake {
  const calls: string[] = [];
  const store: PendingCleanup[] = [];
  const d: Fake = {
    calls,
    store,
    accountIdFromToken: () => ID,
    clearEngineRiskData: async () => {
      calls.push("engine");
      return { ok: true, remote: true };
    },
    deleteOnServer: async () => {
      calls.push("server");
      return over.server ?? { ok: true, cleanup: { snaptrade: "done", engine: "done" } };
    },
    localSnaptradeUserId: () => `falcon-${ID}`,
    deleteSnaptradeUser: async (id) => {
      calls.push(`snaptrade:${id}`);
    },
    wipe: async (id) => {
      calls.push(`wipe:${id}`);
      return over.wipeResult ?? { removed: ["agents"], failed: [] };
    },
    pending: {
      read: () => store.map((p) => ({ ...p })),
      write: (list) => {
        store.splice(0, store.length, ...list);
        calls.push(`pending:${list.length}`);
      },
    },
    log: () => {},
    now: () => new Date("2026-10-15T12:00:00.000Z"),
  };
  return Object.assign(d, over);
}

describe("deleteAccountFromDesktop", () => {
  it("erases engine data, deletes on the server, then cleans this machine, in that order", async () => {
    const d = fakeDeps();
    const out = await deleteAccountFromDesktop(TOKEN, d);
    assert.deepEqual(out, { ok: true, accountId: ID, notices: [] });
    assert.deepEqual(d.calls, ["engine", "server", "pending:1", `snaptrade:falcon-${ID}`, `wipe:${ID}`, "pending:0"]);
    assert.deepEqual(d.store, []);
  });

  it("touches nothing local when the server did not delete the account", async () => {
    const d = fakeDeps({ server: { ok: false, error: "Your account was not deleted. Try again later." } });
    const out = await deleteAccountFromDesktop(TOKEN, d);
    assert.deepEqual(out, { ok: false, error: "Your account was not deleted. Try again later." });
    assert.ok(!d.calls.some((c) => c.startsWith("wipe") || c.startsWith("snaptrade") || c.startsWith("pending")));
  });

  it("says SnapTrade will be retried when the server queued it", async () => {
    const d = fakeDeps({ server: { ok: true, cleanup: { snaptrade: "queued", engine: "done" } } });
    const out = await deleteAccountFromDesktop(TOKEN, d);
    assert.deepEqual(out.ok && out.notices, ["snaptrade-retry"]);
  });

  it("keeps a retry record when the local SnapTrade delete or a file fails, and finishes it later", async () => {
    let snaptradeUp = false;
    let disk: WipeResult = { removed: [], failed: ["briefings"] };
    const d = fakeDeps({
      deleteSnaptradeUser: async () => {
        if (!snaptradeUp) throw new Error("ETIMEDOUT");
      },
      wipe: async () => disk,
    });
    const out = await deleteAccountFromDesktop(TOKEN, d);
    assert.deepEqual(out.ok && out.notices, ["snaptrade-retry", "local-retry"]);
    assert.deepEqual(d.store, [{ accountId: ID, snaptradeUserId: `falcon-${ID}`, clearRisk: false, since: "2026-10-15T12:00:00.000Z" }]);

    snaptradeUp = true;
    disk = { removed: ["briefings"], failed: [] };
    assert.equal(await retryPendingCleanups(d), 0);
    assert.deepEqual(d.store, []);
  });

  it("does not tell the reader about engine data it already erased with the session", async () => {
    const d = fakeDeps({ server: { ok: true, cleanup: { snaptrade: "none", engine: "unavailable" } } });
    const out = await deleteAccountFromDesktop(TOKEN, d);
    assert.deepEqual(out.ok && out.notices, []);
  });

  it("says when engine data could not be erased and the server cannot either", async () => {
    const d = fakeDeps({
      clearEngineRiskData: async () => ({ ok: false, remote: true }),
      server: { ok: true, cleanup: { snaptrade: "none", engine: "unavailable" } },
    });
    const out = await deleteAccountFromDesktop(TOKEN, d);
    assert.deepEqual(out.ok && out.notices, ["engine-manual"]);
  });

  it("retries a local engine's risk files on the next launch", async () => {
    let riskOk = false;
    const d = fakeDeps({
      clearEngineRiskData: async () => ({ ok: riskOk, remote: false }),
    });
    const out = await deleteAccountFromDesktop(TOKEN, d);
    assert.deepEqual(out.ok && out.notices, ["local-retry"]);
    assert.equal(d.store[0]?.clearRisk, true);
    riskOk = true;
    assert.equal(await retryPendingCleanups(d), 0);
  });

  it("skips the direct SnapTrade step in builds without SnapTrade keys", async () => {
    const d = fakeDeps({ deleteSnaptradeUser: null });
    await deleteAccountFromDesktop(TOKEN, d);
    assert.ok(!d.calls.some((c) => c.startsWith("snaptrade")));
  });

  it("asks for a session when the token names no account", async () => {
    const d = fakeDeps({ accountIdFromToken: () => null });
    assert.deepEqual(await deleteAccountFromDesktop(TOKEN, d), { ok: false, error: "Sign in to continue." });
    assert.deepEqual(d.calls, []);
  });
});
