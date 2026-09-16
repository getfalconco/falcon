import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUDIT_BATCH_SIZE, parseBatchAuditor, planAuditBatches } from "./audit.js";
import { parseBatchTiers } from "./strength.js";
import { approxTokens, MIN_CACHEABLE_TOKENS } from "./anthropicClient.js";
import { cacheEfficiency, createTokenUsage, estimateCostUsd } from "./tokenUsage.js";
import type { CandidateEdge } from "./types.js";

function candidate(name: string, chunkIndex: number): CandidateEdge {
  return {
    counterparty_name: name,
    counterparty_type: "public_company",
    category: "supplier",
    subtype: "components",
    disclosed_revenue_dependency_pct: null,
    evidence_quote: `We purchase from ${name}.`,
    evidence_quotes: [],
    confidence: 0.9,
    chunk_index: chunkIndex,
  };
}

describe("planAuditBatches", () => {
  const chunks = ["chunk-zero", "chunk-one", "chunk-two"];

  it("sends one call per chunk instead of one per candidate", () => {
    // The regression this whole change exists for: four candidates out of one
    // chunk used to be four uploads of that chunk.
    const candidates = [
      candidate("A", 0),
      candidate("B", 0),
      candidate("C", 0),
      candidate("D", 0),
    ];
    const batches = planAuditBatches(candidates, chunks);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.candidates.length, 4);
    assert.equal(batches[0]!.chunk, "chunk-zero");
  });

  it("groups by chunk, not by input order", () => {
    const candidates = [
      candidate("A", 0),
      candidate("B", 1),
      candidate("C", 0),
      candidate("D", 1),
    ];
    const batches = planAuditBatches(candidates, chunks);
    assert.equal(batches.length, 2);
    assert.deepEqual(
      batches.map((b) => b.candidates.map((c) => c.counterparty_name)),
      [["A", "C"], ["B", "D"]],
    );
  });

  it("never loses or duplicates a candidate", () => {
    const candidates = Array.from({ length: 37 }, (_, i) => candidate(`N${i}`, i % 3));
    const batches = planAuditBatches(candidates, chunks);
    const seen = batches.flatMap((b) => b.candidates.map((c) => c.counterparty_name));
    assert.equal(seen.length, 37);
    assert.equal(new Set(seen).size, 37);
  });

  it("splits a heavy chunk and only then marks it worth caching", () => {
    // CAT's worst chunk held 16.8 candidates. A split means the chunk text is
    // genuinely re-sent, which is the only case where a cache write pays.
    const heavy = Array.from({ length: AUDIT_BATCH_SIZE + 1 }, (_, i) => candidate(`H${i}`, 0));
    const batches = planAuditBatches(heavy, chunks);
    assert.equal(batches.length, 2);
    assert.ok(batches.every((b) => b.cacheChunk));
  });

  it("does NOT cache a chunk that is only sent once", () => {
    // A write with no read costs 1.25x for nothing — the snowball we are fixing.
    const batches = planAuditBatches([candidate("A", 0), candidate("B", 0)], chunks);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.cacheChunk, false);
  });

  it("treats a missing chunk as empty rather than throwing", () => {
    const batches = planAuditBatches([candidate("A", 99)], chunks);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.chunk, "");
  });
});

describe("parseBatchAuditor", () => {
  it("maps verdicts back by index", () => {
    const raw = JSON.stringify({
      verdicts: [
        { index: 0, verdict: "approve", reason: "", corrected: null, confidence: 0.9 },
        { index: 1, verdict: "reject", reason: "not a counterparty", corrected: null, confidence: 0.2 },
      ],
    });
    const out = parseBatchAuditor(raw, 2);
    assert.equal(out.size, 2);
    assert.equal(out.get(0)!.verdict, "approve");
    assert.equal(out.get(1)!.verdict, "reject");
  });

  it("drops indexes outside the batch rather than mis-assigning them", () => {
    // A hallucinated index must never land on someone else's candidate.
    const raw = JSON.stringify({
      verdicts: [
        { index: 0, verdict: "approve", reason: "", corrected: null, confidence: 0.9 },
        { index: 7, verdict: "reject", reason: "", corrected: null, confidence: 0.1 },
      ],
    });
    const out = parseBatchAuditor(raw, 2);
    assert.equal(out.size, 1);
    assert.ok(out.has(0));
  });

  it("survives fences and prose around the JSON", () => {
    const raw =
      'Here you go:\n```json\n{"verdicts":[{"index":0,"verdict":"fix","reason":"wrong category",' +
      '"corrected":{"counterparty_name":"A","counterparty_type":"public_company",' +
      '"category":"customer","subtype":"x"},"confidence":0.7}]}\n```';
    const out = parseBatchAuditor(raw, 1);
    assert.equal(out.get(0)!.verdict, "fix");
    assert.equal(out.get(0)!.corrected!.category, "customer");
  });

  it("returns empty on unparseable output so callers can reject the batch", () => {
    assert.equal(parseBatchAuditor("the model wrote prose", 3).size, 0);
  });
});

describe("parseBatchTiers", () => {
  it("maps tiers back by index", () => {
    const raw = JSON.stringify({
      tiers: [
        { index: 0, strength_tier: "critical" },
        { index: 1, strength_tier: "marginal" },
      ],
    });
    const out = parseBatchTiers(raw, 2);
    assert.equal(out.get(0), "critical");
    assert.equal(out.get(1), "marginal");
  });

  it("ignores an unknown tier rather than inventing one", () => {
    const raw = JSON.stringify({ tiers: [{ index: 0, strength_tier: "enormous" }] });
    assert.equal(parseBatchTiers(raw, 1).size, 0);
  });
});

describe("cache accounting", () => {
  it("only sets a breakpoint above the cacheable minimum", () => {
    // Both step1 system prompts sit under this, which is why none of them are
    // cached: a breakpoint there is accepted and silently ignored.
    assert.ok(approxTokens("x".repeat(2001)) < MIN_CACHEABLE_TOKENS);
    assert.ok(approxTokens("x".repeat(24_000)) > MIN_CACHEABLE_TOKENS);
  });

  it("prices a write above plain input and a read far below it", () => {
    const plain = createTokenUsage();
    plain.inputTokens = 1_000_000;

    const written = createTokenUsage();
    written.cacheCreationTokens = 1_000_000;

    const read = createTokenUsage();
    read.cacheReadTokens = 1_000_000;

    assert.ok(estimateCostUsd(written) > estimateCostUsd(plain));
    assert.ok(estimateCostUsd(read) < estimateCostUsd(plain));
  });

  it("reports read÷write so a write-only run is visible", () => {
    const usage = createTokenUsage();
    assert.equal(cacheEfficiency(usage), null);
    usage.cacheCreationTokens = 15_790_000;
    usage.cacheReadTokens = 4_300;
    // The observed production ratio: writes paying 1.25x, nothing reading back.
    assert.ok(cacheEfficiency(usage)! < 0.001);
  });
});
