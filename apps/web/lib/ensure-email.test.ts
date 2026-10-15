// Run (web has no tsx of its own): cd apps/desktop && node --import tsx --test ../web/lib/ensure-email.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "@supabase/supabase-js";
import {
  EMAIL_LIMIT,
  GENERIC_ENSURE_EMAIL_RESPONSE,
  IP_LIMIT,
  handleEnsureEmail,
  sessionMethods,
  type EnsureEmailDeps,
} from "./ensure-email";
import { rateLimit } from "./rate-limit";

type FakeUser = {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
};

/** A JWT-shaped token whose payload carries the given amr methods. */
function tokenWith(methods: string[], tag: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: tag, amr: methods.map((method) => ({ method, timestamp: 1 })) }),
  ).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig-${tag}`;
}

let run = 0;

function makeWorld(seed: FakeUser[]) {
  const users = new Map(seed.map((u) => [u.id, structuredClone(u)]));
  const tokens = new Map<string, string>(); // token -> user id
  const calls = { confirm: 0, lookups: 0, sleeps: [] as number[] };
  let clock = 0;
  // Each world gets its own limiter keyspace, so tests don't share buckets.
  const ns = `t${run++}-`;

  const deps: EnsureEmailDeps = {
    async userFromAccessToken(token) {
      calls.lookups += 1;
      const id = tokens.get(token);
      const user = id ? users.get(id) : undefined;
      return user ? (structuredClone(user) as unknown as User) : null;
    },
    async confirmEmail(userId) {
      calls.confirm += 1;
      const user = users.get(userId);
      if (user) user.email_confirmed_at = new Date(0).toISOString();
    },
    rateLimit: (key, opts) => rateLimit(ns + key, opts),
    minAnonymousMs: 500,
    now: () => clock,
    async sleep(ms) {
      calls.sleeps.push(ms);
      clock += ms;
    },
  };

  return {
    deps,
    users,
    calls,
    issue(userId: string, methods: string[]) {
      const token = tokenWith(methods, `${userId}-${tokens.size}`);
      tokens.set(token, userId);
      return token;
    },
  };
}

const SEED: FakeUser[] = [
  // Waitlisted, never confirmed: the exact case the old route auto-confirmed.
  { id: "w1", email: "waiting@example.com", email_confirmed_at: null, user_metadata: { waitlist: true }, app_metadata: {} },
  // Approved and unconfirmed.
  { id: "a1", email: "approved@example.com", email_confirmed_at: null, user_metadata: {}, app_metadata: { approved: true } },
  // Approved and confirmed.
  { id: "c1", email: "done@example.com", email_confirmed_at: "2026-01-01T00:00:00Z", user_metadata: {}, app_metadata: { approved: true } },
  // An account that is neither.
  { id: "x1", email: "other@example.com", email_confirmed_at: null, user_metadata: {}, app_metadata: {} },
];

test("unauthenticated: every email gets the identical answer and nothing is confirmed", async () => {
  const world = makeWorld(SEED);
  const emails = [
    "waiting@example.com",
    "approved@example.com",
    "done@example.com",
    "other@example.com",
    "nobody@example.com",
  ];

  const answers = [];
  for (const email of emails) {
    answers.push(await handleEnsureEmail(world.deps, { ip: "1.1.1.1", token: null, body: { email } }));
  }

  for (const answer of answers) {
    assert.deepEqual(answer, GENERIC_ENSURE_EMAIL_RESPONSE);
    assert.deepEqual(answer.body, { ok: true, confirmed: false });
    assert.equal(answer.status, 200);
  }
  assert.equal(world.calls.confirm, 0);
  assert.equal(world.calls.lookups, 0, "no account lookup on the unauthenticated path");
  for (const user of Array.from(world.users.values())) {
    const seeded = SEED.find((s) => s.id === user.id);
    assert.equal(user.email_confirmed_at, seeded?.email_confirmed_at);
  }
});

test("unauthenticated: the answer takes the same minimum time for every email", async () => {
  const world = makeWorld(SEED);
  for (const email of ["waiting@example.com", "nobody@example.com"]) {
    await handleEnsureEmail(world.deps, { ip: "1.1.1.2", token: null, body: { email } });
  }
  assert.deepEqual(world.calls.sleeps, [500, 500]);
});

test("unauthenticated: a missing or malformed email is a 400, independent of any account", async () => {
  const world = makeWorld(SEED);
  for (const body of [{}, { email: "" }, { email: "not-an-email" }, null]) {
    const answer = await handleEnsureEmail(world.deps, { ip: "1.1.1.3", token: null, body });
    assert.equal(answer.status, 400);
  }
  assert.equal(world.calls.confirm, 0);
});

test("a password session does not confirm the email", async () => {
  const world = makeWorld(SEED);
  const token = world.issue("w1", ["password"]);
  const answer = await handleEnsureEmail(world.deps, {
    ip: "2.2.2.1",
    token,
    body: { email: "waiting@example.com" },
  });
  assert.deepEqual(answer, { status: 200, body: { ok: true, confirmed: false } });
  assert.equal(world.calls.confirm, 0);
  assert.equal(world.users.get("w1")?.email_confirmed_at, null);
});

test("an email-code session confirms its own address", async () => {
  const world = makeWorld(SEED);
  const token = world.issue("a1", ["otp"]);
  const answer = await handleEnsureEmail(world.deps, { ip: "2.2.2.2", token, body: {} });
  assert.deepEqual(answer, { status: 200, body: { ok: true, confirmed: true } });
  assert.equal(world.calls.confirm, 1);
  assert.ok(world.users.get("a1")?.email_confirmed_at);
});

test("a session can never confirm a different email", async () => {
  const world = makeWorld(SEED);
  const token = world.issue("a1", ["otp"]);
  const answer = await handleEnsureEmail(world.deps, {
    ip: "2.2.2.3",
    token,
    body: { email: "waiting@example.com" },
  });
  assert.equal(answer.status, 403);
  assert.equal(world.calls.confirm, 0);
  assert.equal(world.users.get("w1")?.email_confirmed_at, null);
});

test("an invalid token is a 401 and changes nothing", async () => {
  const world = makeWorld(SEED);
  const answer = await handleEnsureEmail(world.deps, {
    ip: "2.2.2.4",
    token: tokenWith(["otp"], "forged"),
    body: { email: "waiting@example.com" },
  });
  assert.equal(answer.status, 401);
  assert.equal(world.calls.confirm, 0);
});

test("an already confirmed account reports confirmed to its own session without writing", async () => {
  const world = makeWorld(SEED);
  const token = world.issue("c1", ["password"]);
  const answer = await handleEnsureEmail(world.deps, { ip: "2.2.2.5", token, body: {} });
  assert.deepEqual(answer.body, { ok: true, confirmed: true });
  assert.equal(world.calls.confirm, 0);
});

test("rate limit per IP", async () => {
  const world = makeWorld(SEED);
  for (let i = 0; i < IP_LIMIT.limit; i += 1) {
    const answer = await handleEnsureEmail(world.deps, {
      ip: "3.3.3.1",
      token: null,
      body: { email: `n${i}@example.com` },
    });
    assert.equal(answer.status, 200);
  }
  const blocked = await handleEnsureEmail(world.deps, {
    ip: "3.3.3.1",
    token: null,
    body: { email: "fresh@example.com" },
  });
  assert.equal(blocked.status, 429);
  assert.ok((blocked.retryAfter ?? 0) > 0);
});

test("rate limit per email, the same for an existing and a new address", async () => {
  for (const email of ["waiting@example.com", "nobody@example.com"]) {
    const world = makeWorld(SEED);
    const statuses: number[] = [];
    for (let i = 0; i <= EMAIL_LIMIT.limit; i += 1) {
      // A new IP every time: only the per-email bucket can stop this.
      const answer = await handleEnsureEmail(world.deps, {
        ip: `4.4.4.${i}`,
        token: null,
        body: { email },
      });
      statuses.push(answer.status);
    }
    assert.deepEqual(statuses, [...Array(EMAIL_LIMIT.limit).fill(200), 429], email);
  }
});

test("sessionMethods reads amr entries and tolerates junk", () => {
  assert.deepEqual(sessionMethods(tokenWith(["password", "otp"], "a")), ["password", "otp"]);
  assert.deepEqual(sessionMethods("not.a-jwt"), []);
  assert.deepEqual(sessionMethods("garbage"), []);
});
