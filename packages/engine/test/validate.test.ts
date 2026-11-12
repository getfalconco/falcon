import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RippleCard } from "@falcon/ripple";
import { checkAnswer, fileJudge, type JudgeRequest } from "../src/judge.ts";
import { cardProblems, framingProblems, inventedNumbers } from "../src/validate.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const req: JudgeRequest = {
  eventId: "MCHP-1",
  event: {
    ticker: "MCHP",
    companyName: "Microchip",
    kind: "earnings_surprise",
    headline: "Microchip quarterly EPS 3.6% above consensus",
    occurredAt: "2026-11-05T21:18:06.000Z",
    summary: "Microchip reported EPS of $0.97 for the quarter ended September 30, 2026, 3.6% above the $0.94 consensus estimate. Net sales of $1.622 billion, increased 42.2% from the year-ago quarter.",
  },
  candidates: [
    {
      key: "C1",
      ticker: "ARW",
      companyName: "Arrow Electronics",
      degree: 1,
      relation: "customer",
      links: [{ filer: "Microchip", named: "Arrow Electronics", says: "names Arrow as a customer at 12%", quote: "Arrow Electronics, our largest distributor, which made up 12% and 10% of our net sales", form: "10-K", filedAt: "2026-05-21" }],
    },
    {
      key: "C2",
      ticker: "NXPI",
      companyName: "NXP",
      degree: 1,
      relation: "competitor",
      links: [{ filer: "NXP", named: "Microchip", says: "names Microchip as a competitor", quote: "Our primary key public competitors include Microchip Technology Inc.", form: "10-K", filedAt: "2026-02-19" }],
    },
  ],
};

const good = {
  key: "C1",
  include: true,
  direction: "up",
  confidence: "medium",
  window: "1 to 4 weeks",
  mechanism: "Arrow is Microchip's largest distributor at 12% of net sales, so Microchip's 42.2% year-over-year sales growth ran partly through Arrow.",
};

describe("judge answers", () => {
  it("accepts a grounded answer", () => {
    assert.deepEqual(checkAnswer(req, good)?.problems, []);
  });

  it("rejects numbers the event and the quotes do not hold", () => {
    const a = checkAnswer(req, { ...good, mechanism: "Arrow is Microchip's largest distributor, so a 42.2% rise could add about 7% to Arrow's sales next quarter." });
    assert.ok(a?.problems.some((p) => p.includes("numbers not in the event")));
  });

  it("rejects advice and hype wording", () => {
    for (const m of [
      "Arrow is Microchip's largest distributor at 12% of net sales, which makes Arrow a buying opportunity after 42.2% growth.",
      "Investors should look at Arrow, Microchip's largest distributor at 12% of net sales.",
      "Arrow shares will rise as Microchip's 42.2% growth runs through its largest distributor.",
      "Arrow is a strong buy given Microchip's 42.2% growth through its largest distributor.",
    ]) {
      assert.ok((checkAnswer(req, { ...good, mechanism: m })?.problems.length ?? 0) > 0, m);
    }
  });

  it("allows the plain verbs sell and buy in their business sense", () => {
    assert.deepEqual(framingProblems("Both companies sell inspection tools, and customers buy wafers from TSMC.", "m"), []);
  });

  it("rejects high confidence on a competitor link and unknown keys", () => {
    const a = checkAnswer(req, { ...good, key: "C2", confidence: "high", mechanism: "NXP lists Microchip among its primary competitors, and Microchip's net sales rose 42.2% from a year earlier." });
    assert.ok(a?.problems.some((p) => p.includes("high confidence")));
    assert.equal(checkAnswer(req, { ...good, key: "C9" }), null);
  });

  it("rejects answers outside the closed sets, too long, or over two sentences", () => {
    assert.ok(checkAnswer(req, { ...good, direction: "sideways" })?.problems.includes("bad direction"));
    assert.ok(checkAnswer(req, { ...good, window: "soon" })?.problems.includes("bad window"));
    assert.ok(checkAnswer(req, { ...good, mechanism: "One. Two sentences here. Three is too many for a card." })?.problems.includes("more than two sentences"));
  });

  it("a file judge maps answers by ticker to the request's keys", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "judge-")), "j.json");
    const { key: _k, ...rest } = good;
    fs.writeFileSync(file, JSON.stringify({ judge: "test", events: { "MCHP-1": { hits: [{ ticker: "ARW", ...rest }] } } }));
    const j = fileJudge(file, "fallback");
    assert.equal(j.name, "test");
    const out = (await j.judge(req)) as { hits: Array<{ key: string }> };
    assert.equal(out.hits[0]!.key, "C1");
  });
});

describe("numbers", () => {
  it("knows numbers in the sources, ignores thousands separators and small counts", () => {
    assert.deepEqual(inventedNumbers("Revenue of $1,622 million rose 42.2% over 2 quarters.", ["Net sales of $1622 million, up 42.2%"]), []);
    assert.deepEqual(inventedNumbers("Up 13% in 2027.", ["Up 12% in 2026."]), ["13", "2027"]);
  });
});

describe("cards", () => {
  const card: RippleCard = {
    id: "semis-MCHP-1",
    sector: "semis",
    generatedAt: "2026-11-12T16:00:00.000Z",
    event: {
      id: "MCHP-1",
      ticker: "MCHP",
      companyName: "Microchip",
      kind: "earnings_surprise",
      headline: "Microchip quarterly EPS 3.6% above consensus",
      occurredAt: "2026-11-05T21:18:06.000Z",
      summary: "Microchip reported EPS of $0.97.",
      source: { title: "8-K", url: "https://www.sec.gov/x.htm", publisher: "SEC EDGAR" },
    },
    hits: [
      {
        ticker: "ARW",
        companyName: "Arrow Electronics",
        relation: "customer",
        degree: 1,
        direction: "up",
        confidence: "medium",
        window: "1 to 4 weeks",
        mechanism: "Arrow is Microchip's largest distributor at 12% of net sales.",
        evidence: [{ quote: "Arrow Electronics, our largest distributor, which made up 12%", form: "10-K", filedAt: "2026-05-21", url: "https://www.sec.gov/y.htm" }],
        history: null,
      },
    ],
  };

  it("passes a contract-shaped card", () => {
    assert.deepEqual(cardProblems(card), []);
  });

  it("drops hits without evidence, with history, or degree 2 without via", () => {
    const h = card.hits[0]!;
    assert.ok(cardProblems({ ...card, hits: [{ ...h, evidence: [] }] }).some((p) => p.includes("no evidence")));
    assert.ok(cardProblems({ ...card, hits: [{ ...h, history: { sample: 6, avgMovePct: 3.2, hitRate: 0.6, windowDays: 5 } }] }).some((p) => p.includes("history")));
    assert.ok(cardProblems({ ...card, hits: [{ ...h, degree: 2 }] }).some((p) => p.includes("via")));
    assert.ok(cardProblems({ ...card, hits: [{ ...h, ticker: "MCHP" }] }).some((p) => p.includes("own hit")));
  });

  it("drops evidence that is not an SEC filing", () => {
    const h = card.hits[0]!;
    const bad = { ...h, evidence: [{ ...h.evidence[0]!, url: "https://example.com/blog" }] };
    assert.ok(cardProblems({ ...card, hits: [bad] }).some((p) => p.includes("not an SEC filing")));
  });
});
