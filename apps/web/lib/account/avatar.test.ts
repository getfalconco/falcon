// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/account/avatar.test.ts
// Pure checks of the profile photo rules and the monogram; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AVATAR_MAX_BYTES, avatarPath, checkAvatar, isOwnAvatarPath, monogram } from "./avatar";

const ID = "6c0c8e1a-3f1e-4d7a-9c55-2b8a8d1e0f42";

test("accepts PNG, JPEG and WebP up to 10MB", () => {
  assert.deepEqual(checkAvatar({ type: "image/png", size: 1 }), { ok: true, type: "image/png", ext: "png" });
  assert.deepEqual(checkAvatar({ type: "image/jpeg", size: 2048 }), { ok: true, type: "image/jpeg", ext: "jpg" });
  assert.deepEqual(checkAvatar({ type: "IMAGE/WEBP", size: AVATAR_MAX_BYTES }), { ok: true, type: "image/webp", ext: "webp" });
});

test("rejects other types, empty and oversized files", () => {
  assert.equal(checkAvatar({ type: "image/gif", size: 10 }).ok, false);
  assert.equal(checkAvatar({ type: "image/svg+xml", size: 10 }).ok, false);
  assert.equal(checkAvatar({ type: "", size: 10 }).ok, false);
  assert.equal(checkAvatar({ type: "image/png", size: 0 }).ok, false);
  const big = checkAvatar({ type: "image/png", size: AVATAR_MAX_BYTES + 1 });
  assert.equal(big.ok, false);
  assert.equal(!big.ok && big.error, "That image is over 10MB.");
});

test("paths stay inside the member's folder", () => {
  assert.equal(avatarPath(ID, "png"), `${ID}/avatar.png`);
  assert.equal(isOwnAvatarPath(ID, `${ID}/avatar.webp`), true);
  assert.equal(isOwnAvatarPath(ID, `other/avatar.png`), false);
  assert.equal(isOwnAvatarPath(ID, `${ID}/../x/avatar.png`), false);
  assert.equal(isOwnAvatarPath(ID, `${ID}/avatar.gif`), false);
  assert.equal(isOwnAvatarPath(ID, null), false);
});

test("monogram letters and a stable hue", () => {
  assert.equal(monogram("Kuzey Kovalak", ID).letters, "KK");
  assert.equal(monogram("kuzey", ID).letters, "K");
  assert.equal(monogram("Ada  Grace   Lovelace", ID).letters, "AL");
  assert.equal(monogram("", ID, "kuzey@example.com").letters, "K");
  assert.equal(monogram(null, ID).letters, "");
  assert.equal(monogram("A", ID).hue, monogram("B", ID).hue);
});
