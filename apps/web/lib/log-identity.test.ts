// Run: node --import tsx --test apps/web/lib/log-identity.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashedUserId,
  logIdentity,
  maskEmail,
  scrubLogText,
  scrubLogUrl,
} from "./log-identity";

test("maskEmail keeps the first character and the domain", () => {
  assert.equal(maskEmail("kuzey@yahoo.com"), "k***@yahoo.com");
  assert.equal(maskEmail("  Jane.Doe@Example.CO.uk "), "J***@example.co.uk");
  assert.equal(maskEmail("a@b.io"), "a***@b.io");
});

test("maskEmail rejects things that are not addresses", () => {
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail(""), null);
  assert.equal(maskEmail("(mobile, signed out)"), null);
  assert.equal(maskEmail("@yahoo.com"), null);
  assert.equal(maskEmail("kuzey@"), null);
  assert.equal(maskEmail("kuzey@localhost"), null);
});

test("hashedUserId is stable per salt and never the raw id", () => {
  const id = "3f1c2a9e-5b6d-4e7f-8a90-123456789abc";
  const a = hashedUserId(id, "salt-one");
  assert.match(a ?? "", /^u_[0-9a-f]{12}$/);
  assert.equal(hashedUserId(id, "salt-one"), a);
  assert.notEqual(hashedUserId(id, "salt-two"), a);
  assert.notEqual(hashedUserId("another-user", "salt-one"), a);
  assert.ok(!(a ?? "").includes(id.slice(0, 8)));
});

test("hashedUserId needs both an id and a salt", () => {
  assert.equal(hashedUserId("user-1", null), null);
  assert.equal(hashedUserId("user-1", "  "), null);
  assert.equal(hashedUserId(null, "salt"), null);
});

test("logIdentity prefers the salted tag, then the masked email", () => {
  const withSalt = logIdentity({ userId: "user-1", email: "kuzey@yahoo.com" }, "salt");
  assert.match(withSalt, /^u_[0-9a-f]{12}$/);
  assert.equal(logIdentity({ userId: "user-1", email: "kuzey@yahoo.com" }, null), "k***@yahoo.com");
  assert.equal(logIdentity({ email: "kuzey@yahoo.com" }, "salt"), "k***@yahoo.com");
  assert.equal(logIdentity({}, "salt"), "(unknown)");
});

test("scrubLogText removes tokens, keys, IPs and full emails", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl";
  const out = scrubLogText(
    [
      "Bearer abc.def.ghi failed",
      `token ${jwt}`,
      "key sk-proj-AbCdEf123456",
      "GET /x?access_token=secret123&ticker=NVDA",
      "from 203.0.113.42 and 2001:db8::8a2e:370:7334",
      "user kuzey@yahoo.com",
      "hook https://discord.com/api/webhooks/1/abc",
    ].join("\n"),
  );
  assert.ok(!out.includes("abc.def.ghi"));
  assert.ok(!out.includes(jwt));
  assert.ok(!out.includes("sk-proj"));
  assert.ok(!out.includes("secret123"));
  assert.ok(out.includes("ticker=NVDA"));
  assert.ok(!out.includes("203.0.113.42"));
  assert.ok(!out.includes("2001:db8"));
  assert.ok(!out.includes("kuzey@yahoo.com"));
  assert.ok(out.includes("k***@yahoo.com"));
  assert.ok(out.includes("[webhook]"));
  assert.ok(!out.includes("\n"));
});

test("scrubLogText leaves ordinary error text alone", () => {
  const text = "FAL-NET-01 worker timed out at 12:30:45 for NVDA after 3 retries";
  assert.equal(scrubLogText(text), text);
  assert.equal(scrubLogText(null), "");
});

test("scrubLogUrl drops query, fragment, credentials and IP hosts", () => {
  assert.equal(
    scrubLogUrl("https://worker.getfalcon.co/step1/jobs?token=abc#x"),
    "https://worker.getfalcon.co/step1/jobs",
  );
  assert.equal(scrubLogUrl("https://user:pw@engine.getfalcon.co/run"), "https://engine.getfalcon.co/run");
  assert.equal(scrubLogUrl("http://192.168.1.20:8787/health"), "http://[ip]:8787/health");
  assert.equal(scrubLogUrl("not a url"), null);
  assert.equal(scrubLogUrl(null), null);
});
