import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BudgetError, DatabentoClient, type HttpFn, type HttpResponseLike } from "../src/options/client.ts";
import { SpendGuard, canonicalTime, parseLedger, requestKey, type RangeRequest } from "../src/options/cost.ts";

const zstd = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-databento-"));
}

function response(status: number, body: string | Buffer, headers: Record<string, string> = {}): HttpResponseLike {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}

const RECORDS = [
  { hd: { ts_event: "2026-11-13T00:00:00.000000000Z", rtype: 35, publisher_id: 31, instrument_id: 1 }, open: "1.0", high: "1.2", low: "0.9", close: "1.1", volume: "7", symbol: "X" },
  { hd: { ts_event: "2026-11-13T00:00:00.000000000Z", rtype: 35, publisher_id: 32, instrument_id: 1 }, open: "1.0", high: "1.2", low: "0.9", close: "1.1", volume: "3", symbol: "X" },
];

/** Fake Databento: prices every request at `price`, serves RECORDS, counts calls. */
function fakeHttp(price: number, opts: { failRange?: number; status?: number } = {}) {
  const calls: Array<{ url: string; body?: string; auth: string }> = [];
  let rangeFails = opts.failRange ?? 0;
  const http: HttpFn = async (url, init) => {
    calls.push({ url, body: init.body, auth: init.headers.Authorization ?? "" });
    if (url.includes("metadata.get_cost")) return response(200, JSON.stringify(price));
    if (url.includes("timeseries.get_range")) {
      if (rangeFails > 0) {
        rangeFails--;
        return response(opts.status ?? 422, '{"detail":"bad"}');
      }
      return response(200, zstd(Buffer.from(RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n")));
    }
    return response(404, "nope");
  };
  return { http, calls };
}

const REQ: RangeRequest = { dataset: "OPRA.PILLAR", schema: "ohlcv-1d", symbols: ["KLAC.OPT"], start: "2026-11-13", end: "2026-11-14", stype_in: "parent" };
const noSleep = async () => {};

describe("request keys", () => {
  it("are stable under symbol order and equivalent time spellings", () => {
    const a = requestKey({ ...REQ, symbols: ["A", "B"] });
    assert.equal(a, requestKey({ ...REQ, symbols: ["B", "A"] }));
    assert.equal(requestKey(REQ), requestKey({ ...REQ, start: "2026-11-13T00:00:00Z", end: "2026-11-14T00:00:00.000Z" }));
    assert.notEqual(requestKey(REQ), requestKey({ ...REQ, schema: "trades" }));
    assert.notEqual(requestKey(REQ), requestKey({ ...REQ, limit: 10 }));
    assert.equal(canonicalTime("2026-11-13T15:45:00-05:00"), "2026-11-13T20:45:00.000Z");
  });
});

describe("cost guard", () => {
  it("dry run prices only: no ledger line, no data pull", async () => {
    const dir = tmpDir();
    const { http, calls } = fakeHttp(0.25);
    const c = new DatabentoClient({ dir, http, apiKey: "db-test", totalBudgetUsd: 10, sleep: noSleep });
    const res = await c.getRange(REQ, { caller: "t", maxCallUsd: 1, dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(res.pricedUsd, 0.25);
    assert.equal(res.costUsd, 0);
    assert.equal(res.records.length, 0);
    assert.equal(c.guard.entries().length, 0);
    assert.equal(calls.filter((x) => x.url.includes("get_range")).length, 0);
  });

  it("a paid pull writes one ledger line, parses records, and is served from cache the second time", async () => {
    const dir = tmpDir();
    const { http, calls } = fakeHttp(0.25);
    const c = new DatabentoClient({ dir, http, apiKey: "db-test", totalBudgetUsd: 10, sleep: noSleep });
    const r1 = await c.getRange(REQ, { caller: "h4", maxCallUsd: 1 });
    assert.equal(r1.cached, false);
    assert.equal(r1.costUsd, 0.25);
    assert.equal(r1.records.length, 2);
    const ledger = parseLedger(fs.readFileSync(path.join(dir, "spend.ndjson"), "utf8"));
    assert.equal(ledger.length, 1);
    const e = ledger[0]!;
    assert.equal(e.kind, "charge");
    assert.equal(e.caller, "h4");
    assert.equal(e.dataset, "OPRA.PILLAR");
    assert.equal(e.schema, "ohlcv-1d");
    assert.deepEqual(e.symbols, { count: 1, first: ["KLAC.OPT"] });
    assert.equal(e.start, "2026-11-13");
    assert.equal(e.end, "2026-11-14");
    assert.equal(e.costUsd, 0.25);
    assert.ok(Date.parse(e.at) > 0);

    const n = calls.length;
    const r2 = await c.getRange({ ...REQ, start: "2026-11-13T00:00:00Z" }, { caller: "h4", maxCallUsd: 1 });
    assert.equal(r2.cached, true);
    assert.equal(r2.costUsd, 0);
    assert.deepEqual(r2.records, r1.records);
    assert.equal(calls.length, n, "a cache hit makes no HTTP call, not even get_cost");
    assert.equal(c.guard.spentUsd(), 0.25);

    // A second client on the same directory (another agent) sees the cache too.
    const other = new DatabentoClient({ dir, http, apiKey: "db-test", totalBudgetUsd: 10, sleep: noSleep });
    assert.equal((await other.getRange(REQ, { caller: "h6", maxCallUsd: 1 })).cached, true);
  });

  it("sends Basic auth with the key as user name and form params; never puts the key in errors", async () => {
    const dir = tmpDir();
    const { http, calls } = fakeHttp(0.01, { failRange: 1 });
    const c = new DatabentoClient({ dir, http, apiKey: "db-SECRET", totalBudgetUsd: 10, sleep: noSleep });
    await assert.rejects(
      () => c.getRange(REQ, { caller: "t", maxCallUsd: 1 }),
      (err: Error) => !err.message.includes("db-SECRET") && /422/.test(err.message),
    );
    const call = calls.find((x) => x.url.includes("get_range"))!;
    assert.equal(call.auth, `Basic ${Buffer.from("db-SECRET:").toString("base64")}`);
    const form = new URLSearchParams(call.body);
    assert.equal(form.get("encoding"), "json");
    assert.equal(form.get("stype_in"), "parent");
    assert.equal(form.get("symbols"), "KLAC.OPT");
    assert.equal(form.get("map_symbols"), "true");
  });

  it("refuses a pull over the per-call cap before any ledger write or data call", async () => {
    const dir = tmpDir();
    const { http, calls } = fakeHttp(2.5);
    const c = new DatabentoClient({ dir, http, apiKey: "db-test", totalBudgetUsd: 10, sleep: noSleep });
    await assert.rejects(() => c.getRange(REQ, { caller: "t", maxCallUsd: 1 }), (err: unknown) => err instanceof BudgetError && err.reason === "per_call");
    assert.equal(c.guard.entries().length, 0);
    assert.equal(calls.filter((x) => x.url.includes("get_range")).length, 0);
  });

  it("refuses a pull that takes the caller past its cap, counting only that caller's lines", async () => {
    const dir = tmpDir();
    const { http } = fakeHttp(0.4);
    const c = new DatabentoClient({ dir, http, apiKey: "db-test", totalBudgetUsd: 10, sleep: noSleep });
    await c.getRange({ ...REQ, start: "2026-11-10", end: "2026-11-11" }, { caller: "a", maxCallUsd: 1, maxCallerUsd: 1 });
    await c.getRange({ ...REQ, start: "2026-11-11", end: "2026-11-12" }, { caller: "a", maxCallUsd: 1, maxCallerUsd: 1 });
    await assert.rejects(
      () => c.getRange({ ...REQ, start: "2026-11-12", end: "2026-11-13" }, { caller: "a", maxCallUsd: 1, maxCallerUsd: 1 }),
      (err: unknown) => err instanceof BudgetError && err.reason === "per_caller",
    );
    // Another caller still has room.
    await c.getRange({ ...REQ, start: "2026-11-12", end: "2026-11-13" }, { caller: "b", maxCallUsd: 1, maxCallerUsd: 1 });
    assert.equal(c.guard.spentUsd("a").toFixed(2), "0.80");
    assert.equal(c.guard.spentUsd("b").toFixed(2), "0.40");
  });

  it("refuses a pull that takes the total past the budget (env-style override)", async () => {
    const dir = tmpDir();
    const { http } = fakeHttp(0.6);
    const c = new DatabentoClient({ dir, http, apiKey: "db-test", totalBudgetUsd: 1, sleep: noSleep });
    await c.getRange(REQ, { caller: "a", maxCallUsd: 1 });
    await assert.rejects(
      () => c.getRange({ ...REQ, schema: "trades" }, { caller: "b", maxCallUsd: 1 }),
      (err: unknown) => err instanceof BudgetError && err.reason === "total",
    );
    assert.equal(c.guard.entries().length, 1);
  });

  it("a failed pull is refunded with an appended negative line", async () => {
    const dir = tmpDir();
    const { http } = fakeHttp(0.3, { failRange: 1, status: 400 });
    const c = new DatabentoClient({ dir, http, apiKey: "db-test", totalBudgetUsd: 10, sleep: noSleep });
    await assert.rejects(() => c.getRange(REQ, { caller: "a", maxCallUsd: 1 }));
    const lines = c.guard.entries();
    assert.deepEqual(
      lines.map((l) => [l.kind, l.costUsd]),
      [
        ["charge", 0.3],
        ["refund", -0.3],
      ],
    );
    assert.equal(c.guard.spentUsd(), 0);
    // Retried later, it succeeds and is charged once.
    await c.getRange(REQ, { caller: "a", maxCallUsd: 1 });
    assert.equal(c.guard.spentUsd().toFixed(2), "0.30");
  });

  it("retries 429 with backoff, then succeeds", async () => {
    const dir = tmpDir();
    let n = 0;
    const base = fakeHttp(0.1).http;
    const http: HttpFn = async (url, init) => {
      if (url.includes("get_cost") && n++ < 2) return response(429, "slow down", { "retry-after": "0" });
      return base(url, init);
    };
    const c = new DatabentoClient({ dir, http, apiKey: "db-test", totalBudgetUsd: 10, sleep: noSleep });
    assert.equal(await c.getCost(REQ), 0.1);
    assert.equal(n, 3);
  });

  it("concurrent pulls never overspend: the lock serialises check and append", async () => {
    const dir = tmpDir();
    const guard = new SpendGuard({ dir, totalBudgetUsd: 1 });
    const tries = Array.from({ length: 12 }, (_, i) =>
      guard.authorize({ req: { ...REQ, start: `2026-10-${String(i + 1).padStart(2, "0")}` }, costUsd: 0.3, caller: `agent${i % 3}`, maxCallUsd: 1 }).then(
        () => "ok",
        (err) => (err instanceof BudgetError ? "refused" : `error ${err}`),
      ),
    );
    const results = await Promise.all(tries);
    assert.equal(results.filter((r) => r === "ok").length, 3);
    assert.equal(results.filter((r) => r === "refused").length, 9);
    assert.ok(guard.spentUsd() <= 1);
    assert.equal(fs.existsSync(path.join(dir, "spend.lock")), false, "lock released");
  });

  it("breaks a stale lock left by a crashed process", async () => {
    const dir = tmpDir();
    const guard = new SpendGuard({ dir, totalBudgetUsd: 1 });
    const lock = path.join(dir, "spend.lock");
    fs.mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    await guard.authorize({ req: REQ, costUsd: 0.1, caller: "x", maxCallUsd: 1 });
    assert.equal(guard.entries().length, 1);
  });

  it("separate processes share one budget through the lock", async () => {
    const dir = tmpDir();
    const costTs = fileURLToPath(new URL("../src/options/cost.ts", import.meta.url));
    const child = path.join(dir, "child.mts");
    fs.writeFileSync(
      child,
      `import { SpendGuard, BudgetError } from ${JSON.stringify(costTs)};
const g = new SpendGuard({ dir: ${JSON.stringify(dir)}, totalBudgetUsd: 1 });
let ok = 0;
for (let i = 0; i < 3; i++) {
  try { await g.authorize({ req: { dataset: "D", schema: "s", symbols: ["X"], start: "2026-01-0" + (i + 1), end: "2026-01-09" }, costUsd: 0.15, caller: process.argv[2], maxCallUsd: 1 }); ok++; }
  catch (e) { if (!(e instanceof BudgetError)) throw e; }
}
console.log(ok);`,
    );
    const run = (name: string) =>
      new Promise<number>((resolve, reject) =>
        execFile(process.execPath, ["--import", "tsx", child, name], { cwd: path.dirname(costTs) }, (err, out) => (err ? reject(err) : resolve(Number(out.trim())))),
      );
    const oks = await Promise.all([run("p1"), run("p2"), run("p3"), run("p4")]);
    assert.equal(oks.reduce((a, b) => a + b, 0), 6, `granted ${oks}`);
    const guard = new SpendGuard({ dir, totalBudgetUsd: 1 });
    assert.equal(guard.entries().length, 6);
    assert.ok(guard.spentUsd() <= 1 + 1e-9);
  });
});
