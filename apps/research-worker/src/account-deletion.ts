/**
 * Account deletion, server side: everything Falcon holds for an account
 * outside Supabase auth, then the auth user itself.
 *
 * Order, and why:
 *
 *   1. Look up what there is to clean (the SnapTrade user id). If Supabase
 *      cannot answer, stop: deleting the account now could orphan a SnapTrade
 *      user nobody has a record of.
 *   2. Write one cleanup task per item to `account_deletion_tasks` BEFORE
 *      anything is deleted. The rows have no foreign key to auth.users, so
 *      they outlive the account they describe.
 *   3. Run each cleanup inline. Success marks its task done; failure leaves
 *      it pending with a backoff, for `drainDeletionQueue` to retry.
 *   4. If a cleanup failed and step 2 could not record it, stop and keep the
 *      account: the reader can try again, and nothing is orphaned silently.
 *   5. Sign the account out everywhere and delete the auth user (its other
 *      rows go with it through `on delete cascade`). If that fails, pending
 *      tasks for the account are cancelled, since the account still exists.
 *
 * The result says, per item, whether it was removed, had nothing to remove,
 * is queued for retry, or cannot be removed by this service yet, so the
 * clients can tell the reader exactly that.
 *
 * Pure orchestration: every side effect is injected, so the tests run it
 * against fakes (SnapTrade, Supabase, the engine and the queue).
 */

export type CleanupTask = "snaptrade_user" | "engine_risk";

/** done: removed now. none: nothing to remove. queued: failed now, retried later. unavailable: no way to remove it yet. */
export type CleanupStatus = "done" | "none" | "queued" | "unavailable";

export type QueuedTask = {
  id: string;
  userId: string;
  task: CleanupTask;
  payload: Record<string, string>;
  attempts: number;
};

export type PlannedTask = Omit<QueuedTask, "id" | "attempts">;

export interface DeletionQueue {
  /** Records the tasks as pending; throws when they could not be recorded. */
  enqueue(tasks: PlannedTask[]): Promise<QueuedTask[]>;
  complete(id: string): Promise<void>;
  /** One more failed attempt; `giveUp` marks the task failed for good. */
  fail(task: QueuedTask, error: string, nextAttemptAt: Date, giveUp: boolean): Promise<void>;
  /** Pending tasks of an account whose deletion did not go through. */
  cancelPending(userId: string): Promise<void>;
  due(now: Date, limit: number): Promise<QueuedTask[]>;
}

export type AccountDeletionDeps = {
  /** The account's SnapTrade user id, null when it has none. Throws when it cannot tell. */
  snaptradeUserIdFor(userId: string): Promise<string | null>;
  /** Deletes the SnapTrade user (and with it every brokerage connection). */
  deleteSnaptradeUser(snaptradeUserId: string): Promise<"deleted" | "absent">;
  /** Drops the stored SnapTrade secret and broker_links snapshot. */
  removeSnaptradeRows(userId: string): Promise<void>;
  /**
   * The engine's per-user risk data. Null while the engine offers no way to
   * delete one account's data: the item is then reported "unavailable".
   */
  deleteEngineRiskData: ((userId: string) => Promise<void>) | null;
  queue: DeletionQueue;
  signOutEverywhere(userId: string): Promise<void>;
  deleteAuthUser(userId: string): Promise<void>;
  log?: (message: string) => void;
  now?: () => Date;
};

export type AccountDeletionResult =
  | { ok: true; cleanup: { snaptrade: CleanupStatus; engine: CleanupStatus } }
  | { ok: false; stage: "lookup" | "cleanup" | "auth"; error: string };

const MINUTE = 60_000;
export const MAX_ATTEMPTS = 20;

/** 5 min, 10, 20 … capped at a day. `attempts` counts the failures so far, the first being 1. */
export function retryDelayMs(attempts: number): number {
  return Math.min(5 * MINUTE * 2 ** Math.max(0, attempts - 1), 24 * 60 * MINUTE);
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function runTask(task: PlannedTask, deps: AccountDeletionDeps): Promise<void> {
  if (task.task === "snaptrade_user") {
    const id = task.payload.snaptrade_user_id;
    if (!id) throw new Error("snaptrade_user task without an id");
    await deps.deleteSnaptradeUser(id);
    // The auth delete cascades these rows too; removing them here covers a
    // retry that runs after the account is gone and a row that has no FK.
    await deps.removeSnaptradeRows(task.userId);
    return;
  }
  if (task.task === "engine_risk") {
    if (!deps.deleteEngineRiskData) throw new Error("engine risk deletion is not available");
    await deps.deleteEngineRiskData(task.userId);
    return;
  }
  throw new Error(`unknown task ${String(task.task)}`);
}

export async function deleteAccountEverywhere(userId: string, deps: AccountDeletionDeps): Promise<AccountDeletionResult> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const now = deps.now ?? (() => new Date());

  // 1. What is there to clean?
  let snaptradeUserId: string | null;
  try {
    snaptradeUserId = await deps.snaptradeUserIdFor(userId);
  } catch (err) {
    log(`[account-delete] lookup failed: ${message(err)}`);
    return { ok: false, stage: "lookup", error: "Could not reach the account's data. Nothing was deleted." };
  }

  const planned: PlannedTask[] = [];
  if (snaptradeUserId) planned.push({ userId, task: "snaptrade_user", payload: { snaptrade_user_id: snaptradeUserId } });
  if (deps.deleteEngineRiskData) planned.push({ userId, task: "engine_risk", payload: {} });

  // 2. Record before deleting anything.
  let queued: QueuedTask[] | null = null;
  if (planned.length > 0) {
    try {
      queued = await deps.queue.enqueue(planned);
    } catch (err) {
      log(`[account-delete] could not record cleanup tasks: ${message(err)}`);
    }
  }

  // 3. Try each cleanup now.
  const status: Record<CleanupTask, CleanupStatus> = {
    snaptrade_user: snaptradeUserId ? "done" : "none",
    engine_risk: deps.deleteEngineRiskData ? "done" : "unavailable",
  };
  let unrecordedFailure = false;
  for (const task of planned) {
    const record = queued?.find((q) => q.task === task.task) ?? null;
    try {
      await runTask(task, deps);
      if (record) await deps.queue.complete(record.id).catch((err) => log(`[account-delete] complete failed: ${message(err)}`));
    } catch (err) {
      log(`[account-delete] ${task.task} failed, will retry: ${message(err)}`);
      status[task.task] = "queued";
      if (record) {
        await deps.queue
          .fail(record, message(err), new Date(now().getTime() + retryDelayMs(1)), false)
          .catch((e) => log(`[account-delete] recording a failure failed: ${message(e)}`));
      } else {
        unrecordedFailure = true;
      }
    }
  }

  // 4. A failure with no record would orphan data: keep the account.
  if (unrecordedFailure) {
    return {
      ok: false,
      stage: "cleanup",
      error: "Falcon could not remove your brokerage link or engine data and could not schedule a retry. Your account was not deleted. Try again later.",
    };
  }

  // 5. The auth user, last.
  await deps.signOutEverywhere(userId).catch((err) => log(`[account-delete] sign-out failed: ${message(err)}`));
  try {
    await deps.deleteAuthUser(userId);
  } catch (err) {
    log(`[account-delete] auth delete failed: ${message(err)}`);
    if (queued) await deps.queue.cancelPending(userId).catch((e) => log(`[account-delete] cancel failed: ${message(e)}`));
    return { ok: false, stage: "auth", error: "Could not delete the account." };
  }

  return { ok: true, cleanup: { snaptrade: status.snaptrade_user, engine: status.engine_risk } };
}

/**
 * Retries due cleanup tasks. Each failure pushes the next attempt further
 * out; after MAX_ATTEMPTS the task is marked failed and logged for a person
 * to look at. Returns how many tasks it ran and how many of them succeeded.
 */
export async function drainDeletionQueue(
  deps: AccountDeletionDeps,
  opts: { limit?: number; maxAttempts?: number } = {},
): Promise<{ ran: number; done: number }> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const now = deps.now ?? (() => new Date());
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const tasks = await deps.queue.due(now(), opts.limit ?? 25);
  let done = 0;
  for (const task of tasks) {
    try {
      await runTask(task, deps);
      await deps.queue.complete(task.id);
      done += 1;
    } catch (err) {
      const attempts = task.attempts + 1;
      const giveUp = attempts >= maxAttempts;
      if (giveUp) log(`[account-delete] task ${task.id} (${task.task}) gave up after ${attempts} attempts: ${message(err)}`);
      await deps.queue
        .fail(task, message(err), new Date(now().getTime() + retryDelayMs(attempts)), giveUp)
        .catch((e) => log(`[account-delete] recording a failure failed: ${message(e)}`));
    }
  }
  return { ran: tasks.length, done };
}
