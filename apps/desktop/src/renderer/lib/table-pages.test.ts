import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAllPages, type FetchPage, type RowKey } from "./table-pages";

/** A table of `n` rows keyed 1..n that returns at most `serverCap` rows a request, like PostgREST's max-rows. */
function table(n: number, serverCap = Infinity) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, value: (i + 1) * 10 }));
  const calls: Array<RowKey | null> = [];
  const fetchPage: FetchPage = async (after, size) => {
    calls.push(after);
    const start = after === null ? 0 : rows.findIndex((r) => r.id > Number(after));
    if (start === -1) return { rows: [] };
    return { rows: rows.slice(start, start + Math.min(size, serverCap)) };
  };
  return { rows, calls, fetchPage };
}

describe("readAllPages", () => {
  it("reads past the old 10,000-row cap, every row once and in order", async () => {
    const t = table(25_000);
    const out = await readAllPages(t.fetchPage, "id");
    assert.ok("rows" in out);
    assert.equal(out.rows.length, 25_000);
    assert.equal(out.note, undefined);
    assert.deepEqual(
      out.rows.map((r) => (r as { id: number }).id),
      t.rows.map((r) => r.id),
    );
    // 25 full pages and the empty one that ends the walk.
    assert.equal(t.calls.length, 26);
  });

  it("keeps going when the server returns fewer rows than asked for", async () => {
    const t = table(2_500, 400);
    const out = await readAllPages(t.fetchPage, "id");
    assert.ok("rows" in out);
    assert.equal(out.rows.length, 2_500);
  });

  it("does not repeat or skip rows inserted while it runs", async () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => ({ id: i + 1 }));
    let requests = 0;
    const fetchPage: FetchPage = async (after, size) => {
      // The engine appends a snapshot between the first few requests.
      if (requests++ < 3) rows.push({ id: rows.length + 1 });
      const start = after === null ? 0 : rows.findIndex((r) => r.id > Number(after));
      return { rows: start === -1 ? [] : rows.slice(start, start + size) };
    };
    const out = await readAllPages(fetchPage, "id", { pageSize: 500 });
    assert.ok("rows" in out);
    const ids = out.rows.map((r) => (r as { id: number }).id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(ids.length, 2_003);
  });

  it("returns the error alone when the first page fails, and the rows so far after that", async () => {
    assert.deepEqual(await readAllPages(async () => ({ error: "permission denied" }), "id"), { error: "permission denied" });
    let n = 0;
    const out = await readAllPages(
      async () => (n++ === 0 ? { rows: [{ id: 1 }, { id: 2 }] } : { error: "timeout" }),
      "id",
      { pageSize: 2 },
    );
    assert.deepEqual(out, { rows: [{ id: 1 }, { id: 2 }], note: "Stopped after 2 rows: timeout" });
  });

  it("stops at the row guard and says so", async () => {
    const t = table(5_000);
    const out = await readAllPages(t.fetchPage, "id", { pageSize: 1_000, maxRows: 3_000 });
    assert.ok("rows" in out);
    assert.equal(out.rows.length, 3_000);
    assert.equal(out.note, "Only the first 3000 rows were exported");
  });

  it("stops when the key column is missing rather than looping", async () => {
    const out = await readAllPages(async () => ({ rows: [{ value: 1 }] }), "id");
    assert.ok("rows" in out);
    assert.equal(out.rows.length, 1);
    assert.match(out.note ?? "", /did not advance/);
  });
});
