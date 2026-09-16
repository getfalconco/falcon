import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildProbePayload, median, RATIO_TOLERANCE, verdictFrom } from "./token-audit.js";
import type { TokenAuditSample } from "./token-audit.js";
import { TokenAuditStore } from "./store.js";

function sample(ratio: number, over: Partial<TokenAuditSample> = {}): TokenAuditSample {
  const counted = 1000;
  const billed = Math.round(counted * ratio);
  return {
    at: "2026-08-29T00:00:00.000Z",
    host: "api.oneprovider.dev",
    model: "claude-sonnet-5",
    requestChars: 4000,
    countedInputTokens: counted,
    billedInputTokens: billed,
    billedCacheCreationTokens: 0,
    billedCacheReadTokens: 0,
    ratio,
    countedCharsPerToken: 4,
    billedCharsPerToken: 4000 / billed,
    ok: true,
    error: null,
    ...over,
  };
}

describe("verdictFrom", () => {
  it("calls honest billing honest", () => {
    const v = verdictFrom([sample(1.0), sample(1.01), sample(0.99)]);
    assert.equal(v.discrepancy, false);
    assert.ok(Math.abs(v.medianRatio! - 1) < RATIO_TOLERANCE);
  });

  it("flags the ratio actually measured against the gateway", () => {
    // count_tokens said 6,885 for the chunk step1 sends; billing said 12,025.
    const v = verdictFrom([sample(1.75), sample(1.73), sample(1.78)]);
    assert.equal(v.discrepancy, true);
    assert.ok(v.medianRatio! > 1.7);
  });

  it("uses the median so one outlier cannot manufacture an accusation", () => {
    const v = verdictFrom([sample(1.0), sample(1.0), sample(9.0)]);
    assert.equal(v.medianRatio, 1.0);
    assert.equal(v.discrepancy, false);
  });

  it("nor hide one", () => {
    const v = verdictFrom([sample(1.8), sample(1.8), sample(1.0)]);
    assert.equal(v.medianRatio, 1.8);
    assert.equal(v.discrepancy, true);
  });

  it("ignores failed probes rather than scoring them as 0", () => {
    const failed = sample(0, { ok: false, error: "timeout", countedInputTokens: 0 });
    const v = verdictFrom([sample(1.0), failed, sample(1.0)]);
    assert.equal(v.medianRatio, 1.0);
  });

  it("has no verdict with no usable samples", () => {
    const v = verdictFrom([]);
    assert.equal(v.medianRatio, null);
    assert.equal(v.discrepancy, false);
    assert.equal(v.estimatedOverchargeUsd, null);
  });

  it("prices the overcharge only when there is a discrepancy to price", () => {
    const honest = verdictFrom([sample(1.0)], {
      billedInputTokensThisPeriod: 28_380_000,
      inputUsdPerM: 3.1,
    });
    assert.equal(honest.estimatedOverchargeUsd, null);

    const inflated = verdictFrom([sample(1.75)], {
      billedInputTokensThisPeriod: 28_380_000,
      inputUsdPerM: 3.1,
    });
    // 28.38M billed at 1.75x means 16.2M was the real work: ~12.2M excess.
    assert.ok(inflated.estimatedOverchargeUsd! > 30);
    assert.ok(inflated.estimatedOverchargeUsd! < 50);
  });

  it("does not call under-billing an overcharge", () => {
    const v = verdictFrom([sample(0.5)], {
      billedInputTokensThisPeriod: 1_000_000,
      inputUsdPerM: 3,
    });
    assert.equal(v.discrepancy, true);
    assert.equal(v.estimatedOverchargeUsd, null);
  });
});

describe("median", () => {
  it("averages the middle pair on an even count", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  it("is null on empty", () => {
    assert.equal(median([]), null);
  });
});

describe("buildProbePayload", () => {
  it("measures the size step1 actually sends", () => {
    const { user } = buildProbePayload("x".repeat(50_000));
    assert.ok(user.length > 24_000);
    assert.ok(user.length < 24_500);
  });
  it("does not pad a short filing", () => {
    const { user } = buildProbePayload("short filing");
    assert.ok(user.includes("short filing"));
  });
});

describe("TokenAuditStore", () => {
  function tmpStore(retention?: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-"));
    return new TokenAuditStore(dir, retention);
  }

  it("round-trips samples newest first", () => {
    const store = tmpStore();
    store.append(sample(1.0, { at: "2026-08-01T00:00:00.000Z" }));
    store.append(sample(1.75, { at: "2026-08-02T00:00:00.000Z" }));
    const list = store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.at, "2026-08-02T00:00:00.000Z");
  });

  it("keeps the two accounts apart", () => {
    const store = tmpStore();
    store.append(sample(1.75, { host: "api.oneprovider.dev" }));
    store.append(sample(1.0, { host: "api.anthropic.com" }));
    assert.equal(store.list({ host: "api.anthropic.com" }).length, 1);
    assert.deepEqual(store.hosts(), ["api.anthropic.com", "api.oneprovider.dev"]);
  });

  it("trims to the retention window", () => {
    const store = tmpStore(3);
    for (let i = 0; i < 10; i++) store.append(sample(1 + i / 100));
    assert.equal(store.list().length, 3);
  });

  it("starts clean on a corrupt file instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-"));
    fs.writeFileSync(path.join(dir, "token-audit.json"), "{not json", "utf8");
    const store = new TokenAuditStore(dir);
    assert.deepEqual(store.list(), []);
    store.append(sample(1.0));
    assert.equal(store.list().length, 1);
  });
});
