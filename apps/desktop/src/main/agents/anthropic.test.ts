import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { setMainLanguage } from "../i18n";
import { anthropicAgentCaller, classifyModelFailure, makeAgentCaller, readableModelError } from "./anthropic";
import { writeReply, type AgentModelCall } from "./llm";
import { agentFixture } from "./test-fakes";

/**
 * The agents' Claude caller, end to end over HTTP against a local stand-in for
 * the Messages API: the request it sends, and what the reader is told when a
 * call fails.
 *
 * The regression behind it: chat replies came back as "The model could not be
 * reached" while the route answered fine. Every status outside a short list
 * (a 400 from a gateway that does not serve the model, a rejected parameter)
 * fell through to that message, as did a 200 in another wire format, so a
 * reachable service with a good key read as a dead connection.
 */

const REACHED = "The model could not be reached";

const REPLY_CALL: AgentModelCall = {
  purpose: "reply",
  system: "You answer questions about one agent.",
  user: "What are you watching for?",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reply", "reportIds"],
    properties: { reply: { type: "string" }, reportIds: { type: "array", items: { type: "string" } } },
  },
  maxTokens: 1500,
  timeoutMs: 20_000,
};

type Answer = { status: number; body: unknown };

let server: http.Server;
let baseUrl = "";
let next: Answer = { status: 500, body: {} };
const seen: Array<Record<string, unknown>> = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "FALCON_INSIGHT_API_KEY",
  "FALCON_INSIGHT_BASE_URL",
  "FALCON_OPENROUTER_ENGINES",
  "FALCON_AGENTS_MODEL",
  "FALCON_AGENTS_DRAFT_MODEL",
  "FALCON_AGENTS_EFFORT",
];

function message(text: string): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

before(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ path: req.url, apiKey: req.headers["x-api-key"], body: JSON.parse(raw || "{}") });
      res.writeHead(next.status, { "content-type": "application/json", "request-id": "req_test" });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  process.env.ANTHROPIC_BASE_URL = baseUrl;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setMainLanguage("en-US");
});

describe("agents Claude caller", () => {
  it("sends a chat reply as the writing tier at low effort, structured, with no sampling params", async () => {
    next = { status: 200, body: message('{"reply":"Data center revenue.","reportIds":[]}') };
    seen.length = 0;
    const text = await anthropicAgentCaller(REPLY_CALL);
    assert.equal(text, '{"reply":"Data center revenue.","reportIds":[]}');
    assert.equal(seen.length, 1);
    const { path, apiKey, body } = seen[0] as { path: string; apiKey: string; body: Record<string, unknown> };
    assert.equal(path, "/v1/messages");
    assert.equal(apiKey, "sk-ant-test-not-a-real-key");
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.max_tokens, 1500);
    assert.deepEqual((body.output_config as Record<string, unknown>).effort, "low");
    assert.equal(((body.output_config as Record<string, unknown>).format as Record<string, unknown>).type, "json_schema");
    for (const banned of ["temperature", "top_p", "top_k", "thinking"]) assert.ok(!(banned in body), `${banned} must not be sent`);
  });

  it("drafts on the fast tier", async () => {
    next = { status: 200, body: message("{}") };
    seen.length = 0;
    await anthropicAgentCaller({ ...REPLY_CALL, purpose: "draft" });
    assert.equal((seen[0]!.body as Record<string, unknown>).model, "claude-haiku-5-5");
  });

  it("reads the route per call, so a changed ANTHROPIC_BASE_URL applies without a restart", async () => {
    next = { status: 200, body: message("{}") };
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9"; // nothing listens on the discard port
    await assert.rejects(anthropicAgentCaller(REPLY_CALL), (err: Error) => err.message.startsWith(REACHED));
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    seen.length = 0;
    await anthropicAgentCaller(REPLY_CALL);
    assert.equal(seen.length, 1);
  });

  it("says the request was turned down, not that the model was unreachable, on a 400", async () => {
    next = {
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "model: claude-opus-5-5 is not supported" } },
    };
    await assert.rejects(anthropicAgentCaller(REPLY_CALL), (err: Error) => {
      assert.equal(err.message, "The model service turned this request down (HTTP 400).");
      assert.ok(!err.message.includes("not supported"), "the provider's own text stays out");
      return true;
    });
  });

  it("carries the same message through a chat reply", async () => {
    next = { status: 422, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } };
    await assert.rejects(
      writeReply({ agent: agentFixture(), reports: [], history: [], freshFacts: [], question: "How did it go?" }, anthropicAgentCaller),
      /turned this request down \(HTTP 422\)/,
    );
  });

  it("tells a 200 in another wire format apart from a dead connection", async () => {
    next = { status: 200, body: { error: { code: "FAL-AI-01", message: "Upstream said no." } } };
    await assert.rejects(anthropicAgentCaller(REPLY_CALL), (err: Error) => {
      assert.equal(err.message, "The model service sent back a reply that could not be read.");
      return true;
    });
  });

  it("keeps the credentials, route, busy and service messages", async () => {
    const cases: Array<[number, RegExp]> = [
      [401, /rejected the credentials/],
      [404, /claude-opus-5-5 is not available on this route/],
      [429, /busy/],
      [529, /service had an error/],
    ];
    for (const [status, expected] of cases) {
      next = { status, body: { type: "error", error: { type: "x", message: "x" } } };
      await assert.rejects(anthropicAgentCaller(REPLY_CALL), expected, `HTTP ${status}`);
    }
  });

  it("speaks the reader's language", async () => {
    setMainLanguage("tr-TR");
    try {
      next = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "x" } } };
      await assert.rejects(anthropicAgentCaller(REPLY_CALL), /Model hizmeti bu isteği geri çevirdi \(HTTP 400\)/);
    } finally {
      setMainLanguage("en-US");
    }
  });
});

describe("classifyModelFailure", () => {
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends Error {}

  it("keeps network failures as network failures", () => {
    assert.equal(classifyModelFailure(new APIConnectionError("Connection error.")), "network");
    const dns = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) });
    assert.equal(classifyModelFailure(dns), "network");
  });

  it("sorts timeouts, refusals, length and configuration", () => {
    assert.equal(classifyModelFailure(new APIConnectionTimeoutError("Request timed out.")), "timeout");
    assert.equal(classifyModelFailure(new Error("Request was aborted.")), "timeout");
    assert.equal(classifyModelFailure(new Error("the model declined to explain this selection")), "declined");
    assert.equal(classifyModelFailure(new Error("the explanation ran long, try a shorter selection")), "length");
    assert.equal(classifyModelFailure(new Error("ANTHROPIC_API_KEY is not configured")), "notConfigured");
  });

  it("never calls an unknown error a connection failure", () => {
    assert.equal(classifyModelFailure(new RangeError("something else")), "failed");
    assert.equal(readableModelError(new RangeError("x"), "m").message, "The model call failed for an unexpected reason.");
  });
});

describe("makeAgentCaller", () => {
  it("passes the call through to the injected Claude call", async () => {
    const inputs: unknown[] = [];
    const caller = makeAgentCaller(async (input) => {
      inputs.push(input);
      return { text: "{}", input_tokens: 1, output_tokens: 1 };
    });
    assert.equal(await caller(REPLY_CALL), "{}");
    assert.deepEqual(inputs[0], {
      model: "claude-opus-5-5",
      max_tokens: 1500,
      effort: "low",
      system: REPLY_CALL.system,
      user: REPLY_CALL.user,
      output_schema: REPLY_CALL.schema,
      timeout_ms: REPLY_CALL.timeoutMs,
    });
  });
});
