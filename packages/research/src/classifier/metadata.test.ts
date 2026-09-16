/**
 * §15.1 — company metadata table.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CLASSIFIER_CONFIG, mergeClassifierConfig } from "./config.js";
import {
  CompanyMetadataStore,
  deriveAliases,
  isStale,
  metadataFromProfile,
  tickerContext,
  type FinnhubProfile,
} from "./metadata.js";

const NOW = "2026-08-20T00:00:00.000Z";

describe("metadata — pure helpers", () => {
  it("maps a Finnhub profile (cap in millions) to a row with the right bucket", () => {
    const row = metadataFromProfile(
      "nvda",
      { name: "NVIDIA Corp", finnhubIndustry: "Semiconductors", marketCapitalization: 4_200_000 },
      NOW,
      DEFAULT_CLASSIFIER_CONFIG,
    );
    assert.ok(row);
    assert.equal(row.ticker, "NVDA");
    assert.equal(row.market_cap_usd, 4.2e12);
    assert.equal(row.cap_bucket, "mega");
    assert.equal(row.sector, "Semiconductors");
    assert.deepEqual(row.aliases, ["NVIDIA Corp", "NVIDIA"]);
  });

  it("unknown cap → null bucket, missing name → null row", () => {
    const row = metadataFromProfile("OPK", { name: "OPKO Health Inc" }, NOW, DEFAULT_CLASSIFIER_CONFIG);
    assert.equal(row?.cap_bucket, null);
    assert.equal(metadataFromProfile("X", {}, NOW, DEFAULT_CLASSIFIER_CONFIG), null);
  });

  it("aliases strip corporate suffixes", () => {
    assert.deepEqual(deriveAliases("Meta Platforms Inc"), ["Meta Platforms Inc", "Meta Platforms"]);
    assert.deepEqual(deriveAliases("Taiwan Semiconductor Manufacturing Co Ltd"), [
      "Taiwan Semiconductor Manufacturing Co Ltd",
      "Taiwan Semiconductor Manufacturing",
    ]);
    assert.deepEqual(deriveAliases(""), []);
  });

  it("tickerContext falls back to the symbol and flags metadata_missing (§2)", () => {
    assert.deepEqual(tickerContext("opk", null), {
      ticker: "OPK",
      official_name: null,
      sector: null,
      cap_bucket: null,
      metadata_missing: true,
    });
  });

  it("staleness respects the refresh interval", () => {
    const row = metadataFromProfile("A", { name: "A Inc" }, NOW, DEFAULT_CLASSIFIER_CONFIG)!;
    assert.equal(isStale(row, "2026-08-26T00:00:00.000Z", DEFAULT_CLASSIFIER_CONFIG.metadataRefreshMs), false);
    assert.equal(isStale(row, "2026-08-27T00:00:00.000Z", DEFAULT_CLASSIFIER_CONFIG.metadataRefreshMs), true);
  });
});

describe("metadata — store", () => {
  it("seeds, persists, skips fresh rows, refreshes stale ones and records fetch failures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cls-meta-"));
    const file = path.join(dir, "company-metadata.json");
    const profiles: Record<string, FinnhubProfile | null> = {
      NVDA: { name: "NVIDIA Corp", finnhubIndustry: "Semiconductors", marketCapitalization: 4_000_000 },
      META: { name: "Meta Platforms Inc", finnhubIndustry: "Media", marketCapitalization: 1_500_000 },
      ZZZ: null,
    };
    let calls = 0;
    const fetcher = async (t: string) => {
      calls += 1;
      if (t === "BOOM") throw new Error("Finnhub HTTP 429");
      return profiles[t] ?? null;
    };
    const config = mergeClassifierConfig(null);

    const store = new CompanyMetadataStore(file, fetcher);
    const first = await store.refresh(["NVDA", "META", "ZZZ", "BOOM"], { config, now: NOW });
    assert.deepEqual(first.refreshed, ["NVDA", "META"]);
    assert.deepEqual(first.failed.map((f) => f.ticker), ["ZZZ", "BOOM"]);
    assert.equal(calls, 4);
    assert.equal(store.context("NVDA").cap_bucket, "mega");
    assert.equal(store.context("META").cap_bucket, "mega");
    assert.equal(store.context("ZZZ").metadata_missing, true);

    // A second store instance reads the persisted file.
    const reloaded = new CompanyMetadataStore(file, fetcher);
    assert.equal(reloaded.get("NVDA")?.official_name, "NVIDIA Corp");

    // Fresh rows are skipped; stale ones refreshed.
    const second = await reloaded.refresh(["NVDA"], { config, now: NOW });
    assert.deepEqual(second.skipped, ["NVDA"]);
    const later = new Date(Date.parse(NOW) + config.metadataRefreshMs + 1).toISOString();
    const third = await reloaded.refresh(["NVDA"], { config, now: later });
    assert.deepEqual(third.refreshed, ["NVDA"]);
    assert.equal(reloaded.get("NVDA")?.refreshed_at, later);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
