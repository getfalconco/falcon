// Run (web has no tsx of its own): cd apps/desktop && node --import tsx --test ../web/lib/waitlist-apply.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "@supabase/supabase-js";
import {
  handleWaitlistApply,
  PASSWORD_RULE_MESSAGE,
  type WaitlistApplyDeps,
} from "./waitlist-apply";

type FakeUser = {
  id: string;
  email: string;
  password?: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  created_at: string;
};

function makeStore(seed: FakeUser[] = []) {
  const users = new Map<string, FakeUser>(seed.map((u) => [u.id, structuredClone(u)]));
  const tokens = new Map<string, string>(); // token -> user id
  const calls = { create: 0, update: 0, find: 0 };
  let nextId = 100;

  const byEmail = (email: string) =>
    Array.from(users.values()).find((u) => u.email.toLowerCase() === email) ?? null;

  const deps: WaitlistApplyDeps = {
    async userFromAccessToken(token) {
      const id = tokens.get(token);
      const user = id ? users.get(id) : undefined;
      return user ? (structuredClone(user) as unknown as User) : null;
    },
    async createUser({ email, password, userMetadata }) {
      calls.create += 1;
      if (byEmail(email)) {
        return {
          ok: false,
          error: Object.assign(new Error("A user with this email address has already been registered"), {
            code: "email_exists",
            status: 422,
          }),
        };
      }
      const id = `u${nextId++}`;
      users.set(id, {
        id,
        email,
        ...(password ? { password } : {}),
        user_metadata: { ...userMetadata },
        app_metadata: {},
        created_at: new Date().toISOString(),
      });
      return { ok: true };
    },
    async findUserByEmail(email) {
      calls.find += 1;
      const user = byEmail(email);
      return user ? (structuredClone(user) as unknown as User) : null;
    },
    async updateUserMetadata(userId, metadata) {
      calls.update += 1;
      const user = users.get(userId);
      if (!user) throw new Error("no such user");
      user.user_metadata = { ...metadata };
    },
    async memberNumberFor(email) {
      const ordered = Array.from(users.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const idx = ordered.findIndex((u) => u.email === email);
      return idx === -1 ? null : idx + 1;
    },
  };

  return { users, tokens, calls, deps, byEmail };
}

const VICTIM: FakeUser = {
  id: "victim",
  email: "victim@example.com",
  password: "Original1",
  user_metadata: {
    full_name: "Victor Victim",
    waitlist: true,
    phone: "+1 555 0100",
    application: { describes: "pro" },
  },
  app_metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
};

const OTHER: FakeUser = {
  id: "other",
  email: "other@example.com",
  user_metadata: { full_name: "Olive Other", waitlist: true },
  app_metadata: {},
  created_at: "2026-02-01T00:00:00.000Z",
};

const attackBody = {
  name: "Mallory",
  email: "victim@example.com",
  password: "Hijack123",
  phone: "+1 555 6666",
  application: { describes: "attacker" },
};

test("a new email without a token creates the account and answers { ok: true } only", async () => {
  const store = makeStore([VICTIM]);
  const result = await handleWaitlistApply(store.deps, {
    token: null,
    body: {
      name: "  New Person ",
      email: " New@Example.com ",
      password: "Secret123",
      phone: "+1 555 0199",
      application: { describes: "pro", bogus: "dropped" },
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });

  const created = store.byEmail("new@example.com");
  assert.ok(created, "account created");
  assert.equal(created.password, "Secret123", "password kept on creation");
  assert.deepEqual(created.user_metadata, {
    full_name: "New Person",
    waitlist: true,
    phone: "+1 555 0199",
    application: { describes: "pro" },
  });
});

test("an existing email without a token changes nothing", async () => {
  const store = makeStore([VICTIM]);
  const before = structuredClone(store.users.get("victim"));
  const result = await handleWaitlistApply(store.deps, { token: null, body: attackBody });
  assert.equal(result.status, 200);
  assert.deepEqual(store.users.get("victim"), before, "victim untouched, password included");
  assert.equal(store.calls.update, 0);
});

test("no enumeration: taken and free emails get identical answers", async () => {
  const store = makeStore([VICTIM]);
  const taken = await handleWaitlistApply(store.deps, { token: null, body: attackBody });
  const free = await handleWaitlistApply(store.deps, {
    token: null,
    body: { ...attackBody, email: "fresh@example.com" },
  });
  assert.equal(taken.status, free.status);
  assert.deepEqual(taken.body, free.body);
  assert.equal(JSON.stringify(taken.body), JSON.stringify(free.body));
  assert.equal("memberNumber" in taken.body, false);
  assert.equal("status" in taken.body, false);

  // Without a password and with only a name, the answers still match.
  const takenNameOnly = await handleWaitlistApply(store.deps, {
    token: null,
    body: { name: "X", email: "victim@example.com" },
  });
  const freeNameOnly = await handleWaitlistApply(store.deps, {
    token: null,
    body: { name: "X", email: "fresh2@example.com" },
  });
  assert.deepEqual(takenNameOnly, freeNameOnly);
});

test("no enumeration: a weak password is refused the same way for taken and free emails", async () => {
  const store = makeStore([VICTIM]);
  const taken = await handleWaitlistApply(store.deps, {
    token: null,
    body: { ...attackBody, password: "weak" },
  });
  const free = await handleWaitlistApply(store.deps, {
    token: null,
    body: { ...attackBody, email: "fresh@example.com", password: "weak" },
  });
  assert.deepEqual(taken, free);
  assert.equal(taken.status, 400);
  assert.equal(taken.body.error, PASSWORD_RULE_MESSAGE);
  assert.equal(store.calls.create, 0, "nothing reached the account store");
});

test("an unrecognised create error still answers generically when the email is taken", async () => {
  const store = makeStore([VICTIM]);
  store.deps.createUser = async () => ({ ok: false, error: new Error("Database error saving new user") });
  const result = await handleWaitlistApply(store.deps, { token: null, body: attackBody });
  assert.deepEqual(result.body, { ok: true });
  assert.equal(store.calls.update, 0);
});

test("a real create failure on a free email throws (route answers 500)", async () => {
  const store = makeStore([]);
  store.deps.createUser = async () => ({ ok: false, error: new Error("boom") });
  await assert.rejects(
    handleWaitlistApply(store.deps, { token: null, body: { email: "a@b.co" } }),
    /boom/,
  );
});

test("an invalid email is refused without a token", async () => {
  const store = makeStore([]);
  const result = await handleWaitlistApply(store.deps, { token: null, body: { email: "nope" } });
  assert.equal(result.status, 400);
  assert.equal(store.calls.create, 0);
});

test("a bad token is refused and changes nothing", async () => {
  const store = makeStore([VICTIM]);
  const before = structuredClone(store.users.get("victim"));
  const result = await handleWaitlistApply(store.deps, { token: "forged", body: attackBody });
  assert.equal(result.status, 401);
  assert.deepEqual(store.users.get("victim"), before);
  assert.equal(store.calls.create, 0);
});

test("a valid token updates its own user and returns that user's member number", async () => {
  const store = makeStore([VICTIM, OTHER]);
  store.tokens.set("tok-other", "other");
  const result = await handleWaitlistApply(store.deps, {
    token: "tok-other",
    body: {
      name: "Olive Updated",
      email: "OTHER@example.com",
      phone: "+1 555 0123",
      application: { describes: "pro" },
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, memberNumber: 2 });
  assert.deepEqual(store.users.get("other")?.user_metadata, {
    full_name: "Olive Updated",
    waitlist: true,
    phone: "+1 555 0123",
    application: { describes: "pro" },
  });
});

test("a token only ever touches the token's user: another account's email is refused", async () => {
  const store = makeStore([VICTIM, OTHER]);
  store.tokens.set("tok-other", "other");
  const victimBefore = structuredClone(store.users.get("victim"));
  const otherBefore = structuredClone(store.users.get("other"));
  const result = await handleWaitlistApply(store.deps, { token: "tok-other", body: attackBody });
  assert.equal(result.status, 403);
  assert.equal("memberNumber" in result.body, false);
  assert.deepEqual(store.users.get("victim"), victimBefore);
  assert.deepEqual(store.users.get("other"), otherBefore);
});

test("a token without a body email updates the token's user", async () => {
  const store = makeStore([VICTIM, OTHER]);
  store.tokens.set("tok-other", "other");
  const result = await handleWaitlistApply(store.deps, {
    token: "tok-other",
    body: { name: "Just A Name" },
  });
  assert.equal(result.status, 200);
  assert.equal(store.users.get("other")?.user_metadata.full_name, "Just A Name");
  assert.equal(store.users.get("victim")?.user_metadata.full_name, "Victor Victim");
});

test("a signed-in update never sets a password and never downgrades an approved user", async () => {
  const approved: FakeUser = {
    ...OTHER,
    id: "approved",
    email: "approved@example.com",
    password: "Kept1234",
    user_metadata: { full_name: "Ann Approved" },
    app_metadata: { approved: true },
  };
  const store = makeStore([approved]);
  store.tokens.set("tok-approved", "approved");
  const result = await handleWaitlistApply(store.deps, {
    token: "tok-approved",
    body: { name: "", password: "Changed123" },
  });
  assert.equal(result.status, 200);
  const after = store.users.get("approved");
  assert.equal(after?.password, "Kept1234");
  assert.equal(after?.user_metadata.waitlist, false);
  assert.equal(after?.user_metadata.full_name, "Ann Approved", "an empty name keeps the old one");
});

test("anonymous answers are padded to the timing floor, signed-in ones are not", async () => {
  const store = makeStore([VICTIM]);
  const slept: number[] = [];
  let clock = 1000;
  store.deps.now = () => clock;
  store.deps.sleep = async (ms) => {
    slept.push(ms);
  };
  store.deps.minAnonymousMs = 900;
  const realCreate = store.deps.createUser;
  store.deps.createUser = async (input) => {
    clock += 300;
    return realCreate(input);
  };

  await handleWaitlistApply(store.deps, { token: null, body: attackBody });
  assert.deepEqual(slept, [600]);

  store.tokens.set("tok-victim", "victim");
  await handleWaitlistApply(store.deps, { token: "tok-victim", body: { name: "V" } });
  assert.deepEqual(slept, [600], "no padding on the signed-in path");
});
