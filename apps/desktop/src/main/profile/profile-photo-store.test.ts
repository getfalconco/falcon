import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PROFILE_PHOTO_MAX_BYTES } from "../../shared/profile-photo";
import {
  parseProfilePhotoDataUrl,
  readProfilePhoto,
  removeProfilePhoto,
  writeProfilePhoto,
} from "./profile-photo-store";

const USER = "56b7a75c-ac79-4e42-8286-26596d02622d";
const tiny = (mime: string, bytes = Buffer.from([1, 2, 3, 4, 5])) => `data:${mime};base64,${bytes.toString("base64")}`;

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-profile-"));
}

describe("parseProfilePhotoDataUrl", () => {
  it("takes the three encoded formats", () => {
    for (const mime of ["image/webp", "image/jpeg", "image/png"]) {
      const parsed = parseProfilePhotoDataUrl(tiny(mime));
      assert.equal(parsed.ok, true);
    }
  });

  it("refuses other types, non-base64 and oversize photos", () => {
    assert.equal(parseProfilePhotoDataUrl(tiny("image/svg+xml")).ok, false);
    assert.equal(parseProfilePhotoDataUrl("data:image/png,raw").ok, false);
    assert.equal(parseProfilePhotoDataUrl(42).ok, false);
    assert.equal(parseProfilePhotoDataUrl(tiny("image/png", Buffer.alloc(PROFILE_PHOTO_MAX_BYTES + 1, 7))).ok, false);
    assert.equal(parseProfilePhotoDataUrl(tiny("image/png", Buffer.alloc(PROFILE_PHOTO_MAX_BYTES, 7))).ok, true);
  });
});

describe("profile photo store", () => {
  it("writes, reads back, replaces across formats and removes", async () => {
    const root = tempRoot();
    assert.equal(await readProfilePhoto(root, USER), null);

    const png = tiny("image/png");
    assert.equal(await writeProfilePhoto(root, USER, png), png);
    assert.equal(await readProfilePhoto(root, USER), png);

    const webp = tiny("image/webp", Buffer.from([9, 9, 9]));
    await writeProfilePhoto(root, USER, webp);
    assert.equal(await readProfilePhoto(root, USER), webp);
    assert.deepEqual(fs.readdirSync(path.join(root, "profile", "avatars")), [`${USER}.webp`]);

    await removeProfilePhoto(root, USER);
    assert.equal(await readProfilePhoto(root, USER), null);
  });

  it("never lets a user id become a path", async () => {
    const root = tempRoot();
    await assert.rejects(writeProfilePhoto(root, "../../evil", tiny("image/png")));
    await assert.rejects(readProfilePhoto(root, "a/b"));
    await assert.rejects(removeProfilePhoto(root, ""));
  });
});
