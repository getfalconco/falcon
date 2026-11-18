// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/portfolio-store.test.ts
// The store's merge rules and the missing-table fallback, against a stand-in Supabase client (nothing leaves the machine).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanImport } from "./portfolio-holdings";
import { paperAccount } from "./paper-account";
import { brokerAccountId, clearPaperAccount, clearPortfolio, isMissingTable, prunePositions, readPortfolio, readSnapshots, recordSnapshot, saveImport, savePaperAccount } from "./portfolio-store";

type Call = { table: string; op: string; args: unknown[] };

/** A chainable stand-in: records every call; `answer` decides what each finished query returns. */
function fakeDb(answer: (table: string, ops: Call[]) => { data?: unknown; error?: { code?: string; message?: string } | null } = () => ({})) {
  const calls: Call[][] = [];
  const db = {
    from(table: string) {
      const ops: Call[] = [];
      calls.push(ops);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "limit", "delete", "in", "not", "upsert", "insert", "maybeSingle", "order"]) {
        chain[op] = (...args: unknown[]) => {
          ops.push({ table, op, args });
          return chain;
        };
      }
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null, ...answer(table, ops) });
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const B = brokerAccountId("user-1", "snap-acc-1");

test("broker account ids are a one-way code of user and SnapTrade account, never the raw id", () => {
  assert.match(B, /^b_[0-9a-f]{24}$/);
  assert.notEqual(B, brokerAccountId("user-2", "snap-acc-1"), "the same SnapTrade account under another member is another id");
  assert.ok(!B.includes("snap"));
});

test("a broker import replaces that account's positions; a screenshot merges and keeps balances it did not show", async () => {
  const broker = cleanImport({ source: "broker", accounts: [{ id: B, cash: 10 }], positions: [{ accountId: B, kind: "stock", symbol: "AAPL", quantity: 1 }, { accountId: B, kind: "crypto", symbol: "BTC", quantity: 1 }] });
  assert.ok(broker.ok);
  const { db, calls } = fakeDb((table, ops) => (table === "onboarding_responses" && ops[0]?.op === "select" ? { data: { watchlist: ["MSFT"] } } : {}));
  const saved = await saveImport("user-1", broker.value, db);
  assert.deepEqual(saved, { available: true, accounts: 1, positions: 2, tickers: ["AAPL"] });
  const ops = calls.map((c) => `${c[0]!.table}.${c.map((x) => x.op).join(".")}`);
  assert.deepEqual(ops, [
    "portfolio_accounts.upsert",
    "portfolio_positions.delete.eq.in",
    "portfolio_positions.upsert",
    "onboarding_responses.select.eq.maybeSingle",
    "onboarding_responses.upsert",
    // The snapshot of the holdings after the change (the Equity chart's history).
    "portfolio_accounts.select.eq.limit",
    "portfolio_positions.select.eq.limit",
    "portfolio_holdings_history.select.eq.order.limit",
    "portfolio_holdings_history.insert",
  ]);
  assert.deepEqual(calls[1]![2]!.args, ["account_id", [B]], "only the accounts this import returned");
  assert.deepEqual((calls[4]![0]!.args[0] as { watchlist: string[] }).watchlist, ["MSFT", "AAPL"], "tickers added, never removed; crypto not added");

  const shot = cleanImport({ source: "screenshot", accounts: [{ id: "screenshot", cash: null, totalValue: 5000 }], positions: [{ accountId: "screenshot", kind: "stock", symbol: "NVDA", quantity: 2 }] });
  assert.ok(shot.ok);
  const s = fakeDb();
  await saveImport("user-1", shot.value, s.db);
  assert.ok(!s.calls.some((c) => c.some((x) => x.op === "delete")), "a screenshot never deletes rows");
  const row = s.calls[0]![0]!.args[0] as Record<string, unknown>[];
  assert.equal(row[0]!.total_value, 5000);
  assert.ok(!("cash" in row[0]!), "a balance the screenshot did not show is left as stored");
});

test("while the tables are missing nothing is saved and reads say so", async () => {
  const missing = fakeDb(() => ({ error: { code: "PGRST205", message: "Could not find the table" } }));
  const imp = cleanImport({ source: "csv", accounts: [{ id: "csv" }], positions: [{ accountId: "csv", kind: "stock", symbol: "AAPL", quantity: 1 }] });
  assert.ok(imp.ok);
  assert.deepEqual(await saveImport("u", imp.value, missing.db), { available: false });
  assert.deepEqual(await readPortfolio("u", missing.db), { available: false, accounts: [], positions: [] });
  assert.deepEqual(await clearPortfolio("u", missing.db), { available: false });
  assert.deepEqual(await savePaperAccount("u", paperAccount(5000, null)!, missing.db), { available: false });
  assert.equal(isMissingTable({ code: "42P01" }), true);
  assert.equal(isMissingTable({ code: "23505" }), false);
});

test("Clear paper portfolio deletes only the paper account; prune keeps rows without a ticker", async () => {
  const { db, calls } = fakeDb();
  await clearPaperAccount("user-1", db);
  assert.deepEqual(calls[0]!.map((c) => [c.op, ...c.args]), [["delete"], ["eq", "user_id", "user-1"], ["eq", "id", "paper"]]);

  const p = fakeDb();
  await prunePositions("user-1", ["AAPL", "BRK.B"], p.db);
  assert.deepEqual(p.calls[0]!.map((c) => [c.op, ...c.args]), [
    ["delete"],
    ["eq", "user_id", "user-1"],
    ["not", "ticker", "is", null],
    ["not", "ticker", "in", '("AAPL","BRK.B")'],
  ]);
  const empty = fakeDb();
  await prunePositions("user-1", [], empty.db);
  assert.equal(empty.calls[0]!.length, 3, "an empty list removes every row with a ticker (crypto and others stay)");
});

test("holdings history: the full holdings after a change, skipped when nothing changed, nothing while the table is missing", async () => {
  const AT = "2026-11-17T15:00:00.000Z";
  const accountRow = { id: "csv", source: "csv", name: null, institution: null, number_last4: null, currency: "USD", total_value: null, cash: 2500, buying_power: null, holdings_unavailable: false, as_of: AT, updated_at: AT };
  const positionRow = { account_id: "csv", kind: "stock", symbol: "AAPL", ticker: "AAPL", name: "Apple", quantity: 10, avg_cost: 150, price: 200, market_value: null, unrealized_pnl: null, currency: "USD", option_type: null, strike: null, expiry: null, multiplier: null, as_of: AT };
  const stored = { effective_at: AT, source: "csv", positions: [{ account_id: "csv", kind: "stock", symbol: "AAPL", ticker: "AAPL", quantity: 10, multiplier: 1, currency: "USD", price: 190 }], cash: [{ account_id: "csv", currency: "USD", cash: 2500 }] };
  const answer = (latest: unknown[]) => (table: string, ops: { op: string }[]) =>
    table === "portfolio_accounts" ? { data: [accountRow] } : table === "portfolio_positions" ? { data: [positionRow] } : ops.some((o) => o.op === "insert") ? {} : { data: latest };

  const same = fakeDb(answer([stored]));
  assert.equal(await recordSnapshot("u", "csv", same.db), null, "the same holdings (a new price alone is no change): no row");
  assert.ok(!same.calls.some((c) => c.some((x) => x.op === "insert")));

  const changed = fakeDb(answer([{ ...stored, cash: [{ account_id: "csv", currency: "USD", cash: 3000 }] }]));
  const written = await recordSnapshot("u", "csv", changed.db);
  assert.ok(written);
  const insert = changed.calls.find((c) => c.some((x) => x.op === "insert"))!;
  const row = insert.find((x) => x.op === "insert")!.args[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), ["cash", "effective_at", "positions", "source", "user_id"], "no names, costs or values");
  assert.deepEqual(row.positions, [{ account_id: "csv", kind: "stock", symbol: "AAPL", ticker: "AAPL", quantity: 10, multiplier: 1, currency: "USD", price: 200 }]);
  assert.deepEqual(row.cash, [{ account_id: "csv", currency: "USD", cash: 2500 }]);

  const first = fakeDb(answer([]));
  assert.equal((await recordSnapshot("u", "initial", first.db))?.source, "initial", "a member with holdings and no history: the first row");
  const nothing = fakeDb((table) => (table === "portfolio_holdings_history" ? { data: [] } : { data: [] }));
  assert.equal(await recordSnapshot("u", "initial", nothing.db), null, "nothing held: no first row");

  const missing = fakeDb((table) => (table === "portfolio_holdings_history" ? { error: { code: "PGRST205", message: "Could not find the table" } } : table === "portfolio_accounts" ? { data: [accountRow] } : { data: [positionRow] }));
  assert.equal(await recordSnapshot("u", "csv", missing.db), null);
  assert.deepEqual(await readSnapshots("u", missing.db), []);
  const read = fakeDb(() => ({ data: [stored, { effective_at: "nope", source: "csv", positions: [], cash: [] }] }));
  assert.deepEqual((await readSnapshots("u", read.db)).map((x) => [x.at, x.positions.length]), [[Date.parse(AT), 1]], "unreadable rows are dropped");
});
