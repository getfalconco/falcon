import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { formatErrorLogLine, reportFalconError, scrubWorkerText } from "./discord-error-log.js";
import { hashedUserId, logIdentity, maskEmail } from "./log-identity.js";

const SALT = "test-salt-0123456789abcdef";
const USER_ID = "7a1c2e9e-5b2f-4d9c-9f1e-1234567890ab";

describe("log-identity (copy of apps/web/lib/log-identity.ts)", () => {
  it("hashes ids exactly as the website does: u_ + 12 hex of HMAC-SHA256(salt, id)", () => {
    const expected = `u_${createHmac("sha256", SALT).update(USER_ID).digest("hex").slice(0, 12)}`;
    assert.equal(hashedUserId(USER_ID, SALT), expected);
    assert.equal(logIdentity({ userId: USER_ID, email: "kuzey@yahoo.com" }, SALT), expected);
  });

  it("falls back to a masked email, then unknown", () => {
    assert.equal(maskEmail("kuzey.kovalak@yahoo.com"), "k***@yahoo.com");
    assert.equal(logIdentity({ userId: USER_ID, email: "kuzey@yahoo.com" }, null), "k***@yahoo.com");
    assert.equal(logIdentity({ userId: USER_ID }, null), "(unknown)");
  });
});

describe("scrubWorkerText", () => {
  it("removes credentials quoted as JSON fields as well as the shared patterns", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl";
    const out = scrubWorkerText(
      `{"userSecret": "9f8e7d6c-aaaa", "consumerKey":"CK123"} Bearer abc.def token=${jwt} sk-ant-api03-XYZ ` +
        "https://discord.com/api/webhooks/1/abc from 10.0.12.7 and 2001:db8::8a2e:370:7334 for jane.doe@gmail.com",
    );
    for (const leaked of ["9f8e7d6c", "CK123", "abc.def", jwt, "sk-ant", "discord.com", "10.0.12.7", "2001:db8", "jane.doe"]) {
      assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
    }
    assert.ok(out.includes("j***@gmail.com"));
  });

  it("keeps ordinary error text and folds it onto one line", () => {
    assert.equal(scrubWorkerText("SEC filing not found\n  for AAPL 10-K"), "SEC filing not found for AAPL 10-K");
    assert.equal(scrubWorkerText("timeout after 12:30:45"), "timeout after 12:30:45");
  });
});

describe("formatErrorLogLine", () => {
  it("never carries a name or a raw email, and keeps the ticker and error", () => {
    const line = formatErrorLogLine(
      {
        code: "FAL-SEC-01",
        message: "no filing for jane@corp.com from 192.168.1.10",
        user: { id: USER_ID, email: "kuzey.kovalak@yahoo.com" },
        ticker: "aapl",
      },
      SALT,
    );
    assert.equal(line, `FAL-SEC-01 · user: ${hashedUserId(USER_ID, SALT)} · ticker: AAPL · no filing for j***@corp.com from [ip]`);
    for (const leaked of ["kuzey", "yahoo", "jane@corp.com", "192.168.1.10", USER_ID]) assert.ok(!line.includes(leaked));
  });

  it("falls back to a masked email without a salt", () => {
    const line = formatErrorLogLine({ code: "FAL-INT-01", message: "boom", user: { id: USER_ID, email: "kuzey@yahoo.com" } }, null);
    assert.equal(line, "FAL-INT-01 · user: k***@yahoo.com · boom");
  });

  it("accepts a payload without a user", () => {
    assert.equal(formatErrorLogLine({ code: "FAL-JOB-02", message: "" }, SALT), "FAL-JOB-02 · user: (unknown)");
  });
});

describe("reportFalconError", () => {
  const realFetch = globalThis.fetch;
  const saved = { hook: process.env.DISCORD_ERROR_LOG_WEBHOOK_URL, salt: process.env.ERROR_LOG_ID_SALT };
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.DISCORD_ERROR_LOG_WEBHOOK_URL = saved.hook;
    process.env.ERROR_LOG_ID_SALT = saved.salt;
    if (saved.hook === undefined) delete process.env.DISCORD_ERROR_LOG_WEBHOOK_URL;
    if (saved.salt === undefined) delete process.env.ERROR_LOG_ID_SALT;
  });

  it("posts the masked line with mentions disabled, and skips auth and request codes", async () => {
    const posts: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    process.env.DISCORD_ERROR_LOG_WEBHOOK_URL = "https://discord.example/hook";
    process.env.ERROR_LOG_ID_SALT = SALT;

    reportFalconError({ code: "FAL-AUTH-01", message: "x", user: { id: USER_ID } });
    reportFalconError({ code: "FAL-INT-01", message: "@everyone boom", user: { id: USER_ID, email: "kuzey@yahoo.com" } });
    await new Promise((r) => setImmediate(r));

    assert.equal(posts.length, 1);
    const body = posts[0] as { content: string; allowed_mentions: { parse: unknown[] } };
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.ok(body.content.includes(hashedUserId(USER_ID, SALT)!));
    assert.ok(!body.content.includes("kuzey"));
  });
});
