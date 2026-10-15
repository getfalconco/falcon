import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { setRendererSession } from "../session-bridge";
import {
  NO_MEMBERSHIP,
  getOwnMembership,
  normalizeMembership,
  requestOwnMembership,
  resetMembershipCacheForTests,
} from "./membership";

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

const TICKET = {
  found: true,
  name: "Kuzey",
  memberNumber: 7,
  grantedAt: "2026-05-01T00:00:00Z",
  approved: false,
};

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("waitlist membership", () => {
  beforeEach(() => {
    resetMembershipCacheForTests();
    setRendererSession({ accessToken: null });
  });

  it("asks /api/waitlist/me with the bearer token and never sends an email", async () => {
    const calls: Call[] = [];
    const result = await requestOwnMembership(["https://site.test"], "tok-1", fakeFetch([ok(TICKET)], calls));
    assert.deepEqual(result, TICKET);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://site.test/api/waitlist/me");
    assert.ok(!calls[0].url.includes("?"));
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer tok-1");
  });

  it("stops at a 401 and falls through other failures to the next base", async () => {
    const calls: Call[] = [];
    const denied = await requestOwnMembership(
      ["https://a.test", "https://b.test"],
      "tok",
      fakeFetch([new Response("{}", { status: 401 })], calls),
    );
    assert.deepEqual(denied, NO_MEMBERSHIP);
    assert.equal(calls.length, 1);

    const fallback = await requestOwnMembership(
      ["https://a.test", "https://b.test"],
      "tok",
      fakeFetch([new Error("offline"), ok(TICKET)]),
    );
    assert.deepEqual(fallback, TICKET);

    const none = await requestOwnMembership(["https://a.test"], "tok", fakeFetch([new Response("", { status: 500 })]));
    assert.equal(none, null);
  });

  it("keeps only the expected fields", () => {
    assert.deepEqual(normalizeMembership({ ...TICKET, email: "x@y.com", phone: "1" }), TICKET);
    assert.deepEqual(normalizeMembership({ found: false, name: "Someone" }), NO_MEMBERSHIP);
    assert.deepEqual(normalizeMembership(null), NO_MEMBERSHIP);
  });

  it("without a token makes no request and returns nothing", async () => {
    const calls: Call[] = [];
    const result = await getOwnMembership(["https://site.test"], fakeFetch([], calls));
    assert.deepEqual(result, NO_MEMBERSHIP);
    assert.equal(calls.length, 0);
  });

  it("keeps the ticket read before sign-out for the waitlist screen", async () => {
    setRendererSession({ accessToken: "tok-a" });
    assert.deepEqual(await getOwnMembership(["https://site.test"], fakeFetch([ok(TICKET)])), TICKET);

    setRendererSession({ accessToken: null });
    const calls: Call[] = [];
    assert.deepEqual(await getOwnMembership(["https://site.test"], fakeFetch([], calls)), TICKET);
    assert.equal(calls.length, 0);
  });

  it("forgets the previous account's ticket when a different token arrives", async () => {
    setRendererSession({ accessToken: "tok-a" });
    await getOwnMembership(["https://site.test"], fakeFetch([ok(TICKET)]));

    setRendererSession({ accessToken: "tok-b" });
    setRendererSession({ accessToken: null });
    assert.deepEqual(await getOwnMembership(["https://site.test"], fakeFetch([])), NO_MEMBERSHIP);
  });
});
