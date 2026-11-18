// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/attention.test.ts
// Pure checks of the Dashboard attention sentence; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { earningsReleaseOf, type OptionsEarningsRelease } from "../options-api";
import {
  ATTENTION_FEED_ERROR,
  ATTENTION_FEED_MISSING,
  ATTENTION_QUIET,
  attentionSentence,
  earningsClause,
  earningsSoon,
  type AttentionInput,
  type EarningsSoon,
} from "./attention";

const rel = (ticker: string, date: string, time: OptionsEarningsRelease["time"], movePct: number, session = "2026-11-17"): OptionsEarningsRelease => ({
  ticker,
  date,
  time,
  reactionDay: date,
  movePct,
  session,
  asOf: `${session}T20:45:00.000Z`,
});
const portfolio = new Set(["NVDA", "AMD", "AAPL"]);
// Tuesday 2026-11-17 and Wednesday 2026-11-18, New York (EST, UTC-5).
const tue = (hhmm: string) => Date.parse(`2026-11-17T${hhmm}:00-05:00`);

test("stored straddle rows: fields checked, implied move in percent", () => {
  const ok = earningsReleaseOf("nvda", "2026-11-18", {
    implied_move: 0.1023,
    earnings_date: "2026-11-18",
    earnings_time: "after_close",
    reaction_day: "2026-11-19",
    as_of: "2026-11-18T20:45:00.000Z",
  });
  assert.deepEqual(ok, { ticker: "NVDA", date: "2026-11-18", time: "after_close", reactionDay: "2026-11-19", movePct: 10.2, session: "2026-11-18", asOf: "2026-11-18T20:45:00.000Z" });
  assert.equal(earningsReleaseOf("NVDA", "2026-11-18", null), null);
  assert.equal(earningsReleaseOf("NVDA", "2026-11-18", { implied_move: 0.1, earnings_date: "soon", reaction_day: "2026-11-19" }), null);
  assert.equal(earningsReleaseOf("NVDA", "2026-11-18", { implied_move: 0, earnings_date: "2026-11-18", reaction_day: "2026-11-19" }), null);
  assert.equal(earningsReleaseOf("NVDA", "2026-11-18", { implied_move: 0.05, earnings_date: "2026-11-18", reaction_day: "2026-11-19", earnings_time: "lunch" })?.time, "unknown");
});

test("only portfolio tickers reporting today or tomorrow in New York", () => {
  const releases = [
    rel("NVDA", "2026-11-17", "after_close", 10.2),
    rel("AMD", "2026-11-18", "before_open", 7.4),
    rel("MSFT", "2026-11-17", "after_close", 5), // not on the list
    rel("AAPL", "2026-11-19", "before_open", 4), // the day after tomorrow
    rel("AAPL", "2026-11-16", "after_close", 4, "2026-11-16"), // yesterday
  ];
  const soon = earningsSoon(releases, portfolio, tue("11:00"));
  assert.deepEqual(
    soon.map((s) => [s.ticker, s.when]),
    [
      ["NVDA", "reports tonight"],
      ["AMD", "reports tomorrow before the open"],
    ],
  );
  assert.deepEqual(earningsSoon(releases, new Set(), tue("11:00")), []);
});

test("tense follows the clock: a before-open release is out after the open", () => {
  const r = [rel("NVDA", "2026-11-17", "before_open", 8, "2026-11-16")];
  assert.equal(earningsSoon(r, portfolio, tue("08:00"))[0]?.when, "reports this morning before the open");
  const later = earningsSoon(r, portfolio, tue("10:00"))[0]!;
  assert.equal(later.when, "reported before today's open");
  assert.equal(later.past, true);
  assert.equal(earningsClause([later]), "NVDA reported before today's open, options priced ±8.0%.");
  assert.equal(earningsSoon([rel("NVDA", "2026-11-17", "after_close", 8)], portfolio, tue("17:00"))[0]?.when, "reports after today's close");
  assert.equal(earningsSoon([rel("NVDA", "2026-11-17", "unknown", 8, "2026-11-16")], portfolio, tue("12:00"))[0]?.when, "reports today");
  assert.equal(earningsSoon([rel("NVDA", "2026-11-18", "unknown", 8)], portfolio, tue("18:00"))[0]?.when, "reports tomorrow");
  // Late evening in Istanbul is still the same New York day.
  assert.equal(earningsSoon([rel("NVDA", "2026-11-17", "after_close", 8)], portfolio, Date.parse("2026-11-18T00:30:00+03:00"))[0]?.when, "reports after today's close");
});

test("a straddle snapshot after its release date is ignored", () => {
  assert.deepEqual(earningsSoon([rel("NVDA", "2026-11-17", "after_close", 9, "2026-11-18")], portfolio, tue("11:00")), []);
});

test("the clause names the first release and counts the rest", () => {
  const soon = earningsSoon(
    [rel("AMD", "2026-11-18", "before_open", 7.4), rel("NVDA", "2026-11-17", "after_close", 10.2), rel("AAPL", "2026-11-18", "after_close", 3.1)],
    portfolio,
    tue("11:00"),
  );
  assert.equal(earningsClause(soon), "NVDA reports tonight, options price ±10.2%. 2 more in your portfolio have earnings today or tomorrow.");
  assert.equal(earningsClause(soon.slice(0, 2)), "NVDA reports tonight, options price ±10.2%. 1 more in your portfolio has earnings today or tomorrow.");
  assert.equal(earningsClause([]), "");
});

const nvda: EarningsSoon[] = [{ ticker: "NVDA", when: "reports tonight", past: false, movePct: 10.2, date: "2026-11-17", time: "after_close" }];

/** The line's text; "<loading>" while it holds its space, "<none>" when it shows nothing. */
const line = (i: AttentionInput): string => {
  const l = attentionSentence(i);
  return l.kind === "text" ? l.text : `<${l.kind}>`;
};

test("the sentence in each state", () => {
  const base = { feedStatus: "ready" as const, portfolioCount: 5, decisions: 2, earnings: [] as EarningsSoon[] };
  // Loading: nothing yet, so no wrong text flashes.
  assert.equal(line({ ...base, feedStatus: "loading" }), "<loading>");
  assert.equal(line({ ...base, earnings: null }), "<loading>");
  // Ready.
  assert.equal(line(base), "2 things need your decision.");
  assert.equal(line({ ...base, decisions: 1 }), "1 thing needs your decision.");
  assert.equal(line({ ...base, earnings: nvda }), "2 things need your decision. NVDA reports tonight, options price ±10.2%.");
  assert.equal(line({ ...base, decisions: 0 }), ATTENTION_QUIET);
  assert.equal(line({ ...base, decisions: 0, earnings: nvda }), "NVDA reports tonight, options price ±10.2%.");
  // Empty portfolio: no sentence at all, whatever the feed or the options say.
  assert.equal(line({ ...base, portfolioCount: 0, decisions: 0 }), "<none>");
  assert.equal(line({ ...base, portfolioCount: 0, decisions: 0, earnings: nvda }), "<none>");
  assert.equal(line({ ...base, portfolioCount: 0, feedStatus: "error" }), "<none>");
  assert.equal(line({ ...base, preview: true, portfolioCount: 0 }), "<none>");
  // Feed problems keep the earnings clause (it comes from the options store).
  assert.equal(line({ ...base, feedStatus: "error" }), ATTENTION_FEED_ERROR);
  assert.equal(line({ ...base, feedStatus: "unavailable", earnings: nvda }), `${ATTENTION_FEED_MISSING} NVDA reports tonight, options price ±10.2%.`);
  // Preview (no account) and the development sample feed say so.
  assert.equal(line({ ...base, preview: true }), "Preview: 2 things need your decision.");
  assert.equal(line({ ...base, preview: true, sample: true }), "Preview, sample data: 2 things need your decision.");
  assert.equal(line({ ...base, sample: true, decisions: 0 }), `Sample data: ${ATTENTION_QUIET}`);
});
