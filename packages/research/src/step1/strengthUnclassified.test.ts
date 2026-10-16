import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGraphFromResearchDir } from "./buildGraph.js";
import { defaultedStrengthPlan } from "./disclosedShareBackfill.js";
import {
  classifyEdgeStrength,
  classifyEdgesStrength,
  isMeasuredStrength,
  resolveEdgeStrength,
  strengthChipLabel,
  THINKING_HEADROOM_TOKENS,
  unclassifiedStrength,
  type StrengthClassifyInput,
} from "./strength.js";
import type { ValidatedEdge } from "./types.js";

function validated(over: Partial<ValidatedEdge> & Pick<ValidatedEdge, "counterparty_name">): ValidatedEdge {
  return {
    root_ticker: "NVDA",
    counterparty_ticker: null,
    counterparty_type: "public_company",
    category: "supplier",
    subtype: "",
    strength: 0.6,
    strength_tier: "important",
    strength_basis: "classified",
    disclosed_share_pct: null,
    disclosed_share_quote: null,
    epistemic_label: "VERIFIED",
    confidence: 0.95,
    evidence: [{ quote: `We buy from ${over.counterparty_name}.`, source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    valid_from: "2026-02-10",
    shared_evidence_group: "",
    ...over,
  };
}

const input = (name: string): StrengthClassifyInput => ({
  counterparty_name: name,
  category: "supplier",
  subtype: "foundry",
  disclosed_revenue_dependency_pct: null,
  evidence_quote: `We utilize foundries, such as ${name}.`,
});

describe("strength: no parsable tier is unclassified, never a silent important", () => {
  it("resolves a missing tier to unclassified, ranked as important", () => {
    assert.deepEqual(resolveEdgeStrength({}), { strength: 0.6, strength_tier: "important", strength_basis: "unclassified" });
    assert.deepEqual(resolveEdgeStrength({ strength_tier: null }), unclassifiedStrength());
    assert.deepEqual(resolveEdgeStrength({ strength_tier: "important" }), { strength: 0.6, strength_tier: "important", strength_basis: "classified" });
    assert.equal(resolveEdgeStrength({ disclosed_revenue_dependency_pct: 12 }).strength_basis, "disclosed");
  });

  it("never labels an unclassified tier as measured", () => {
    assert.equal(isMeasuredStrength({ strength_basis: "unclassified" }), false);
    assert.equal(isMeasuredStrength({ strength_basis: "classified" }), true);
    assert.equal(isMeasuredStrength({}), true);
    assert.equal(strengthChipLabel("important", "unclassified"), "unrated link");
    assert.equal(strengthChipLabel("important", "classified"), "important link");
    assert.equal(strengthChipLabel("critical"), "critical link");
  });
});

describe("strength classifier against a stub API", () => {
  type Reply = { status: number; body: unknown };
  let replies: Reply[] = [];
  const requests: Array<{ max_tokens: number; model: string }> = [];
  let server: http.Server;
  const saved: Record<string, string | undefined> = {};
  const env = {
    FALCON_STEP1_API_KEY: "test-key",
    FALCON_STEP1_BASE_URL: "",
    FALCON_STEP1_STRENGTH_MODEL: "stub-strength-model",
  };

  const message = (content: unknown[], stop_reason = "end_turn") => ({
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "stub-strength-model",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
  /** What the bug looked like: max_tokens hit inside the thinking block, no text. */
  const ranOutThinking = () => message([{ type: "thinking", thinking: "Let me weigh each edge", signature: "sig" }], "max_tokens");
  const text = (t: string) => message([{ type: "text", text: t }]);

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as { max_tokens: number; model: string };
        requests.push({ max_tokens: body.max_tokens, model: body.model });
        const reply = replies.shift() ?? { status: 200, body: ranOutThinking() };
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.FALCON_STEP1_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("an answer cut off in thinking leaves the whole batch unclassified", async () => {
    replies = [{ status: 200, body: ranOutThinking() }];
    requests.length = 0;
    const out = await classifyEdgesStrength([input("TSMC"), input("Samsung")]);
    assert.deepEqual(out.map((r) => r.strength_basis), ["unclassified", "unclassified"]);
    assert.deepEqual(out.map((r) => r.strength_tier), ["important", "important"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.model, "stub-strength-model");
    assert.ok(requests[0]!.max_tokens >= THINKING_HEADROOM_TOKENS, "the call leaves room to think");
  });

  it("keeps the tiers it can read and marks only the missing ones", async () => {
    replies = [{ status: 200, body: text(JSON.stringify({ tiers: [{ index: 0, strength_tier: "critical" }] })) }];
    const out = await classifyEdgesStrength([input("TSMC"), input("Samsung")]);
    assert.deepEqual(
      out.map((r) => [r.strength_tier, r.strength_basis]),
      [
        ["critical", "classified"],
        ["important", "unclassified"],
      ],
    );
  });

  it("a failed call marks its batch unclassified without sinking the run", async () => {
    replies = [{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } }];
    const out = await classifyEdgesStrength([input("TSMC"), { ...input("Apple"), disclosed_revenue_dependency_pct: 25 }]);
    assert.equal(out[0]!.strength_basis, "unclassified");
    assert.equal(out[1]!.strength_basis, "disclosed");
  });

  it("the single-edge path marks an empty answer unclassified and uses the strength model", async () => {
    replies = [{ status: 200, body: ranOutThinking() }];
    requests.length = 0;
    const out = await classifyEdgeStrength(input("TSMC"));
    assert.equal(out.strength_basis, "unclassified");
    assert.equal(requests[0]!.model, "stub-strength-model");
    replies = [{ status: 200, body: text('{"strength_tier":"marginal"}') }];
    assert.deepEqual(await classifyEdgeStrength(input("TSMC")), { strength: 0.3, strength_tier: "marginal", strength_basis: "classified" });
  });
});

describe("defaulted strength plan (--only-defaulted)", () => {
  const edges = [
    validated({ counterparty_name: "Unclassified", strength_basis: "unclassified" }),
    validated({ counterparty_name: "Legacy important" }),
    validated({ counterparty_name: "Marginal", strength: 0.3, strength_tier: "marginal" }),
    validated({ counterparty_name: "Critical", strength: 1, strength_tier: "critical" }),
    validated({
      counterparty_name: "Disclosed",
      strength: 0.6,
      strength_tier: "critical",
      strength_basis: "disclosed",
    }),
    validated({
      counterparty_name: "Stated share",
      disclosed_share_pct: 6,
      disclosed_share_quote: "Stated share accounted for 6% of revenue.",
      evidence: [{ quote: "Stated share accounted for 6% of revenue.", source_url: "https://www.sec.gov/x", located_at: "10-K Item 1/1A" }],
    }),
  ];

  it("always selects unclassified edges; the legacy pool only when asked", () => {
    assert.deepEqual(defaultedStrengthPlan(edges), { unclassified: [0], legacy: [] });
    assert.deepEqual(defaultedStrengthPlan(edges, { legacy: true }), { unclassified: [0], legacy: [1] });
  });
});

describe("graph build carries the basis", () => {
  it("keeps unclassified on the graph edge, and an edge with no tier is unclassified", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-unclassified-"));
    try {
      const noTier = validated({ counterparty_name: "Old" }) as Partial<ValidatedEdge>;
      delete noTier.strength;
      delete noTier.strength_tier;
      delete noTier.strength_basis;
      await writeFile(
        path.join(dir, "NVDA.json"),
        JSON.stringify([
          validated({ counterparty_name: "Unrated", strength_basis: "unclassified" }),
          validated({ counterparty_name: "Rated" }),
          noTier,
        ]),
      );
      const graph = await buildGraphFromResearchDir(dir);
      const by = (n: string) => graph.edges.find((e) => e.counterparty_name === n)!;
      assert.deepEqual([by("Unrated").strength_tier, by("Unrated").strength_basis], ["important", "unclassified"]);
      assert.deepEqual([by("Rated").strength_tier, by("Rated").strength_basis], ["important", "classified"]);
      assert.deepEqual([by("Old").strength_tier, by("Old").strength_basis, by("Old").strength], ["important", "unclassified", 0.6]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
