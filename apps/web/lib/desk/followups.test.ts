// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/desk/followups.test.ts
// Follow-up block stripping (complete, partial mid-stream, absent) and the reply's source list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanFollowups, parseFollowups, splitFollowups } from "./followups";
import { replySources, sourceKind } from "./reply-sources";
import type { CiteReport } from "./citations";

const BODY = "AAPL'nin brüt marjı nasıl değişti?|IV yüzdeliği ne anlatıyor?|Bir sonraki bilanço ne zaman?";

test("a complete block is removed and its questions kept", () => {
  const r = splitFollowups(`Gelir arttı.\n\n<followups>${BODY}</followups>`, false);
  assert.equal(r.text, "Gelir arttı.");
  assert.deepEqual(r.followups, ["AAPL'nin brüt marjı nasıl değişti?", "IV yüzdeliği ne anlatıyor?", "Bir sonraki bilanço ne zaman?"]);
});

test("a reply without the block is unchanged and has no follow-ups", () => {
  const t = "Revenue grew 8%.\nP/E < 30 is common.";
  assert.deepEqual(splitFollowups(t, false), { text: t, followups: [] });
  assert.deepEqual(splitFollowups(t, true), { text: t, followups: [] });
});

test("never flashes a partial tag while streaming", () => {
  const full = `Gelir arttı.\n<followups>${BODY}</followups>`;
  // Every prefix of the stream shows at most the answer text, never "<", "<follow", the questions or "</followups".
  for (let i = 0; i <= full.length; i++) {
    const { text } = splitFollowups(full.slice(0, i), true);
    assert.ok("Gelir arttı.".startsWith(text.trimEnd()) || text === "Gelir arttı.", `prefix ${i}: ${JSON.stringify(text)}`);
    assert.ok(!text.includes("<"), `prefix ${i} shows a tag: ${JSON.stringify(text)}`);
  }
});

test("partial tag prefixes are held back only while streaming", () => {
  assert.equal(splitFollowups("Done. <fol", true).text, "Done.");
  assert.equal(splitFollowups("Done. <", true).text, "Done.");
  assert.equal(splitFollowups("Done. <FOLLOWUPS>q1|q", true).text, "Done.");
  // Not a prefix of the tag: kept.
  assert.equal(splitFollowups("a <b", true).text, "a <b");
  // Complete reply: a lone "<" is text.
  assert.equal(splitFollowups("x <", false).text, "x <");
  // An unclosed block at the end of a complete reply is still hidden (never shown raw), with no questions.
  assert.deepEqual(splitFollowups("Done.\n<followups>q1|q2", false), { text: "Done.", followups: [] });
});

test("questions are cleaned: list marks, blanks, duplicates, at most three", () => {
  assert.deepEqual(parseFollowups("- One?\n2. Two?||one?|Three?|Four?"), ["One?", "Two?", "Three?"]);
  assert.deepEqual(cleanFollowups(["A?", 3, "", "B?"]), ["A?", "B?"]);
  assert.equal(cleanFollowups("x"), undefined);
  assert.equal(cleanFollowups([]), undefined);
});

test("sources: one per data lookup, named by the citation check, chart and app actions left out", () => {
  const cites: CiteReport = {
    v: 1,
    checks: [{ ref: "t2", label: "$94,9 mlr", status: "verified", source: { label: "SEC XBRL company facts", as_of: "2026-06-28" }, url: "https://www.sec.gov/Archives/x.htm" }],
    uncited: [],
    stats: { cited: 1, verified: 1, mismatch: 0, unresolved: 0, unchecked: 0, uncited: 0, derived: 0 },
  };
  const tools = [
    { src: "t1", cmd: "/quote AAPL", ok: true, result: JSON.stringify({ source: "Databento EQUS.SUMMARY, end of day", close: 1 }) },
    { src: "t2", cmd: "/fundamentals AAPL", ok: true },
    { src: "t3", cmd: "/options AAPL", ok: true, result: "src:t3 fetched_at:2026-11-16T00:00:00Z\n{\"as_of\":\"2026-11-14\"}" },
    { src: "t4", cmd: "/chart line \"AAPL\"", ok: true },
    { src: "t5", cmd: "/open AAPL", ok: true },
    { src: "t6", cmd: "/earnings AAPL", ok: false },
    { cmd: "/quote MSFT", ok: true },
  ];
  const s = replySources(tools, cites);
  assert.deepEqual(s.map((x) => [x.id, x.kind, x.domain, x.cited]), [
    ["t1", "databento", "Databento", false],
    ["t2", "sec", "sec.gov", true],
    ["t3", "databento", "Databento", false],
  ]);
  assert.equal(s[1]!.url, "https://www.sec.gov/Archives/x.htm");
  assert.equal(s[1]!.asOf, "2026-06-28");
  assert.equal(s[2]!.label, "OPRA via Databento");
  assert.equal(s[2]!.asOf, "2026-11-14");
  assert.deepEqual(replySources(undefined), []);
});

test("source kinds", () => {
  assert.equal(sourceKind("Yahoo Finance earnings"), "yahoo");
  assert.equal(sourceKind("Falcon Sightings"), "falcon");
  assert.equal(sourceKind("anything", "audit_run"), "computed");
  assert.equal(sourceKind("SEC EDGAR Form 4 filings"), "sec");
});
