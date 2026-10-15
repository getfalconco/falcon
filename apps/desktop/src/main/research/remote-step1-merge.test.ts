import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildGraphFromResearchDir, saveStep1Result, type Step1Result } from "@meridian/research/step1";
import { createRemoteStep1Merger, parseRemoteResult, type RemoteJobLike, type RemoteMergeDeps } from "./remote-step1-merge";

const QUOTE = "Avnet accounted for 23% of our revenue in 2025 and 22% in 2024.";

/** A finished step1 result as the worker's job row carries it. */
function remoteResult(over: Partial<Step1Result> = {}): Step1Result {
  return {
    ticker: "NXPI",
    companyName: "NXP Semiconductors N.V.",
    form: "10-K",
    filingDate: "2026-02-19",
    sourceUrl: "https://www.sec.gov/Archives/edgar/data/1413447/x.htm",
    validated: [
      {
        root_ticker: "NXPI",
        counterparty_name: "Avnet",
        counterparty_ticker: "AVT",
        counterparty_type: "public_company",
        category: "customer",
        subtype: "distributor",
        strength: 0.23,
        strength_tier: "critical",
        strength_basis: "disclosed",
        epistemic_label: "VERIFIED",
        confidence: 0.98,
        evidence: [{ quote: QUOTE, source_url: "https://www.sec.gov/Archives/edgar/data/1413447/x.htm", located_at: "10-K Item 1/1A" }],
        valid_from: "2026-02-19",
        shared_evidence_group: "",
      },
    ],
    rejected: [],
    merged: [],
    stats: {
      form_type: "10-K",
      filing_date: "2026-02-19",
      section_chars: 1000,
      section_method: "item_span_last",
      section_extraction_failed: false,
      chunks: 1,
      api_errors: 0,
      parse_errors: 0,
      candidates_extracted: 1,
      candidates_per_chunk: [1],
      dropped_low_confidence: 0,
      deduped: 0,
      rejected_quote_not_found: 0,
      rejected_by_auditor: 0,
      validated: 1,
    },
    generatedAt: "2026-10-15T08:00:00.000Z",
    accessionNumber: "0001413447-26-000010",
    ...over,
  };
}

function setup(extra: Partial<RemoteMergeDeps> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-remote-merge-"));
  const dataDir = path.join(root, "research");
  const graphFile = path.join(root, "graph.json");
  fs.mkdirSync(dataDir, { recursive: true });
  const calls = { saves: 0, rebuilds: 0, afterMerge: 0 };
  const deps: RemoteMergeDeps = {
    dataDir: () => dataDir,
    localStamp: async (ticker, dir) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, `${ticker}.meta.json`), "utf8")) as {
          generatedAt?: string;
          validatedCount?: number;
        };
        return { generatedAt: meta.generatedAt ?? null, validatedCount: meta.validatedCount ?? -1 };
      } catch {
        return null;
      }
    },
    // The same writers a local job uses.
    save: async (result, dir) => {
      calls.saves++;
      await saveStep1Result(result, dir);
    },
    rebuildGraph: async (dir) => {
      calls.rebuilds++;
      const graph = await buildGraphFromResearchDir(dir);
      fs.writeFileSync(graphFile, JSON.stringify(graph, null, 2));
    },
    afterMerge: () => {
      calls.afterMerge++;
    },
    log: () => {},
    ...extra,
  };
  const readGraph = () => JSON.parse(fs.readFileSync(graphFile, "utf8")) as { edges: Array<Record<string, unknown>> };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { deps, dataDir, graphFile, calls, readGraph, cleanup };
}

function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("remote step1 merge", () => {
  it("writes a finished remote job into the research dir and rebuilds the graph, once", async () => {
    const t = setup();
    try {
      const merger = createRemoteStep1Merger(t.deps);
      const job: RemoteJobLike = { id: "job-1", ticker: "NXPI", status: "done", result: remoteResult() };

      assert.equal(await merger.noteJob(job, "token"), "merged");
      assert.ok(fs.existsSync(path.join(t.dataDir, "NXPI.json")));
      assert.ok(fs.existsSync(path.join(t.dataDir, "NXPI.meta.json")));
      const edges = t.readGraph().edges;
      assert.equal(edges.length, 1);
      assert.equal(edges[0]!.root_ticker, "NXPI");
      assert.equal(edges[0]!.counterparty_id, "AVT");
      assert.equal(edges[0]!.disclosed_share_pct, 23);
      assert.equal(edges[0]!.accession_number, "0001413447-26-000010");
      assert.deepEqual(t.calls, { saves: 1, rebuilds: 1, afterMerge: 1 });

      // The renderer keeps polling a done job: nothing is written again.
      assert.equal(await merger.noteJob(job, "token"), null);
      // A second sighting through the result call: same result, so unchanged.
      assert.equal(await merger.mergeResult(remoteResult(), "NXPI"), "unchanged");
      assert.deepEqual(t.calls, { saves: 1, rebuilds: 1, afterMerge: 1 });
    } finally {
      t.cleanup();
    }
  });

  it("keeps a newer local result and takes a newer remote one", async () => {
    const t = setup();
    try {
      const merger = createRemoteStep1Merger(t.deps);
      await saveStep1Result(remoteResult({ generatedAt: "2026-10-16T00:00:00.000Z" }), t.dataDir);
      assert.equal(await merger.mergeResult(remoteResult(), "NXPI"), "older");
      assert.equal(t.calls.saves, 0);
      assert.equal(await merger.mergeResult(remoteResult({ generatedAt: "2026-10-17T00:00:00.000Z" }), "NXPI"), "merged");
      assert.equal(t.calls.saves, 1);
    } finally {
      t.cleanup();
    }
  });

  it("fetches the result when the job row has none, and ignores failed jobs", async () => {
    let fetched = 0;
    const t = setup({
      getResult: async (_token, ticker) => {
        fetched++;
        return ticker === "NXPI" ? remoteResult() : null;
      },
    });
    try {
      const merger = createRemoteStep1Merger(t.deps);
      assert.equal(await merger.noteJob({ id: "job-err", ticker: "NXPI", status: "error", result: { errorCode: "FAL-SEC-01" } }, "tok"), null);
      assert.equal(t.calls.saves, 0);
      assert.equal(await merger.noteJob({ id: "job-2", ticker: "NXPI", status: "done", result: null }, "tok"), "merged");
      assert.equal(fetched, 1);
      assert.equal(t.readGraph().edges.length, 1);
    } finally {
      t.cleanup();
    }
  });

  it("watches a started job until the worker says it is done", async () => {
    let polls = 0;
    const t = setup({
      getJob: async (_token, jobId) => {
        polls++;
        return polls < 3
          ? { id: jobId, ticker: "NXPI", status: "running", result: null }
          : { id: jobId, ticker: "NXPI", status: "done", result: remoteResult() };
      },
    });
    try {
      const merger = createRemoteStep1Merger(t.deps, { intervalMs: 5 });
      merger.watch("job-3", "NXPI", "tok");
      merger.watch("job-3", "NXPI", "tok"); // a second start of the same job does not double the polling
      await waitFor(() => t.calls.afterMerge === 1);
      assert.equal(polls, 3);
      assert.equal(t.readGraph().edges[0]!.counterparty_name, "Avnet");
      // The status handler seeing the same job afterwards changes nothing.
      assert.equal(await merger.noteJob({ id: "job-3", ticker: "NXPI", status: "done", result: remoteResult() }, "tok"), null);
      assert.equal(t.calls.saves, 1);
      merger.stopAll();
    } finally {
      t.cleanup();
    }
  });

  it("refuses results that are not a step1 result for the job's ticker", () => {
    assert.equal(parseRemoteResult(null), null);
    assert.equal(parseRemoteResult({ errorCode: "FAL-SEC-01" }), null);
    assert.equal(parseRemoteResult({ ...remoteResult(), ticker: "../evil" }), null);
    assert.equal(parseRemoteResult(remoteResult(), "AAPL"), null);
    assert.equal(parseRemoteResult({ ...remoteResult(), validated: "nope" }), null);
    // Edges of another root are dropped, the rest kept.
    const mixed = remoteResult();
    mixed.validated = [...mixed.validated, { ...mixed.validated[0]!, root_ticker: "AAPL" }];
    assert.equal(parseRemoteResult(mixed, "nxpi")!.validated.length, 1);
  });
});
