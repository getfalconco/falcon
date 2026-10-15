import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { textProblems } from "./copy-rules";
import * as area from "../renderer/lib/i18n/messages/areas/implied";
import {
  IMPLIED_REQUEST_CAP,
  atmStraddle,
  impliedFigure,
  impliedHint,
  impliedLine,
  latestOpenMs,
  legPrice,
  median,
  moveHistory,
  parseImpliedRequest,
  pickExpiries,
  reportCover,
  sessionsAfter,
  sessionsThrough,
  snapshotFreshUntil,
  type ExpiryQuotes,
  type ImpliedMove,
  type OptionLeg,
  type Say,
} from "./implied-move";

// 2026-10-15 is a Thursday; New York is on daylight time (open 13:30 UTC, close 20:00 UTC).
const THU_NOON = Date.parse("2026-10-15T16:00:00Z");
const THU_EVENING = Date.parse("2026-10-15T23:00:00Z");
const SAT = Date.parse("2026-10-17T15:00:00Z");
const MON_OPEN = Date.parse("2026-10-19T13:30:00Z");
const THU_OPEN = Date.parse("2026-10-15T13:30:00Z");

function leg(strike: number, bid: number | null, ask: number | null, last: number | null = null, lastTradeSec: number | null = null): OptionLeg {
  return { strike, bid, ask, last, lastTradeSec };
}

/** A chain whose straddle at strike K is `base + slope * |K - atm|`, quoted with a tight spread. */
function chain(expiry: string, strikes: number[], straddle: (k: number) => number): ExpiryQuotes {
  return {
    expiry,
    calls: strikes.map((k) => leg(k, straddle(k) / 2 - 0.05, straddle(k) / 2 + 0.05)),
    puts: strikes.map((k) => leg(k, straddle(k) / 2 - 0.05, straddle(k) / 2 + 0.05)),
  };
}

describe("implied move: leg prices", () => {
  it("takes the mid of a tight quote", () => {
    assert.deepEqual(legPrice(leg(100, 4, 4.2), 0), { price: 4.1, basis: "mid" });
  });

  it("refuses a wide or crossed quote, and a stale last trade", () => {
    assert.equal(legPrice(leg(100, 1, 4), 0), null);
    assert.equal(legPrice(leg(100, 4.2, 4), 0), null);
    assert.equal(legPrice(leg(100, null, null, 3, 1000), 2_000_000), null);
  });

  it("falls back to a last trade from the latest session", () => {
    const sec = Math.floor(THU_OPEN / 1000) + 600;
    assert.deepEqual(legPrice(leg(100, null, null, 3, sec), THU_OPEN), { price: 3, basis: "last" });
  });
});

describe("implied move: at the money straddle", () => {
  it("uses the strike at the price when there is one", () => {
    const s = atmStraddle(chain("2026-10-16", [95, 100, 105], (k) => 10 + Math.abs(k - 100)), 100, 0);
    assert.equal(s?.strike, 100);
    assert.ok(Math.abs(s!.price - 10) < 1e-9);
  });

  it("interpolates between the two strikes around the price", () => {
    const s = atmStraddle(chain("2026-10-16", [95, 100, 105], (k) => (k === 100 ? 10 : 12)), 101, 0);
    assert.equal(s?.strike, 100);
    assert.ok(Math.abs(s!.price - (0.8 * 10 + 0.2 * 12)) < 1e-9);
  });

  it("takes a one sided strike only when it is near the price", () => {
    assert.equal(atmStraddle(chain("x", [100], () => 10), 101, 0)?.strike, 100);
    assert.equal(atmStraddle(chain("x", [100], () => 10), 110, 0), null);
  });

  it("needs both legs quoted at a strike", () => {
    const q: ExpiryQuotes = { expiry: "x", calls: [leg(100, 5, 5.1)], puts: [leg(100, 0, 0)] };
    assert.equal(atmStraddle(q, 100, 0), null);
  });
});

describe("implied move: the figure", () => {
  const first = chain("2026-10-16", [95, 100, 105], () => 6);
  it("is the straddle over the price when the expiry is the report session", () => {
    const f = impliedFigure({ spot: 100, first, next: null, sessionsToFirst: 2, sessionsToNext: null, extraSessions: 0, freshSinceMs: 0 });
    assert.equal(f?.raw, 0.06);
    assert.equal(f?.move, 0.06);
    assert.equal(f?.adjusted, false);
    assert.equal(f?.basis, "mid");
  });

  it("takes the ordinary sessions out using the next expiry", () => {
    // m1 = 6% over 3 sessions (report included), m2 = 7% over 8 sessions.
    const next = chain("2026-10-23", [95, 100, 105], () => 7);
    const f = impliedFigure({ spot: 100, first, next, sessionsToFirst: 3, sessionsToNext: 8, extraSessions: 1, freshSinceMs: 0 });
    const w = (0.07 ** 2 - 0.06 ** 2) / 5;
    const expected = Math.sqrt(0.06 ** 2 - 2 * w);
    assert.equal(f?.adjusted, true);
    assert.ok(Math.abs(f!.move - expected) < 1e-6);
    assert.ok(f!.move < f!.raw);
  });

  it("keeps the raw move when the term structure is inverted", () => {
    const next = chain("2026-10-23", [95, 100, 105], () => 5);
    const f = impliedFigure({ spot: 100, first, next, sessionsToFirst: 3, sessionsToNext: 8, extraSessions: 1, freshSinceMs: 0 });
    assert.equal(f?.adjusted, false);
    assert.equal(f?.move, 0.06);
  });

  it("gives nothing for a raw straddle that runs far past the report", () => {
    assert.equal(impliedFigure({ spot: 100, first, next: null, sessionsToFirst: 9, sessionsToNext: null, extraSessions: 7, freshSinceMs: 0 }), null);
  });
});

describe("implied move: sessions and expiries", () => {
  it("counts today while the session is open, and the expiry day", () => {
    assert.equal(sessionsThrough(THU_NOON, "2026-10-16"), 2);
    assert.equal(sessionsThrough(THU_EVENING, "2026-10-16"), 1);
    assert.equal(sessionsThrough(SAT, "2026-10-19"), 1);
    assert.equal(sessionsAfter("2026-10-15", "2026-10-19"), 2);
  });

  it("covers an after the close report with the next session's expiry", () => {
    assert.deepEqual(reportCover("2026-10-15", "amc"), { reactionDay: "2026-10-16", coverFrom: "2026-10-16" });
    assert.deepEqual(reportCover("2026-10-15", "bmo"), { reactionDay: "2026-10-15", coverFrom: "2026-10-15" });
    // An unknown hour could be after the close.
    assert.deepEqual(reportCover("2026-10-15", "unknown"), { reactionDay: "2026-10-15", coverFrom: "2026-10-16" });
  });

  it("picks the first covering expiry and the next one within five weeks", () => {
    const list = ["2026-10-16", "2026-10-19", "2026-10-21", "2026-12-18"];
    assert.deepEqual(pickExpiries(list, "2026-10-17", "2026-10-15"), { first: "2026-10-19", next: "2026-10-21" });
    assert.deepEqual(pickExpiries(list, "2026-10-20", "2026-10-15"), { first: "2026-10-21", next: null });
    assert.equal(pickExpiries(list, "2027-01-04", "2026-10-15"), null);
  });
});

describe("implied move: snapshot clock", () => {
  it("reuses a snapshot for minutes while the session is open", () => {
    assert.equal(snapshotFreshUntil(THU_NOON), THU_NOON + 5 * 60_000);
  });

  it("holds a closed market snapshot until the next open", () => {
    assert.equal(snapshotFreshUntil(SAT), MON_OPEN);
    assert.equal(snapshotFreshUntil(THU_EVENING), Date.parse("2026-10-16T13:30:00Z"));
    assert.equal(snapshotFreshUntil(Date.parse("2026-10-15T11:00:00Z")), THU_OPEN);
  });

  it("finds the latest session open", () => {
    assert.equal(latestOpenMs(THU_NOON), THU_OPEN);
    assert.equal(latestOpenMs(SAT), Date.parse("2026-10-16T13:30:00Z"));
  });
});

describe("implied move: history", () => {
  const moves = [0.02, -0.07, 0.03, -0.09, 0.05, 0.01, -0.04, 0.08].map((move, i) => ({ date: `2024-0${i + 1}-15`, move }));

  it("counts reports that moved more and takes the median of the sizes", () => {
    const h = moveHistory(moves, 0.061);
    assert.equal(h.n, 8);
    assert.equal(h.above, 3);
    assert.equal(h.median, 0.045);
    assert.equal(h.from, "2024-01-15");
    assert.equal(h.to, "2024-08-15");
  });

  it("draws no comparison under four reports, but keeps the sample size", () => {
    const h = moveHistory(moves.slice(0, 3), 0.05);
    assert.deepEqual([h.n, h.above, h.median], [3, null, null]);
  });

  it("uses the newest twelve", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ date: `20${10 + i}-03-01`, move: i < 3 ? 0.5 : 0.01 }));
    const h = moveHistory(many, 0.1);
    assert.equal(h.n, 12);
    assert.equal(h.above, 0);
  });

  it("median of an odd and an even list", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });
});

describe("implied move: request", () => {
  it("cleans, de-duplicates and caps", () => {
    assert.equal(parseImpliedRequest("MU"), null);
    const parsed = parseImpliedRequest([{ ticker: " mu ", date: "2026-10-21", time: "amc" }, { ticker: "MU", date: "2026-10-21", time: "nope" }, { ticker: "", date: "x" }]);
    assert.deepEqual(parsed, [{ ticker: "MU", date: "2026-10-21", time: "unknown" }]);
    const big = Array.from({ length: 60 }, (_, i) => ({ ticker: `T${i}`, date: "2026-10-21", time: "bmo" }));
    assert.equal(parseImpliedRequest(big)?.length, IMPLIED_REQUEST_CAP);
  });
});

describe("implied move: copy", () => {
  const say: Say = (key, params) => {
    let text = (area.en as Record<string, string>)[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };
  const base: ImpliedMove = {
    ticker: "MU",
    reportDate: "2026-10-21",
    reactionDay: "2026-10-22",
    spot: 931.24,
    expiry: "2026-10-23",
    nextExpiry: "2026-10-26",
    strike: 930,
    straddle: 60,
    raw: 0.0644,
    move: 0.061,
    adjusted: true,
    sessions: 7,
    basis: "mid",
    quotedAt: "2026-10-15T16:00:00.000Z",
    history: { n: 8, above: 3, median: 0.048, from: "2024-09-25", to: "2026-06-24" },
  };

  it("reads as the factual sentence", () => {
    assert.equal(impliedLine(base, say, "en-US"), "Options price a move of 6.1% on this report; MU moved more than that in 3 of its last 8 reports (median 4.8%).");
    assert.equal(impliedLine({ ...base, history: { n: 2, above: null, median: null, from: null, to: null } }, say, "en-US"), "Options price a move of 6.1% on this report. Past report moves on record: 2, too few to compare.");
    assert.equal(impliedLine({ ...base, history: { n: 0, above: null, median: null, from: null, to: null } }, say, "en-US"), "Options price a move of 6.1% on this report.");
  });

  it("says how the figure was read", () => {
    const hint = impliedHint(base, say, "en-US");
    assert.match(hint, /straddle of the Oct 23 expiry, strike 930\.00, mid quotes, against a share price of 931\.24/);
    assert.match(hint, /prices 6\.4% to expiry; the ordinary move of the other 6 sessions, read from the Oct 26 expiry/);
    assert.match(hint, /last 8 reports, close to close, Sep 2024 to Jun 2026/);
  });

  it("the English lines follow the copy rules, risk words included", () => {
    const problems = Object.entries(area.en).flatMap(([key, text]) => textProblems(text, { riskWords: true }).map((p) => `${key}: ${p}`));
    assert.deepEqual(problems, []);
  });

  it("every language has every line, keeps the placeholders, and uses no dashes", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const lang of ["tr", "de", "fr", "es", "it", "ptBR", "ja", "zhCN", "ko"] as const) {
      const table = area[lang] as Record<string, string | undefined>;
      for (const [key, text] of Object.entries(area.en)) {
        const tr = table[key];
        assert.ok(tr, `${lang} ${key} missing`);
        assert.equal(placeholders(tr!), placeholders(text), `${lang} ${key}`);
        assert.ok(!/[‒–—―－〜～⸺⸻]/.test(tr!), `${lang} ${key} has a dash`);
        assert.ok(!/[!！]/.test(tr!), `${lang} ${key} has an exclamation mark`);
      }
    }
  });
});
