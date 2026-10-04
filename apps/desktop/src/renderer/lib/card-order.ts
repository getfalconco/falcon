/**
 * Which cards the dashboard shows, in what order, kept across launches.
 *
 * A card the reader deletes stays deleted: Add Module is the way back. What
 * a launch may still add by itself is a kind of card the saved arrangement
 * has never been offered, one a later build introduced, so a new module
 * reaches everyone once without bringing back the ones they took off. To
 * tell the two apart, the kinds the arrangement has been offered are saved
 * beside it.
 *
 * Before this, every default card missing from the saved order was put back
 * on the next launch (an empty dashboard was the worry, back when nothing
 * could add a card), which undid every delete. An arrangement saved by that
 * build has no list of offered kinds; it is read as having been offered all
 * of today's, which is true, since every launch of it wrote the full set back.
 */

export const CARD_ORDER_KEY = "falcon.ui.cardOrder.v4";
export const CARD_KINDS_KEY = "falcon.ui.cardKinds.v1";

type Store = Pick<Storage, "getItem" | "setItem">;

/** "calendar#1790416738019" is a copy of a calendar card; its kind is "calendar". */
export function kindOf(id: string): string {
  return id.split("#")[0] ?? id;
}

function readList(store: Store, key: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(store.getItem(key) ?? "null");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

/**
 * The arrangement to draw. Ids of kinds this build does not know are dropped,
 * and so are repeats. A kind never offered to this arrangement is added: the
 * balance card first, where it always stood, anything else at the end.
 */
export function readCardOrder(store: Store, defaults: readonly string[]): string[] {
  const saved = readList(store, CARD_ORDER_KEY);
  if (saved === null) return [...defaults];
  const order = Array.from(new Set(saved.filter((id) => defaults.includes(kindOf(id)))));
  const offered = readList(store, CARD_KINDS_KEY) ?? [...defaults];
  const fresh = defaults.filter((kind) => !offered.includes(kind) && !order.some((id) => kindOf(id) === kind));
  return [...fresh.filter((kind) => kind === "portfolio"), ...order, ...fresh.filter((kind) => kind !== "portfolio")];
}

/** Saves the arrangement, and that every kind this build knows has now been offered to it. */
export function writeCardOrder(store: Store, order: readonly string[], defaults: readonly string[]): void {
  try {
    store.setItem(CARD_ORDER_KEY, JSON.stringify(order));
    const offered = readList(store, CARD_KINDS_KEY) ?? [];
    store.setItem(CARD_KINDS_KEY, JSON.stringify(Array.from(new Set([...offered, ...defaults]))));
  } catch {
    /* a full or blocked store costs the arrangement, not the page */
  }
}
