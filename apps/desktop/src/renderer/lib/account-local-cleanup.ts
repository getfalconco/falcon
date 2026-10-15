/**
 * After an account is deleted, the renderer's own storage for it goes too:
 * every key that carries the account id (the paper account, its net-worth
 * history, the one-time prompts: `falcon.<id>.*`, `falcon.ui.heardPrompt.<id>`),
 * the address the waitlist form remembered, and the recent stock searches.
 * Device settings (theme, language, layout, shortcuts) are not the account's
 * and stay. The sign-in session keys are left to Supabase's own sign-out.
 *
 * Pure over a Storage, so a test runs it against a stand-in.
 */

type StorageLike = Pick<Storage, "length" | "key" | "removeItem">;

/** Keys that hold the account's data without carrying its id. */
export const ACCOUNT_OWNED_KEYS: readonly string[] = ["meridian-waitlist-email", "meridian-recent-stock-search"];

/** Session-storage keys of the same kind. */
export const ACCOUNT_OWNED_SESSION_KEYS: readonly string[] = ["meridian-waitlist"];

export function clearAccountStorage(storage: StorageLike | null | undefined, accountId: string, owned: readonly string[] = ACCOUNT_OWNED_KEYS): number {
  const id = accountId.trim().toLowerCase();
  if (!storage || !id) return 0;
  const doomed: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null) continue;
      if (key.toLowerCase().includes(id) || owned.includes(key)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    // Storage refused: nothing more this side can do.
  }
  return doomed.length;
}
