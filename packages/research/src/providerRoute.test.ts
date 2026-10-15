import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ANTHROPIC_API_BASE_URL } from "./anthropicModels.js";
import { OPENROUTER_BASE_URL, keyBrokenForRoute, providerRouteFor, providerRouteSummary } from "./providerRoute.js";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "FALCON_OPENROUTER_KEY",
  "FALCON_OPENROUTER_BASE_URL",
  "FALCON_OPENROUTER_ENGINES",
  "FALCON_CLASSIFIER_API_KEY",
  "FALCON_CLASSIFIER_BASE_URL",
];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("providerRouteFor", () => {
  it("falls back to the global pair, so an unconfigured engine behaves as before", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-global";
    process.env.ANTHROPIC_BASE_URL = "https://gw.example.com";
    const r = providerRouteFor("propagation");
    assert.equal(r.apiKey, "sk-ant-global");
    assert.equal(r.baseUrl, "https://gw.example.com");
    assert.equal(r.source, "global");
  });

  it("goes to the official Claude API when ANTHROPIC_BASE_URL is unset", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-global";
    const r = providerRouteFor("insight");
    assert.equal(r.baseUrl, ANTHROPIC_API_BASE_URL);
    assert.equal(r.source, "global");
  });

  it("gives a per-engine key without its own URL the global URL", () => {
    process.env.FALCON_CLASSIFIER_API_KEY = "sk-ant-specific";
    assert.equal(providerRouteFor("classifier").baseUrl, ANTHROPIC_API_BASE_URL);
    process.env.ANTHROPIC_BASE_URL = "https://gw.example.com/";
    assert.equal(providerRouteFor("classifier").baseUrl, "https://gw.example.com");
  });

  it("routes only the engines named in the list", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-global";
    process.env.FALCON_OPENROUTER_KEY = "sk-or-free";
    process.env.FALCON_OPENROUTER_ENGINES = "classifier,step1";

    assert.equal(providerRouteFor("classifier").apiKey, "sk-or-free");
    assert.equal(providerRouteFor("step1").apiKey, "sk-or-free");
    // The two that carry the product's reasoning stay on Claude.
    assert.equal(providerRouteFor("propagation").apiKey, "sk-ant-global");
    assert.equal(providerRouteFor("insight").apiKey, "sk-ant-global");
  });

  it("defaults OpenRouter to its Anthropic-compatible endpoint", () => {
    process.env.FALCON_OPENROUTER_KEY = "sk-or-free";
    process.env.FALCON_OPENROUTER_ENGINES = "classifier";
    assert.equal(providerRouteFor("classifier").baseUrl, OPENROUTER_BASE_URL);
  });

  it("lets a per-engine key beat the list", () => {
    process.env.FALCON_OPENROUTER_KEY = "sk-or-free";
    process.env.FALCON_OPENROUTER_ENGINES = "classifier";
    process.env.FALCON_CLASSIFIER_API_KEY = "sk-specific";
    process.env.FALCON_CLASSIFIER_BASE_URL = "https://one.example.com/";
    const r = providerRouteFor("classifier");
    assert.equal(r.apiKey, "sk-specific");
    // Trailing slash trimmed — the SDK appends its own path.
    assert.equal(r.baseUrl, "https://one.example.com");
    assert.equal(r.source, "engine-override");
  });

  it("degrades to the global route when named but keyless, rather than failing", () => {
    // A missing key should not take an engine down; it should behave as it did
    // before anyone tried to move it.
    process.env.ANTHROPIC_API_KEY = "sk-ant-global";
    process.env.FALCON_OPENROUTER_ENGINES = "classifier";
    const r = providerRouteFor("classifier");
    assert.equal(r.apiKey, "sk-ant-global");
    assert.equal(r.source, "global");
  });

  it("ignores whitespace and case in the engine list", () => {
    process.env.FALCON_OPENROUTER_KEY = "sk-or-free";
    process.env.FALCON_OPENROUTER_ENGINES = " Classifier , STEP1 ";
    assert.equal(providerRouteFor("classifier").source, "openrouter");
    assert.equal(providerRouteFor("step1").source, "openrouter");
  });
});

describe("providerRouteSummary", () => {
  it("reports hosts, never keys", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value";
    process.env.FALCON_OPENROUTER_KEY = "sk-or-secret-value";
    process.env.FALCON_OPENROUTER_ENGINES = "classifier";
    const s = providerRouteSummary();
    assert.equal(s.classifier!.host, "openrouter.ai");
    assert.equal(s.propagation!.host, "api.anthropic.com");
    const dumped = JSON.stringify(s);
    assert.ok(!dumped.includes("secret-value"), "summary must not leak keys");
  });
});

describe("keyBrokenForRoute", () => {
  it("flags only a non sk-ant- key sent to the official API", () => {
    assert.equal(keyBrokenForRoute("eyJhbGciOi.session", ANTHROPIC_API_BASE_URL), true);
    assert.equal(keyBrokenForRoute("sk-ant-api03-x", ANTHROPIC_API_BASE_URL), false);
    // A gateway or the worker proxy takes keys of any shape.
    assert.equal(keyBrokenForRoute("eyJhbGciOi.session", "https://worker.example.com/api/anthropic"), false);
    assert.equal(keyBrokenForRoute("sk-ant-gateway", "https://gw.example.com"), false);
    assert.equal(keyBrokenForRoute("", ANTHROPIC_API_BASE_URL), false);
  });
});
