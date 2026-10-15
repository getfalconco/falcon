import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEnginesOverview, engineEndpoint, workerEndpoint, type OverviewContext } from "./engines-overview";

const CTX: OverviewContext = {
  packaged: false,
  providerProxy: false,
  signedIn: true,
  sessionSupabaseUrl: null,
  defaults: {
    engineUrl: "https://engine.getfalcon.co",
    workerUrl: "https://worker.getfalcon.co",
    openRouterBaseUrl: "https://openrouter.ai/api/v1",
    finnhubBaseUrl: "https://finnhub.io/api/v1",
  },
  models: { gloss: "g-model", insight: "i-model", briefing: "b-model", agents: "a-model", step1: ["s1", "s1", "s2"] },
};

describe("engine endpoint", () => {
  it("reads unset as the default service and empty as off", () => {
    assert.deepEqual(engineEndpoint({}, CTX.defaults.engineUrl), { url: "https://engine.getfalcon.co", source: "default" });
    assert.deepEqual(engineEndpoint({ FALCON_ENGINE_URL: "  " }, CTX.defaults.engineUrl), { url: null, source: "off" });
    assert.deepEqual(engineEndpoint({ FALCON_ENGINE_URL: "http://localhost:8080/" }, CTX.defaults.engineUrl), {
      url: "http://localhost:8080",
      source: "env",
    });
  });

  it("reports the packaged worker default as the default", () => {
    assert.deepEqual(workerEndpoint({ RESEARCH_WORKER_URL: "https://worker.getfalcon.co/" }, CTX.defaults.workerUrl), {
      url: "https://worker.getfalcon.co",
      source: "default",
    });
    assert.deepEqual(workerEndpoint({}, CTX.defaults.workerUrl), { url: null, source: "off" });
  });
});

describe("engines overview", () => {
  it("reports key presence, never a value", () => {
    const secret = "sk-ant-should-never-leave-main";
    const overview = buildEnginesOverview(
      { ANTHROPIC_API_KEY: secret, ANTHROPIC_BASE_URL: "https://gateway.example.com/v1?token=abc", FINNHUB_API_KEY: "" },
      CTX,
    );
    const anthropic = overview.providers.find((p) => p.id === "anthropic");
    const finnhub = overview.providers.find((p) => p.id === "finnhub");
    assert.equal(anthropic?.configured, true);
    assert.equal(anthropic?.host, "gateway.example.com");
    assert.equal(finnhub?.configured, false);
    const wire = JSON.stringify(overview);
    assert.ok(!wire.includes(secret));
    assert.ok(!wire.includes("token=abc"));
  });

  it("shows the official Claude API when no base URL override is set", () => {
    const overview = buildEnginesOverview({ ANTHROPIC_API_KEY: "sk-ant-x" }, CTX);
    assert.equal(overview.providers.find((p) => p.id === "anthropic")?.host, "api.anthropic.com");
  });

  it("lists the agents model among the ones this app calls", () => {
    const agents = buildEnginesOverview({}, CTX).localModels.find((m) => m.id === "agents");
    assert.deepEqual(agents, { id: "agents", label: "Agents", model: "a-model", where: "this app" });
  });

  it("lists OpenRouter only when engines are routed to it", () => {
    assert.ok(!buildEnginesOverview({}, CTX).providers.some((p) => p.id === "openrouter"));
    const routed = buildEnginesOverview({ FALCON_OPENROUTER_ENGINES: "classifier, step1" }, CTX);
    const openrouter = routed.providers.find((p) => p.id === "openrouter");
    assert.equal(openrouter?.configured, false);
    assert.equal(openrouter?.host, "openrouter.ai");
  });

  it("marks routing through the worker in proxy mode", () => {
    const overview = buildEnginesOverview({}, { ...CTX, providerProxy: true, packaged: true });
    assert.equal(overview.providerMode, "proxy");
    assert.equal(overview.providers.find((p) => p.id === "anthropic")?.route, "worker");
  });

  it("names step-1 models only when step 1 runs here", () => {
    const local = buildEnginesOverview({}, CTX).localModels.find((m) => m.id === "step1");
    assert.deepEqual(local, { id: "step1", label: "Step-1 relationship graphs", model: "s1 · s2", where: "this app" });
    const remote = buildEnginesOverview({ RESEARCH_WORKER_URL: "https://w.example" }, CTX).localModels.find(
      (m) => m.id === "step1",
    );
    assert.equal(remote?.model, null);
    assert.equal(remote?.where, "research worker");
  });

  it("lets FALCON_BRIEFING_MODEL name the briefing model", () => {
    const overview = buildEnginesOverview({ FALCON_BRIEFING_MODEL: "custom" }, CTX);
    assert.equal(overview.localModels.find((m) => m.id === "briefing")?.model, "custom");
  });

  it("flags a deliberate local chain", () => {
    assert.equal(buildEnginesOverview({ FALCON_ENGINE_URL: "", FALCON_LOCAL_CHAIN: "1" }, CTX).engine.localChain, true);
    assert.equal(buildEnginesOverview({ FALCON_LOCAL_CHAIN: "1" }, CTX).engine.localChain, false);
  });
});
