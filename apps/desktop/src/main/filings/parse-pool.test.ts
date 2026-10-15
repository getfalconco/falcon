import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, it } from "node:test";
import { readFiling, type FilingLike } from "./digest";
import { createFilingParser } from "./parse-pool";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(HERE, "fixtures", name), "utf8");

const TENK: FilingLike = {
  cik: "0000000001",
  form: "10-K",
  accession: "k-2026",
  filedAt: "2026-02-20",
  items: [],
  primaryDocument: "k-2026.htm",
  url: "https://www.sec.gov/Archives/edgar/data/1/k2026/k-2026.htm",
};

describe("filing parser", () => {
  it("round-trips a 10-K through the worker thread, as the calling thread reads it", async () => {
    const html = fixture("tenk-2026.html");
    // The worker runs the .ts source here; tsx's loader comes with the inherited --import.
    const parser = createFilingParser({ spawn: () => new Worker(new URL("./parse-worker.ts", import.meta.url)), log: () => {} });
    try {
      const viaWorker = await parser.parse(TENK, html, true);
      assert.equal(parser.mode(), "worker");
      assert.deepEqual(viaWorker, readFiling(TENK, html, true));
      assert.ok(viaWorker.digest.headings.length > 0);
      assert.ok(viaWorker.searchable && viaWorker.searchable.length > 0);
      // Two at once, one without the text.
      const [a, b] = await Promise.all([parser.parse(TENK, html, false), parser.parse({ ...TENK, form: "10-Q", accession: "q" }, fixture("tenq-2026.html"), false)]);
      assert.equal(a.searchable, null);
      assert.equal(b.digest.accession, "q");
    } finally {
      await parser.close();
    }
  });

  it("reads on the calling thread when the worker cannot start", async () => {
    const html = fixture("tenk-2026.html");
    const logs: string[] = [];
    const parser = createFilingParser({ spawn: () => new Worker("throw new Error('no worker here')", { eval: true }), log: (m) => logs.push(m) });
    const out = await parser.parse(TENK, html, true);
    assert.deepEqual(out, readFiling(TENK, html, true));
    assert.equal(parser.mode(), "thread");
    assert.equal(logs.length, 1);
    // And stays there: no second worker.
    await parser.parse(TENK, html, false);
    assert.equal(logs.length, 1);
    await parser.close();
  });

  it("reads on the calling thread when spawning throws, or none is given", async () => {
    const html = fixture("tenq-2026.html");
    const throwing = createFilingParser({
      spawn: () => {
        throw new Error("no file");
      },
      log: () => {},
    });
    assert.deepEqual(await throwing.parse(TENK, html, false), readFiling(TENK, html, false));
    const none = createFilingParser();
    assert.equal(none.mode(), "thread");
    assert.deepEqual(await none.parse(TENK, html, false), readFiling(TENK, html, false));
  });
});
