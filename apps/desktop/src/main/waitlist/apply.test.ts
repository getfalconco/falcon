import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { submitApplication } from "./apply";

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<Response | Error>, calls: Call[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const PAYLOAD = { name: "Kuzey", email: " Kuzey@Example.com ", phone: "", application: { describes: "pro" } };

describe("waitlist apply", () => {
  it("sends the session token when there is one and keeps the signed-in member number", async () => {
    const calls: Call[] = [];
    const result = await submitApplication(
      ["https://site.test"],
      PAYLOAD,
      "tok-1",
      fakeFetch([json({ ok: true, memberNumber: 12 })], calls),
    );
    assert.deepEqual(result, { ok: true, memberNumber: 12 });
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(calls[0].url, "https://site.test/api/waitlist");
    assert.equal(headers.Authorization, "Bearer tok-1");
    assert.equal(JSON.parse(String(calls[0].init?.body)).email, "kuzey@example.com");
  });

  it("sends no Authorization header without a session and needs no status or number", async () => {
    const calls: Call[] = [];
    const result = await submitApplication(
      ["https://site.test"],
      PAYLOAD,
      null,
      fakeFetch([json({ ok: true })], calls),
    );
    assert.deepEqual(result, { ok: true, memberNumber: null });
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal("Authorization" in headers, false);
  });

  it("falls through to the next base and reports the last error", async () => {
    const calls: Call[] = [];
    const result = await submitApplication(
      ["https://a.test", "https://b.test"],
      PAYLOAD,
      null,
      fakeFetch([new Error("offline"), json({ error: "Your session has ended. Sign in again." }, 401)], calls),
    );
    assert.deepEqual(result, { ok: false, error: "Your session has ended. Sign in again." });
    assert.equal(calls.length, 2);
  });
});
