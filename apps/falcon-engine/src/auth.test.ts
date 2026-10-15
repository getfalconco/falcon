import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { authenticate, checkServiceToken, clearAuthCache } from "./auth.js";

const ALICE = "11111111-1111-4111-8111-111111111111";

type FakeUser = { id: string; email: string; app_metadata: Record<string, unknown> };
const TOKENS: Record<string, FakeUser> = {
  "alice-approved": { id: ALICE, email: "a@example.com", app_metadata: { approved: true } },
  // Approval only counts from app_metadata; a self-written user_metadata flag must not.
  "bob-unapproved": { id: "22222222-2222-4222-8222-222222222222", email: "b@example.com", app_metadata: {} },
  "carol-deputy": { id: "33333333-3333-4333-8333-333333333333", email: "c@example.com", app_metadata: { approved: true, role: "Deputy" } },
};

const realFetch = globalThis.fetch;
const seen: string[] = [];

beforeEach(() => {
  clearAuthCache();
  seen.length = 0;
  process.env.SUPABASE_URL = "https://project.supabase.test";
  process.env.SUPABASE_ANON_KEY = "anon";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    assert.equal(url, "https://project.supabase.test/auth/v1/user");
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const user = TOKENS[auth.replace(/^Bearer /, "")];
    if (!user) return new Response(JSON.stringify({ msg: "invalid JWT" }), { status: 401 });
    // A self-written user_metadata role must never count either.
    return new Response(JSON.stringify({ ...user, user_metadata: { approved: true, role: "staff" } }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} });

describe("engine auth", () => {
  it("rejects a request with no bearer token without calling Supabase", async () => {
    assert.deepEqual(await authenticate(req()), { ok: false, status: 401, error: "Sign in required." });
    assert.deepEqual(await authenticate(req("Basic abc")), { ok: false, status: 401, error: "Sign in required." });
    assert.equal(seen.length, 0);
  });

  it("rejects a token Supabase does not recognise", async () => {
    const out = await authenticate(req("Bearer forged.jwt.value"));
    assert.deepEqual(out, { ok: false, status: 401, error: "Session expired or invalid." });
  });

  it("identifies the user from Supabase's answer, not from anything the caller sends", async () => {
    const out = await authenticate({
      headers: { authorization: "Bearer alice-approved", "x-user-id": "22222222-2222-4222-8222-222222222222" },
    });
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.user.id, ALICE);
  });

  it("refuses an unapproved user on approved routes but accepts them for self-service deletion", async () => {
    assert.deepEqual(await authenticate(req("Bearer bob-unapproved")), {
      ok: false,
      status: 403,
      error: "This account is not approved yet.",
    });
    const self = await authenticate(req("Bearer bob-unapproved"), { approved: false });
    assert.equal(self.ok, true);
  });

  it("reads staff from the app_metadata role only", async () => {
    const carol = await authenticate(req("Bearer carol-deputy"));
    assert.equal(carol.ok && carol.user.staff, true);
    const alice = await authenticate(req("Bearer alice-approved"));
    assert.equal(alice.ok, true);
    assert.equal(alice.ok && alice.user.staff, false, "a user_metadata role made a member staff");
  });

  it("rejects everything when Supabase is not configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    const out = await authenticate(req("Bearer alice-approved"));
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.status, 401);
  });
});

describe("engine service credential (account-deletion retries)", () => {
  const SECRET = "s".repeat(48);

  it("is off (503) when FALCON_ENGINE_SERVICE_TOKEN is unset or too short", () => {
    delete process.env.FALCON_ENGINE_SERVICE_TOKEN;
    assert.equal(checkServiceToken(req(`Bearer ${SECRET}`)).ok, false);
    assert.deepEqual(checkServiceToken(req(`Bearer ${SECRET}`)), { ok: false, status: 503, error: "Service access is not configured." });
    process.env.FALCON_ENGINE_SERVICE_TOKEN = "short";
    assert.equal(checkServiceToken(req("Bearer short")).ok, false);
  });

  it("rejects a missing or wrong credential, including a user's JWT", () => {
    process.env.FALCON_ENGINE_SERVICE_TOKEN = SECRET;
    for (const header of [undefined, "Bearer wrong", "Bearer alice-approved", `Bearer ${SECRET}x`]) {
      const out = checkServiceToken(req(header));
      assert.equal(out.ok, false, String(header));
      assert.equal(!out.ok && out.status, 401);
    }
  });

  it("accepts the configured credential", () => {
    process.env.FALCON_ENGINE_SERVICE_TOKEN = SECRET;
    assert.deepEqual(checkServiceToken(req(`Bearer ${SECRET}`)), { ok: true });
    delete process.env.FALCON_ENGINE_SERVICE_TOKEN;
  });
});
