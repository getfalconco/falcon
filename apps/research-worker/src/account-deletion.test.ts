import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deleteAccountEverywhere,
  drainDeletionQueue,
  retryDelayMs,
  type AccountDeletionDeps,
  type DeletionQueue,
  type PlannedTask,
  type QueuedTask,
} from "./account-deletion.js";

const USER = "7a1c2e9e-5b2f-4d9c-9f1e-1234567890ab";
const NOW = new Date("2026-10-15T12:00:00.000Z");

type Row = QueuedTask & { status: "pending" | "done" | "failed" | "cancelled"; nextAttemptAt: Date; lastError: string | null };

/** An in-memory queue with the same contract as the Supabase one. */
function memoryQueue(opts: { failEnqueue?: boolean } = {}) {
  const rows: Row[] = [];
  let seq = 0;
  const queue: DeletionQueue = {
    async enqueue(tasks: PlannedTask[]) {
      if (opts.failEnqueue) throw new Error("table missing");
      return tasks.map((t) => {
        const row: Row = { ...t, id: `t${++seq}`, attempts: 0, status: "pending", nextAttemptAt: NOW, lastError: null };
        rows.push(row);
        return { id: row.id, userId: row.userId, task: row.task, payload: row.payload, attempts: 0 };
      });
    },
    async complete(id) {
      rows.find((r) => r.id === id)!.status = "done";
    },
    async fail(task, error, next, giveUp) {
      const row = rows.find((r) => r.id === task.id)!;
      row.attempts = task.attempts + 1;
      row.lastError = error;
      row.nextAttemptAt = next;
      row.status = giveUp ? "failed" : "pending";
    },
    async cancelPending(userId) {
      for (const r of rows) if (r.userId === userId && r.status === "pending") r.status = "cancelled";
    },
    async due(now, limit) {
      return rows
        .filter((r) => r.status === "pending" && r.nextAttemptAt.getTime() <= now.getTime())
        .slice(0, limit)
        .map((r) => ({ id: r.id, userId: r.userId, task: r.task, payload: r.payload, attempts: r.attempts }));
    },
  };
  return { queue, rows };
}

type Calls = string[];

function deps(overrides: Partial<AccountDeletionDeps> & { calls?: Calls } = {}): AccountDeletionDeps & { calls: Calls } {
  const calls = overrides.calls ?? [];
  const base: AccountDeletionDeps = {
    snaptradeUserIdFor: async () => `falcon-${USER}`,
    deleteSnaptradeUser: async (id) => {
      calls.push(`snaptrade:${id}`);
      return "deleted";
    },
    removeSnaptradeRows: async (id) => {
      calls.push(`rows:${id}`);
    },
    deleteEngineRiskData: async (id) => {
      calls.push(`engine:${id}`);
    },
    queue: memoryQueue().queue,
    signOutEverywhere: async (id) => {
      calls.push(`signout:${id}`);
    },
    deleteAuthUser: async (id) => {
      calls.push(`auth:${id}`);
    },
    log: () => {},
    now: () => NOW,
  };
  return { ...base, ...overrides, calls };
}

describe("deleteAccountEverywhere", () => {
  it("removes SnapTrade, the stored rows and engine data before the auth user", async () => {
    const q = memoryQueue();
    const d = deps({ queue: q.queue });
    const result = await deleteAccountEverywhere(USER, d);
    assert.deepEqual(result, { ok: true, cleanup: { snaptrade: "done", engine: "done" } });
    assert.deepEqual(d.calls, [`snaptrade:falcon-${USER}`, `rows:${USER}`, `engine:${USER}`, `signout:${USER}`, `auth:${USER}`]);
    assert.deepEqual(q.rows.map((r) => r.status), ["done", "done"]);
  });

  it("records the cleanups before running any of them", async () => {
    const order: string[] = [];
    const q = memoryQueue();
    const queue: DeletionQueue = {
      ...q.queue,
      enqueue: async (t) => {
        order.push("enqueue");
        return q.queue.enqueue(t);
      },
    };
    const d = deps({
      queue,
      deleteSnaptradeUser: async () => {
        order.push("snaptrade");
        return "deleted";
      },
    });
    await deleteAccountEverywhere(USER, d);
    assert.deepEqual(order, ["enqueue", "snaptrade"]);
  });

  it("deletes the account and queues a retry when SnapTrade is down", async () => {
    const q = memoryQueue();
    const d = deps({
      queue: q.queue,
      deleteSnaptradeUser: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const result = await deleteAccountEverywhere(USER, d);
    assert.deepEqual(result, { ok: true, cleanup: { snaptrade: "queued", engine: "done" } });
    assert.ok(d.calls.includes(`auth:${USER}`));
    const snap = q.rows.find((r) => r.task === "snaptrade_user")!;
    assert.equal(snap.status, "pending");
    assert.equal(snap.attempts, 1);
    assert.equal(snap.payload.snaptrade_user_id, `falcon-${USER}`);
    assert.equal(snap.nextAttemptAt.getTime(), NOW.getTime() + retryDelayMs(1));
  });

  it("keeps the account when a cleanup fails and no retry could be recorded", async () => {
    const d = deps({
      queue: memoryQueue({ failEnqueue: true }).queue,
      deleteSnaptradeUser: async () => {
        throw new Error("503");
      },
    });
    const result = await deleteAccountEverywhere(USER, d);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.stage, "cleanup");
    assert.ok(!d.calls.some((c) => c.startsWith("auth:")));
  });

  it("still deletes when the queue is down but every cleanup succeeded", async () => {
    const d = deps({ queue: memoryQueue({ failEnqueue: true }).queue });
    const result = await deleteAccountEverywhere(USER, d);
    assert.deepEqual(result, { ok: true, cleanup: { snaptrade: "done", engine: "done" } });
  });

  it("stops before deleting anything when the lookup fails", async () => {
    const d = deps({
      snaptradeUserIdFor: async () => {
        throw new Error("supabase 500");
      },
    });
    const result = await deleteAccountEverywhere(USER, d);
    assert.equal(result.ok === false && result.stage, "lookup");
    assert.deepEqual(d.calls, []);
  });

  it("reports nothing to remove for an account that never linked a brokerage", async () => {
    const q = memoryQueue();
    const d = deps({ queue: q.queue, snaptradeUserIdFor: async () => null });
    const result = await deleteAccountEverywhere(USER, d);
    assert.deepEqual(result, { ok: true, cleanup: { snaptrade: "none", engine: "done" } });
    assert.ok(!d.calls.some((c) => c.startsWith("snaptrade:")));
  });

  it("says the engine data is unavailable while the engine offers no per-user delete", async () => {
    const q = memoryQueue();
    const d = deps({ queue: q.queue, deleteEngineRiskData: null });
    const result = await deleteAccountEverywhere(USER, d);
    assert.deepEqual(result, { ok: true, cleanup: { snaptrade: "done", engine: "unavailable" } });
    assert.deepEqual(q.rows.map((r) => r.task), ["snaptrade_user"]);
  });

  it("cancels pending retries when the auth delete itself fails", async () => {
    const q = memoryQueue();
    const d = deps({
      queue: q.queue,
      deleteEngineRiskData: async () => {
        throw new Error("engine down");
      },
      deleteAuthUser: async () => {
        throw new Error("500");
      },
    });
    const result = await deleteAccountEverywhere(USER, d);
    assert.equal(result.ok === false && result.stage, "auth");
    assert.equal(q.rows.find((r) => r.task === "engine_risk")!.status, "cancelled");
  });
});

describe("drainDeletionQueue", () => {
  it("retries a queued SnapTrade delete once it is due, then marks it done", async () => {
    const q = memoryQueue();
    let snaptradeUp = false;
    const calls: Calls = [];
    let clock = NOW;
    const d = deps({
      calls,
      queue: q.queue,
      now: () => clock,
      deleteSnaptradeUser: async (id) => {
        if (!snaptradeUp) throw new Error("down");
        calls.push(`snaptrade:${id}`);
        return "absent";
      },
    });
    await deleteAccountEverywhere(USER, d);

    // Not due yet: nothing runs.
    assert.deepEqual(await drainDeletionQueue(d), { ran: 0, done: 0 });

    clock = new Date(NOW.getTime() + retryDelayMs(1));
    snaptradeUp = true;
    assert.deepEqual(await drainDeletionQueue(d), { ran: 1, done: 1 });
    assert.equal(q.rows.find((r) => r.task === "snaptrade_user")!.status, "done");
    assert.ok(calls.includes(`snaptrade:falcon-${USER}`));
    assert.ok(calls.includes(`rows:${USER}`));
  });

  it("backs off on each failure and gives up after the last attempt", async () => {
    const q = memoryQueue();
    let clock = NOW;
    const d = deps({
      queue: q.queue,
      now: () => clock,
      deleteSnaptradeUser: async () => {
        throw new Error("still down");
      },
    });
    await deleteAccountEverywhere(USER, d);
    const row = q.rows.find((r) => r.task === "snaptrade_user")!;
    for (let i = 0; i < 2; i++) {
      clock = row.nextAttemptAt;
      await drainDeletionQueue(d, { maxAttempts: 3 });
    }
    assert.equal(row.attempts, 3);
    assert.equal(row.status, "failed");
    assert.ok(retryDelayMs(2) > retryDelayMs(1));
    assert.equal(retryDelayMs(50), 24 * 60 * 60_000);
  });
});

import { engineRiskDeleter } from "./engine-risk-cleanup.js";

describe("engineRiskDeleter", () => {
  const TOKEN = "x".repeat(40);

  it("is unavailable without the engine URL or a long enough service token", () => {
    assert.equal(engineRiskDeleter({ url: undefined, token: TOKEN }), null);
    assert.equal(engineRiskDeleter({ url: "https://engine.example", token: "short" }), null);
  });

  it("posts the user id with the service token, and throws on a non-2xx so the queue retries", async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    let status = 200;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ ok: status < 300 }), { status });
    }) as typeof fetch;
    const del = engineRiskDeleter({ url: "https://engine.example/", token: TOKEN }, fetchFn)!;
    await del(USER);
    assert.deepEqual(seen[0], { url: "https://engine.example/service/delete-user-data", auth: `Bearer ${TOKEN}`, body: { userId: USER } });
    status = 503;
    await assert.rejects(() => del(USER), /503/);
  });
});
