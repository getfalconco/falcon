import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  providerGateStats,
  RateLimitWaitError,
  resetProviderGate,
  setProviderConcurrency,
  withProviderSlot,
} from "./providerGate.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

const ENV = [
  "FALCON_PROVIDER_CONCURRENCY",
  "FALCON_PROVIDER_RPM",
  "FALCON_PROVIDER_MAX_WAIT_MS",
  "FALCON_OPENROUTER_KEY",
  "FALCON_OPENROUTER_ENGINES",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
];

beforeEach(() => resetProviderGate());
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  resetProviderGate();
});

describe("concurrency", () => {
  it("never lets more than the limit run at once", async () => {
    setProviderConcurrency(3);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withProviderSlot("propagation", async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight -= 1;
        }),
      ),
    );
    // Eight hosts asking at once still means three calls out.
    assert.ok(peak <= 3, `peak was ${peak}`);
    assert.equal(providerGateStats().admitted, 20);
  });

  it("frees the slot when a call throws", async () => {
    // A failing call that kept its slot would deadlock after `limit` failures,
    // which is exactly what a retry storm produces.
    setProviderConcurrency(1);
    await assert.rejects(
      withProviderSlot("propagation", async () => {
        throw new Error("boom");
      }),
    );
    let ran = false;
    await withProviderSlot("propagation", async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(providerGateStats().active, 0);
  });

  it("returns the call's value untouched", async () => {
    assert.equal(
      await withProviderSlot("propagation", async () => "verdict"),
      "verdict",
    );
  });
});

describe("rate limiting", () => {
  it("holds a per-minute ceiling that concurrency alone cannot", async () => {
    // The reason this exists: one call in flight at a time still starts sixty a
    // minute if each takes a second. Concurrency does not bound a rate.
    process.env.FALCON_PROVIDER_RPM = "3";
    process.env.FALCON_PROVIDER_MAX_WAIT_MS = "50";
    resetProviderGate();
    setProviderConcurrency(5);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => withProviderSlot("propagation", async () => "ok")),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof RateLimitWaitError,
    ).length;

    // Three fit in the window; the rest hit the ceiling and gave up rather than
    // silently exceeding it.
    assert.equal(ok, 3);
    assert.equal(refused, 3);
  });

  it("gives up rather than hanging when the queue outlasts the window", async () => {
    // A queue with no ceiling turns a rate limit into a hang: after a restart
    // the backlog would sit for twenty minutes behind a timeout that already
    // fired. Failing at the gate is recoverable; hanging is not.
    process.env.FALCON_PROVIDER_RPM = "1";
    process.env.FALCON_PROVIDER_MAX_WAIT_MS = "40";
    resetProviderGate();

    await withProviderSlot("propagation", async () => "first");
    await assert.rejects(
      withProviderSlot("propagation", async () => "second"),
      RateLimitWaitError,
    );
    assert.equal(providerGateStats().rate_waits, 1);
  });

  it("counts the two routes separately, so a free key cannot throttle Claude", async () => {
    process.env.FALCON_OPENROUTER_KEY = "sk-or-test";
    process.env.FALCON_OPENROUTER_ENGINES = "classifier";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.FALCON_PROVIDER_RPM = "1";
    process.env.FALCON_PROVIDER_MAX_WAIT_MS = "40";
    resetProviderGate();

    // One call on each route: both succeed, because the windows are per host.
    await withProviderSlot("classifier", async () => "free");
    await withProviderSlot("propagation", async () => "claude");

    const hosts = providerGateStats().hosts;
    assert.ok(hosts["openrouter.ai"], "openrouter window missing");
    assert.ok(hosts["api.anthropic.com"], "anthropic window missing");
    assert.equal(hosts["openrouter.ai"]!.rpm, 1);
    assert.equal(hosts["api.anthropic.com"]!.rpm, 1);
  });

  it("defaults OpenRouter below its published 20/min", async () => {
    process.env.FALCON_OPENROUTER_KEY = "sk-or-test";
    process.env.FALCON_OPENROUTER_ENGINES = "classifier";
    resetProviderGate();
    await withProviderSlot("classifier", async () => "ok");
    // Set at the provider's exact limit, one clock-skew trips it.
    assert.equal(providerGateStats().hosts["openrouter.ai"]!.limit, 18);
  });

  it("leaves Claude effectively open", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    resetProviderGate();
    await withProviderSlot("propagation", async () => "ok");
    assert.ok(providerGateStats().hosts["api.anthropic.com"]!.limit >= 600);
  });
});
