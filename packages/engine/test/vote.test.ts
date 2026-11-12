import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Confidence, Direction } from "@falcon/ripple";
import type { Judge, JudgeRequest } from "../src/judge.ts";
import { agreed, callBudget, included, pickVote, plurality, splitOf, voteJudge } from "../src/vote.ts";

const req: JudgeRequest = {
  eventId: "ONTO-1",
  event: { ticker: "ONTO", companyName: "Onto Innovation", kind: "earnings_surprise", headline: "Onto beat", occurredAt: "2026-11-09T21:08:00Z", summary: "Onto Innovation reported EPS above consensus." },
  candidates: ["C1", "C2"].map((key, i) => ({
    key,
    ticker: i === 0 ? "NVMI" : "CAMT",
    companyName: i === 0 ? "Nova" : "Camtek",
    degree: 1 as const,
    relation: "competitor",
    links: [{ filer: "ONTO", named: "Nova", says: "names Nova as a competitor", quote: "Our principal competitors include KLA Corporation and Nova Ltd.", form: "10-K", filedAt: "2026-02-20" }],
  })),
};

const MECH = "Onto names this company a principal competitor, so its quarter speaks to demand in the same inspection market.";

type A = { d: Direction; c?: Confidence; inc?: boolean; mech?: string };
const answer = (key: string, a: A) => ({ key, include: a.inc ?? true, direction: a.d, confidence: a.c ?? "medium", window: "1 to 4 weeks", mechanism: a.mech ?? MECH });

/** A judge that answers call i from script[i]; "fail" throws. C2 always answers "up" unless given. */
function scripted(script: Array<Partial<Record<"C1" | "C2", A>> | "fail">): Judge & { calls: number } {
  const j = {
    name: "fake",
    calls: 0,
    async judge() {
      const step = script[j.calls++];
      if (step === undefined) throw new Error("script ran out");
      if (step === "fail") throw new Error("boom");
      return { hits: (["C1", "C2"] as const).filter((k) => step[k] !== undefined || k === "C2").map((k) => answer(k, step[k] ?? { d: "up" })) };
    },
  };
  return j;
}

const v = (direction: Direction, include = true) => ({ direction, include });

describe("vote rules", () => {
  it("2 of 3 agreeing decides; all differing does not", () => {
    assert.equal(agreed([v("up"), v("up"), v("down")]), "up");
    assert.equal(agreed([v("unclear"), v("unclear"), v("up")]), "unclear");
    assert.equal(agreed([v("up"), v("down"), v("unclear")]), null);
  });

  it("after five, unclear only as a majority or on an exact up/down tie", () => {
    assert.equal(plurality([v("up"), v("down"), v("unclear"), v("up"), v("unclear")]), "up");
    assert.equal(plurality([v("up"), v("down"), v("unclear"), v("unclear"), v("unclear")]), "unclear");
    assert.equal(plurality([v("up"), v("down"), v("unclear"), v("down"), v("up")]), "unclear");
    assert.equal(plurality([v("down"), v("down"), v("unclear"), v("unclear"), v("up")]), "down");
  });

  it("includes on a strict majority of valid votes", () => {
    assert.equal(included([v("up"), v("up", false), v("up")]), true);
    assert.equal(included([v("up"), v("up", false)]), false);
    assert.deepEqual(splitOf([v("up"), v("up", false), v("down")]), { up: 1, down: 1, unclear: 0, excluded: 1 });
  });

  it("takes the most common confidence among the winners, a tie going lower, and the first such vote's text", () => {
    const mk = (d: Direction, c: Confidence, mech: string) => ({ key: "C1", include: true, direction: d, confidence: c, window: "1 to 4 weeks" as const, mechanism: mech, problems: [] });
    const pick = pickVote([mk("up", "medium", "a"), mk("down", "high", "b"), mk("up", "low", "c")], "up");
    assert.equal(pick.confidence, "low");
    assert.equal(pick.mechanism, "c");
    assert.equal(pickVote([mk("up", "medium", "a"), mk("up", "medium", "b"), mk("up", "low", "c")], "up").mechanism, "a");
  });
});

describe("voteJudge with a fake judge", () => {
  it("2 of 3: three calls, the agreed direction, the split on the hit", async () => {
    const j = scripted([{ C1: { d: "up", c: "medium" } }, { C1: { d: "up", c: "low" } }, { C1: { d: "down", c: "low" } }]);
    const r = await voteJudge(j, req, callBudget());
    assert.equal(j.calls, 3);
    const nvmi = r.hits.find((h) => h.answer.key === "C1")!;
    assert.equal(nvmi.answer.direction, "up");
    assert.equal(nvmi.answer.confidence, "low");
    assert.deepEqual(nvmi.votes, { up: 2, down: 1, unclear: 0, excluded: 0 });
    assert.equal(r.splits.some((s) => s.escalated), false);
  });

  it("all three differ: two more calls, then the plurality of up and down", async () => {
    const j = scripted([{ C1: { d: "up" } }, { C1: { d: "down" } }, { C1: { d: "unclear" } }, { C1: { d: "up" } }, { C1: { d: "unclear" } }]);
    const r = await voteJudge(j, req, callBudget());
    assert.equal(j.calls, 5);
    const nvmi = r.hits.find((h) => h.answer.key === "C1")!;
    assert.equal(nvmi.answer.direction, "up");
    assert.deepEqual(nvmi.votes, { up: 2, down: 1, unclear: 2, excluded: 0 });
    assert.equal(r.splits.find((s) => s.key === "C1")!.escalated, true);
    // C2 agreed in the first round and keeps its three votes.
    assert.deepEqual(r.hits.find((h) => h.answer.key === "C2")!.votes, { up: 3, down: 0, unclear: 0, excluded: 0 });
  });

  it("unclear wins only as a majority: 3 of 5", async () => {
    const j = scripted([{ C1: { d: "up" } }, { C1: { d: "down" } }, { C1: { d: "unclear" } }, { C1: { d: "unclear" } }, { C1: { d: "unclear" } }]);
    const r = await voteJudge(j, req, callBudget());
    assert.equal(r.hits.find((h) => h.answer.key === "C1")!.answer.direction, "unclear");
  });

  it("an exact up/down tie is unclear", async () => {
    const j = scripted([{ C1: { d: "up" } }, { C1: { d: "down" } }, { C1: { d: "unclear" } }, { C1: { d: "down" } }, { C1: { d: "up" } }]);
    const r = await voteJudge(j, req, callBudget());
    const nvmi = r.hits.find((h) => h.answer.key === "C1")!;
    assert.equal(nvmi.answer.direction, "unclear");
    assert.deepEqual(nvmi.votes, { up: 2, down: 2, unclear: 1, excluded: 0 });
  });

  it("discards an invalid vote and replaces it with one retry", async () => {
    // Call 2 invents a number; call 3 fails outright; the two retries are valid.
    const j = scripted([{ C1: { d: "up" } }, { C1: { d: "up", mech: "Nova grew 37% last quarter, so Onto's beat points to the same inspection demand." } }, "fail", { C1: { d: "down" } }, { C1: { d: "up" } }]);
    const r = await voteJudge(j, req, callBudget());
    assert.equal(j.calls, 5);
    assert.ok(r.discarded.some((d) => d.key === "C1" && /numbers not in the event/.test(d.problems.join())));
    assert.ok(r.discarded.some((d) => d.key === "C1" && /call failed/.test(d.problems.join())));
    const nvmi = r.hits.find((h) => h.answer.key === "C1")!;
    assert.deepEqual(nvmi.votes, { up: 2, down: 1, unclear: 0, excluded: 0 });
    assert.equal(nvmi.answer.direction, "up");
  });

  it("a retried vote that fails again is dropped, not retried twice", async () => {
    const bad = "Nova grew 37% last quarter, so Onto's beat points to the same inspection demand.";
    const j = scripted([{ C1: { d: "up" } }, { C1: { d: "up" } }, { C1: { d: "down", mech: bad } }, { C1: { d: "down", mech: bad } }]);
    const r = await voteJudge(j, req, callBudget());
    assert.equal(j.calls, 4);
    assert.deepEqual(r.hits.find((h) => h.answer.key === "C1")!.votes, { up: 2, down: 0, unclear: 0, excluded: 0 });
  });

  it("stops at the call budget and fails an event it cannot ask about", async () => {
    const budget = callBudget(2);
    const j = scripted([{ C1: { d: "up" } }, { C1: { d: "up" } }]);
    const r = await voteJudge(j, req, budget);
    assert.equal(j.calls, 2);
    assert.equal(r.hits.find((h) => h.answer.key === "C1")!.answer.direction, "up");
    await assert.rejects(voteJudge(scripted([{}]), req, budget), /budget spent/);
  });

  it("asks a deterministic judge once", async () => {
    const j = Object.assign(scripted([{ C1: { d: "down" } }]), { deterministic: true });
    const r = await voteJudge(j, req, callBudget());
    assert.equal(j.calls, 1);
    assert.deepEqual(r.hits.find((h) => h.answer.key === "C1")!.votes, { up: 0, down: 1, unclear: 0, excluded: 0 });
  });
});
