import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { GuidanceTrack } from "../../shared/guidance-types";
import { GUIDANCE_EXTRACT_VERSION } from "./guidance-extract";
import { guidancePeekAnswer } from "./guidance-peek";
import { createGuidanceService, type GuidanceService } from "./guidance-service";

const TRACK: GuidanceTrack = { ticker: "NVDA", releases: 1, latest: "2026-08-26", rows: [], patterns: [] };

/** A service whose `peek` answers `track` and whose `track` fails the test if it is ever asked. */
function stub(track: GuidanceTrack | null = TRACK) {
  const peeked: string[] = [];
  let tracked = 0;
  const service: GuidanceService = {
    peek: (ticker) => {
      peeked.push(ticker);
      return track;
    },
    track: async () => {
      tracked++;
      throw new Error("the peek channel must never start a full read");
    },
  };
  return { service, peeked, tracked: () => tracked };
}

describe("stocktab:guidancePeek", () => {
  it("refuses anything that is not a ticker, without asking the service", () => {
    for (const bad of [undefined, null, 42, "", "   ", "not a ticker!", "TOO-LONG-FOR-A-TICKER", { ticker: "NVDA" }, ["NVDA"]]) {
      const { service, peeked, tracked } = stub();
      assert.deepEqual(guidancePeekAnswer(bad, service), { ok: false, error: "invalid_request" }, String(bad));
      assert.deepEqual(peeked, []);
      assert.equal(tracked(), 0);
    }
  });

  it("peeks the cleaned ticker and never calls track", () => {
    const { service, peeked, tracked } = stub();
    assert.deepEqual(guidancePeekAnswer(" nvda ", service), { ok: true, track: TRACK });
    assert.deepEqual(peeked, ["NVDA"]);
    assert.equal(tracked(), 0);
  });

  it("answers a null track when nothing is kept on disk", () => {
    const { service, tracked } = stub(null);
    assert.deepEqual(guidancePeekAnswer("AAPL", service), { ok: true, track: null });
    assert.equal(tracked(), 0);
  });

  it("answers unavailable when the disk read throws", () => {
    const service: Pick<GuidanceService, "peek"> = {
      peek: () => {
        throw new Error("disk gone");
      },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(guidancePeekAnswer("NVDA", service), { ok: false, error: "unavailable" });
    } finally {
      console.warn = warn;
    }
  });

  it("on a real service, answers from disk with no EDGAR read and no model call", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-peek-"));
    const accession = "0001-26-000001";
    const release = { accession, filedAt: "2026-08-26", url: "https://www.sec.gov/x", reported: { fy: 2027, fq: 2 }, guides: [], actuals: [] };
    fs.writeFileSync(path.join(dir, `${accession}.json`), JSON.stringify({ version: GUIDANCE_EXTRACT_VERSION, model: "m", release }));
    fs.mkdirSync(path.join(dir, "tickers"));
    fs.writeFileSync(path.join(dir, "tickers", "NVDA.json"), JSON.stringify({ ticker: "NVDA", at: "2026-09-01T00:00:00Z", accessions: [accession] }));
    let asked = 0;
    const fail = async (): Promise<never> => {
      asked++;
      throw new Error("no EDGAR read or model call expected");
    };
    const service = createGuidanceService({ filings: fail, file: fail, caller: fail, configured: () => true, dir });
    let tracked = 0;
    const real = service.track;
    service.track = (...args) => {
      tracked++;
      return real(...args);
    };

    const answer = guidancePeekAnswer("nvda", service);
    assert.ok(answer.ok);
    assert.equal(answer.track?.ticker, "NVDA");
    assert.equal(answer.track?.releases, 1);
    assert.equal(tracked, 0);
    assert.equal(asked, 0);
    // Nothing kept for another company: null, still without asking anyone.
    assert.deepEqual(guidancePeekAnswer("AAPL", service), { ok: true, track: null });
    assert.equal(asked, 0);
  });
});
