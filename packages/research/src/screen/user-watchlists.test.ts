import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ScreenUserWatchlists, deleteUserScreenData, normalizeWatchlist } from "./user-watchlists.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const fresh = () => new ScreenUserWatchlists(fs.mkdtempSync(path.join(os.tmpdir(), "falcon-screen-users-")));

describe("ScreenUserWatchlists — one watchlist per verified user", () => {
  it("keeps two users' watchlists apart", () => {
    const lists = fresh();
    lists.set(ALICE, ["nvda", " amd ", "NVDA"]);
    lists.set(BOB, ["PFE"]);
    assert.deepEqual(lists.get(ALICE), ["AMD", "NVDA"]);
    assert.deepEqual(lists.get(BOB), ["PFE"]);
    // Bob's push did not touch Alice's file, and nothing shared was written.
    const aliceFile = JSON.parse(fs.readFileSync(path.join(lists.usersDir, ALICE, "watchlist.json"), "utf8"));
    assert.deepEqual(aliceFile.tickers, ["AMD", "NVDA"]);
    assert.equal(fs.existsSync(path.join(lists.rootDir, "watchlist.json")), false);
    assert.deepEqual(lists.union(), ["AMD", "NVDA", "PFE"]);
  });

  it("reads an empty list for a user who never pushed one", () => {
    assert.deepEqual(fresh().get(BOB), []);
  });

  it("refuses an id that is not a user id (it becomes a path segment)", () => {
    const lists = fresh();
    assert.throws(() => lists.set("../../etc", ["X"]), /invalid user id/);
    assert.throws(() => lists.get("../alice"), /invalid user id/);
    assert.throws(() => deleteUserScreenData("not-a-uuid", lists), /invalid user id/);
  });

  it("archives the pre-split shared watchlist instead of deleting it, once", () => {
    const lists = fresh();
    fs.mkdirSync(lists.rootDir, { recursive: true });
    fs.writeFileSync(path.join(lists.rootDir, "watchlist.json"), JSON.stringify({ tickers: ["TSLA"] }));
    const target = lists.archiveLegacySharedWatchlist(new Date("2026-10-15T12:00:00.000Z"));
    assert.ok(target);
    assert.equal(fs.existsSync(path.join(lists.rootDir, "watchlist.json")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target!, "watchlist.json"), "utf8")).tickers, ["TSLA"]);
    assert.equal(lists.archiveLegacySharedWatchlist(), null);
    // The archived list is nobody's: it is not in the union.
    assert.deepEqual(lists.union(), []);
  });

  it("deletes only the given user's watchlist, idempotently", () => {
    const lists = fresh();
    lists.set(ALICE, ["NVDA"]);
    lists.set(BOB, ["PFE"]);
    assert.equal(deleteUserScreenData(ALICE, lists).deleted, true);
    assert.deepEqual(lists.get(ALICE), []);
    assert.deepEqual(lists.get(BOB), ["PFE"]);
    assert.equal(deleteUserScreenData(ALICE, lists).deleted, false);
  });

  it("normalizes and bounds what it stores", () => {
    assert.deepEqual(normalizeWatchlist(["b", "a", 3, null, "", "A"]), ["A", "B"]);
    assert.equal(normalizeWatchlist(Array.from({ length: 900 }, (_, i) => `T${i}`)).length, 500);
  });
});
