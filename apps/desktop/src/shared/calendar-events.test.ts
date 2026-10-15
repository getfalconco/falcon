import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  CORPORATE_SYMBOL_CAP,
  normalizeSector,
  normalizeTicker,
  parseCorporateRequest,
  readStoredUserEvent,
  validateUserEventInput,
} from "./calendar-events";
import { EM_DASH, EN_DASH } from "./copy-rules";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const allDay = {
  title: "  Offsite \n planning ",
  all_day: true,
  date: "2026-10-12",
  end_date: "2026-10-14",
  start_at: null,
  end_at: null,
  ticker: "",
  sector: null,
  color: "teal",
  notes: "Line one\r\nLine two",
};

describe("validateUserEventInput", () => {
  it("cleans a valid all-day event", () => {
    const r = validateUserEventInput(allDay);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.title, "Offsite planning");
    assert.equal(r.value.notes, "Line one\nLine two");
    assert.equal(r.value.ticker, null);
    assert.equal(r.value.color, "teal");
  });

  it("defaults a missing end date to the start date", () => {
    const r = validateUserEventInput({ ...allDay, end_date: null });
    assert.equal(r.ok && r.value.end_date, "2026-10-12");
  });

  it("refuses impossible and reversed dates", () => {
    assert.equal(validateUserEventInput({ ...allDay, date: "2026-02-30" }).ok, false);
    assert.deepEqual(validateUserEventInput({ ...allDay, end_date: "2026-10-11" }), {
      ok: false,
      error: "The event ends before it starts.",
      code: "endsBeforeStart",
    });
    assert.deepEqual(validateUserEventInput({ ...allDay, title: "x".repeat(200) }), {
      ok: false,
      error: "Keep the title under 120 characters.",
      code: "titleTooLong",
      params: { max: 120 },
    });
    assert.equal(validateUserEventInput({ ...allDay, end_date: "2027-10-13" }).ok, false);
  });

  it("checks timed events by their instants", () => {
    const base = { ...allDay, all_day: false, date: null, end_date: null };
    assert.equal(validateUserEventInput({ ...base, start_at: "2026-10-12T13:00:00Z", end_at: "2026-10-12T14:00:00Z" }).ok, true);
    assert.equal(validateUserEventInput({ ...base, start_at: "2026-10-12T13:00:00Z", end_at: "2026-10-12T13:00:00Z" }).ok, false);
    assert.equal(validateUserEventInput({ ...base, start_at: "2026-10-12T13:00:00Z", end_at: "2026-10-14T13:00:00Z" }).ok, false);
    assert.equal(validateUserEventInput({ ...base, start_at: "yesterday", end_at: "2026-10-12T14:00:00Z" }).ok, false);
  });

  it("refuses bad titles, tickers, sectors and oversized notes", () => {
    assert.equal(validateUserEventInput({ ...allDay, title: "   " }).ok, false);
    assert.equal(validateUserEventInput({ ...allDay, title: "x".repeat(121) }).ok, false);
    assert.equal(validateUserEventInput({ ...allDay, ticker: "not a ticker" }).ok, false);
    assert.equal(validateUserEventInput({ ...allDay, sector: "Crypto" }).ok, false);
    assert.equal(validateUserEventInput({ ...allDay, notes: "n".repeat(2001) }).ok, false);
    assert.equal(validateUserEventInput(null).ok, false);
    assert.equal(validateUserEventInput([]).ok, false);
  });

  it("falls back to blue for an unknown colour", () => {
    const r = validateUserEventInput({ ...allDay, color: "chartreuse" });
    assert.equal(r.ok && r.value.color, "blue");
  });
});

describe("readStoredUserEvent", () => {
  it("needs an id of the store's own shape", () => {
    assert.equal(readStoredUserEvent({ ...allDay, id: "x" }), null);
    const e = readStoredUserEvent({ ...allDay, id: "ue_abcdef12", created_at: "2026-10-01T00:00:00Z" });
    assert.equal(e?.created_at, "2026-10-01T00:00:00.000Z");
  });
});

describe("tickers and sectors", () => {
  it("normalises tickers", () => {
    assert.equal(normalizeTicker(" brk.b "), "BRK.B");
    assert.equal(normalizeTicker("1ABC"), null);
    assert.equal(normalizeTicker(7), null);
  });

  it("maps provider sector names", () => {
    assert.equal(normalizeSector("Healthcare"), "Healthcare");
    assert.equal(normalizeSector("Consumer Defensive"), "Consumer Staples");
    assert.equal(normalizeSector("Semiconductors"), "Technology");
    assert.equal(normalizeSector("Something else"), null);
    assert.equal(normalizeSector(""), null);
  });

  it("caps and de-duplicates a corporate request", () => {
    const many = Array.from({ length: CORPORATE_SYMBOL_CAP + 5 }, (_, i) => `T${i}`);
    const parsed = parseCorporateRequest({ symbols: ["aapl", "AAPL", "bad ticker", ...many] });
    assert.equal(parsed?.symbols.length, CORPORATE_SYMBOL_CAP);
    assert.equal(parsed?.symbols[0], "AAPL");
    assert.equal(parsed?.skipped.length, 6);
    assert.equal(parseCorporateRequest({ symbols: "AAPL" }), null);
    assert.equal(parseCorporateRequest(null), null);
  });
});

describe("copy", () => {
  it("keeps long dashes out of every calendar source a reader sees", () => {
    const files = [
      path.join(HERE, "calendar-events.ts"),
      path.join(HERE, "..", "main", "calendar", "corporate-calendar.ts"),
      ...fs
        .readdirSync(path.join(HERE, "..", "renderer", "components", "calendar"))
        .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))
        .map((f) => path.join(HERE, "..", "renderer", "components", "calendar", f)),
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      assert.equal(text.includes(EM_DASH) || text.includes(EN_DASH), false, `${path.basename(file)} has a long dash`);
    }
  });
});
