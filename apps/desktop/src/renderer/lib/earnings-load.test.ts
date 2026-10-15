import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EarningsRequest, EarningsResult, EarningsRow } from "../../shared/earnings-types";
import { isMissingHandler, loadEarnings, type EarningsAsk } from "./earnings-load";

const REQUEST: EarningsRequest = { scope: "foryou", days: 28, held: ["NVDA"], watchlist: ["XOM"], sectors: ["Technology"] };

/** A row as a main process from before "For you" sends it: no reason, no market value. */
function oldRow(ticker: string, held: boolean, watchlist: boolean): EarningsRow {
  const row = {
    ticker,
    company: null,
    date: "2026-10-21",
    windowEnd: null,
    time: "amc",
    status: "confirmed",
    phase: "upcoming",
    releasedAt: null,
    fiscalPeriod: null,
    epsEstimate: null,
    epsActual: null,
    epsCurrency: null,
    consensus: null,
    revenueEstimate: null,
    revenueActual: null,
    revenueCurrency: null,
    revenueEstimateUsd: null,
    revenueActualUsd: null,
    fx: null,
    source: "yahoo",
    lastSurprise: null,
    sector: null,
    held,
    watchlist,
    tracked: false,
    readsThrough: [],
  };
  return row as unknown as EarningsRow;
}

function answer(scope: "mine" | "foryou", rows: EarningsRow[]): EarningsResult {
  return {
    ok: true,
    scope,
    from: "2026-10-12",
    to: "2026-11-08",
    today: "2026-10-15",
    rows,
    builtAt: "2026-10-15T14:00:00.000Z",
    scopes: { tracked: true, all: true },
    unavailable: [],
    marketCalendar: "fresh",
  };
}

/**
 * A main process started before "For you" existed: its parser knows mine,
 * tracked and all, and turns anything else down as an invalid request.
 */
function olderMain(): { ask: EarningsAsk; asked: EarningsRequest[] } {
  const asked: EarningsRequest[] = [];
  const ask: EarningsAsk = async (req) => {
    asked.push(req);
    if (req.scope !== "mine" && req.scope !== "tracked" && req.scope !== "all") return { ok: false, error: "invalid_request" };
    return answer("mine", [oldRow("NVDA", true, false), oldRow("XOM", false, true)]);
  };
  return { ask, asked };
}

describe("loading earnings across a main process older than the view", () => {
  it("a 'For you' request turned down by an older main falls back to the reader's names, marked for a restart", async () => {
    const { ask, asked } = olderMain();
    const res = await loadEarnings(ask, REQUEST);
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.deepEqual(
      asked.map((r) => r.scope),
      ["foryou", "mine"],
    );
    assert.deepEqual(asked[1], { scope: "mine", days: 28, held: ["NVDA"], watchlist: ["XOM"] });
    assert.equal(res.value.outdatedMain, true);
    assert.equal(res.value.scope, "foryou");
    assert.deepEqual(
      res.value.rows.map((r) => [r.ticker, r.reason, r.marketCap]),
      [
        ["NVDA", "held", null],
        ["XOM", "watchlist", null],
      ],
    );
    assert.deepEqual(res.value.degraded, []);
  });

  it("an older main turning down the fallback too reads as 'restart', not a load failure", async () => {
    const ask: EarningsAsk = async () => ({ ok: false, error: "invalid_request" });
    assert.deepEqual(await loadEarnings(ask, REQUEST), { ok: false, error: "restart" });
    assert.deepEqual(await loadEarnings(ask, { ...REQUEST, scope: "mine" }), { ok: false, error: "restart" });
  });

  it("a main process with no handler for the channel reads as 'restart'", async () => {
    const ask: EarningsAsk = async () => {
      throw new Error("Error invoking remote method 'earnings:upcoming': Error: No handler registered for 'earnings:upcoming'");
    };
    assert.deepEqual(await loadEarnings(ask, REQUEST), { ok: false, error: "restart" });
    assert.deepEqual(await loadEarnings(undefined, REQUEST), { ok: false, error: "restart" });
    assert.equal(isMissingHandler(new Error("socket hang up")), false);
  });

  it("a current main's answer passes through untouched apart from defaults", async () => {
    const ask: EarningsAsk = async () => answer("foryou", [{ ...oldRow("NVDA", true, false), reason: "held", marketCap: 4e12 }]);
    const res = await loadEarnings(ask, REQUEST);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.outdatedMain, undefined);
    assert.deepEqual(res.value.rows.map((r) => [r.reason, r.marketCap]), [["held", 4e12]]);
  });

  it("main's own failures keep their codes", async () => {
    for (const error of ["unavailable", "scope_unavailable"] as const) {
      const ask: EarningsAsk = async () => ({ ok: false, error });
      assert.deepEqual(await loadEarnings(ask, REQUEST), { ok: false, error });
    }
    const throws: EarningsAsk = async () => {
      throw new Error("socket hang up");
    };
    assert.deepEqual(await loadEarnings(throws, REQUEST), { ok: false, error: "unavailable" });
  });
});
