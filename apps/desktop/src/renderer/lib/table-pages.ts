import type { CloudTableExport } from "../../shared/privacy-types";

/**
 * Reads every row of one account's table, a page at a time, for the data
 * export. Supabase caps how many rows one request returns (1,000 on a default
 * project, whatever `limit` asks for), and the net-worth series grows by a row
 * every few seconds, so one request is never the whole table.
 *
 * Pages are keyed on a unique, never-null column (the table's primary key),
 * not on offsets: rows the engine inserts while the export runs would shift
 * an offset and repeat or skip rows, but they cannot move a key already read.
 * The walk ends on an empty page rather than a short one, so a server cap
 * smaller than the page size is still read to the end.
 *
 * No Supabase import: the caller hands in one page fetch, so tests drive it.
 */

export type RowKey = string | number;

export type PageResult = { rows: Array<Record<string, unknown>> } | { error: string };

/** One page of rows whose key is greater than `after` (from the start when null), ascending by key. */
export type FetchPage = (after: RowKey | null, size: number) => Promise<PageResult>;

export const PAGE_SIZE = 1_000;

/**
 * A guard against a walk that never ends and a file too large to write: about
 * eight weeks of the net-worth series at one snapshot every five seconds.
 * Reaching it is said in the export, never silent.
 */
export const MAX_EXPORT_ROWS = 1_000_000;

export async function readAllPages(
  fetchPage: FetchPage,
  key: string,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<CloudTableExport> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const maxRows = opts.maxRows ?? MAX_EXPORT_ROWS;
  const rows: Array<Record<string, unknown>> = [];
  let after: RowKey | null = null;

  for (;;) {
    let page: PageResult;
    try {
      page = await fetchPage(after, pageSize);
    } catch (err) {
      page = { error: err instanceof Error ? err.message : String(err) };
    }
    if ("error" in page) {
      return rows.length === 0 ? { error: page.error } : { rows, note: `Stopped after ${rows.length} rows: ${page.error}` };
    }
    if (page.rows.length === 0) return { rows };

    rows.push(...page.rows);
    const last = page.rows[page.rows.length - 1]![key];
    if ((typeof last !== "string" && typeof last !== "number") || last === after) {
      return { rows, note: `Stopped after ${rows.length} rows: the "${key}" column did not advance` };
    }
    if (rows.length >= maxRows) {
      return { rows: rows.slice(0, maxRows), note: `Only the first ${maxRows} rows were exported` };
    }
    after = last;
  }
}
