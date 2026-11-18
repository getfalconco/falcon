// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/account/sessions.test.ts
// Pure checks of the session helpers behind Settings > Account; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { coarseLocation, sessionIdFromToken, sortSessions, type SessionView } from "./sessions";

const SID = "0b7f4a52-8a7e-4c1b-9f0d-3c2e6f1a9b10";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("session id from the access token's claim", () => {
  assert.equal(sessionIdFromToken(`${b64url({ alg: "HS256" })}.${b64url({ sub: "u", session_id: SID })}.sig`), SID);
  assert.equal(sessionIdFromToken(`${b64url({})}.${b64url({ sub: "u" })}.sig`), null);
  assert.equal(sessionIdFromToken(`${b64url({})}.${b64url({ session_id: "not-a-uuid" })}.sig`), null);
  assert.equal(sessionIdFromToken("garbage"), null);
});

test("coarse location from the host's geo headers only", () => {
  const geo = Buffer.from(JSON.stringify({ city: "Istanbul", country: { code: "TR", name: "Turkey" }, latitude: 41 })).toString("base64");
  assert.equal(coarseLocation(new Headers({ "x-nf-geo": geo })), "Istanbul, Turkey");
  const countryOnly = Buffer.from(JSON.stringify({ country: { code: "TR" } })).toString("base64");
  assert.equal(coarseLocation(new Headers({ "x-nf-geo": countryOnly })), "TR");
  assert.equal(coarseLocation(new Headers({ "x-country": "us" })), "US");
  assert.equal(coarseLocation(new Headers({ "x-nf-geo": "%%%" })), null);
  assert.equal(coarseLocation(new Headers({ "x-forwarded-for": "203.0.113.9" })), null);
});

test("current first, then most recently active", () => {
  const s = (id: string, lastActiveAt: string, current = false): SessionView => ({ id, device: "d", location: null, signedInAt: lastActiveAt, lastActiveAt, current });
  const out = sortSessions([s("a", "2026-11-01T00:00:00Z"), s("b", "2026-11-10T00:00:00Z"), s("c", "2026-10-01T00:00:00Z", true)]);
  assert.deepEqual(out.map((x) => x.id), ["c", "b", "a"]);
});
