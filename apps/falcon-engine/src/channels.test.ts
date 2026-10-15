import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The risk registry resolves its root on first use: point it at a scratch dir
// before anything touches it.
process.env.FALCON_RISK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-engine-risk-"));
process.env.FALCON_SCREEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-engine-screen-"));
// A shared watchlist from before the per-user split: archived, never served.
fs.writeFileSync(path.join(process.env.FALCON_SCREEN_DATA_DIR, "watchlist.json"), JSON.stringify({ tickers: ["LEGACY"] }));

const { dispatchChannel } = await import("./channels.js");
const { configureScreenForUsers, deleteUserEngineData } = await import("./user-data.js");
const { getRiskUserHosts } = await import("@meridian/research/risk");
const { STAFF_ENGINE_CHANNELS } = await import("@meridian/research/engine-channels");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

after(() => getRiskUserHosts().stop());

type Body = Record<string, unknown> & { ok: boolean };
async function call(channel: string, userId: string, ...args: unknown[]): Promise<{ status: number; body: Body }> {
  const { status, body } = await dispatchChannel(channel, args, { userId });
  return { status, body: body as Body };
}
async function callAsStaff(channel: string, userId: string, ...args: unknown[]): Promise<{ status: number; body: Body }> {
  const { status, body } = await dispatchChannel(channel, args, { userId, staff: true });
  return { status, body: body as Body };
}

const paper = (ticker: string, cash: number) => ({
  account: "paper",
  cash,
  positions: [{ ticker, shares: 4, cost_usd: 400, market_value: null }],
  as_of: "2026-10-15T14:00:00.000Z",
  // A body cannot pick whose account this is.
  userId: BOB,
  user_id: BOB,
});

const accountOf = (body: Body) => (body.status as { account: { received: boolean; cash: number; positions: number } }).account;

describe("engine risk channels — scoped to the verified user", () => {
  it("two users' paper accounts do not mix", async () => {
    assert.equal((await call("risk:account-update", ALICE, paper("NVDA", 1_000))).body.ok, true);

    // Bob has pushed nothing: he must not see Alice's book.
    const bobBefore = accountOf((await call("risk:status", BOB)).body);
    assert.equal(bobBefore.received, false);

    await call("risk:account-update", BOB, paper("PFE", 50));
    const alice = accountOf((await call("risk:status", ALICE)).body);
    const bob = accountOf((await call("risk:status", BOB)).body);
    assert.equal(alice.cash, 1_000, "Bob's push overwrote Alice's account");
    assert.equal(bob.cash, 50);

    // The body's userId fields were ignored: Bob's dir holds only Bob's push.
    const root = process.env.FALCON_RISK_DATA_DIR as string;
    const bobFile = JSON.parse(fs.readFileSync(path.join(root, "users", BOB, "account.json"), "utf8"));
    assert.equal(bobFile.positions[0].ticker, "PFE");
    assert.equal(fs.existsSync(path.join(root, "account.json")), false);
  });

  it("latest/history read the caller's own snapshots", async () => {
    const latest = (await call("risk:latest", BOB)).body;
    assert.equal(latest.ok, true);
    assert.equal(latest.snapshot, null);
    assert.deepEqual((await call("risk:history", BOB, { limit: 10 })).body.history, []);
  });

  it("risk:delete-user-data erases only the caller's state", async () => {
    const out = (await call("risk:delete-user-data", ALICE, { userId: BOB })).body;
    assert.deepEqual(out, { ok: true, deleted: true, removed: { risk: true, screen: false } });
    assert.equal(accountOf((await call("risk:status", ALICE)).body).received, false);
    assert.equal(accountOf((await call("risk:status", BOB)).body).cash, 50);
  });

  it("refuses a call with no verified user, an unknown channel, and a malformed id", async () => {
    assert.equal((await call("risk:latest", "")).status, 401);
    assert.equal((await call("risk:everything", ALICE)).status, 404);
    await assert.rejects(() => call("risk:latest", "../../etc"), /invalid user id/);
  });
});

describe("engine shared switches — staff only", () => {
  it("refuses every staff-only channel for a non-staff user, before the handler runs", async () => {
    for (const channel of STAFF_ENGINE_CHANNELS) {
      const out = await call(channel, ALICE, true);
      assert.equal(out.status, 403, channel);
      assert.equal(out.body.ok, false);
      assert.equal(out.body.code, "staff_only");
      assert.match(String(out.body.error), /Only Falcon staff/);
    }
    // The card flag did not move.
    const root = process.env.FALCON_RISK_DATA_DIR as string;
    const config = fs.existsSync(path.join(root, "config.json")) ? JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")) : {};
    assert.notEqual(config?.card?.enabled, true);
  });

  it("answers a staff user", async () => {
    const out = await callAsStaff("risk:set-card-enabled", ALICE, false);
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
  });

  it("leaves per-user writes open to every approved user", async () => {
    assert.equal((await call("screen:set-watchlist", BOB, ["PFE"])).status, 200);
    assert.equal((await call("risk:account-update", BOB, paper("PFE", 50))).status, 200);
  });
});

describe("engine screen watchlist — one per verified user", () => {
  const root = () => process.env.FALCON_SCREEN_DATA_DIR as string;

  it("archives the legacy shared watchlist at boot", () => {
    const { archived } = configureScreenForUsers();
    assert.ok(archived);
    assert.equal(fs.existsSync(path.join(root(), "watchlist.json")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archived!, "watchlist.json"), "utf8")).tickers, ["LEGACY"]);
  });

  it("two users' watchlists do not overwrite each other", async () => {
    await call("screen:set-watchlist", ALICE, ["nvda", "AMD"], { userId: BOB });
    await call("screen:set-watchlist", BOB, ["PFE"]);
    const alice = JSON.parse(fs.readFileSync(path.join(root(), "users", ALICE, "watchlist.json"), "utf8"));
    const bob = JSON.parse(fs.readFileSync(path.join(root(), "users", BOB, "watchlist.json"), "utf8"));
    assert.deepEqual(alice.tickers, ["AMD", "NVDA"], "Bob's push overwrote Alice's watchlist");
    assert.deepEqual(bob.tickers, ["PFE"]);
    assert.equal(fs.existsSync(path.join(root(), "watchlist.json")), false);

    const size = (body: Body) => (body.status as { emit: { watchlistSize: number } }).emit.watchlistSize;
    assert.equal(size((await call("screen:status", ALICE)).body), 2);
    assert.equal(size((await call("screen:status", BOB)).body), 1);
  });

  it("a member reads only the emits on their own names; staff read the whole log", async () => {
    const msg = (id: string, ticker: string, timestamp: string) =>
      JSON.stringify({ id, type: "tape_structure", ticker, timestamp, payload: { pattern: "compression" } });
    fs.writeFileSync(
      path.join(root(), "emitted.jsonl"),
      [msg("m1", "NVDA", "2026-10-14T21:00:00.000Z"), msg("m2", "PFE", "2026-10-14T21:00:01.000Z"), msg("m3", "XOM", "2026-10-14T21:00:02.000Z")].join("\n") + "\n",
    );
    const tickers = (body: Body) => (body.messages as { ticker: string }[]).map((m) => m.ticker);
    assert.deepEqual(tickers((await call("screen:emitted", ALICE)).body), ["NVDA"]);
    // Bob holds PFE in his paper book too (pushed earlier); he sees PFE only.
    assert.deepEqual(tickers((await call("screen:emitted", BOB)).body), ["PFE"]);
    assert.deepEqual(tickers((await callAsStaff("screen:emitted", ALICE)).body), ["NVDA", "PFE", "XOM"]);
  });

  it("account deletion removes the caller's watchlist and nobody else's", async () => {
    const out = (await call("risk:delete-user-data", BOB)).body;
    assert.equal(out.ok, true);
    assert.deepEqual(out.removed, { risk: true, screen: true });
    assert.equal(fs.existsSync(path.join(root(), "users", BOB)), false);
    assert.equal(fs.existsSync(path.join(root(), "users", ALICE, "watchlist.json")), true);
    // The service route (worker retry) uses the same function: idempotent.
    assert.deepEqual(deleteUserEngineData(BOB), { risk: false, screen: false });
    assert.equal(deleteUserEngineData(ALICE).screen, true);
    assert.equal(fs.existsSync(path.join(root(), "users", ALICE)), false);
  });
});
