import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROFILE_PHOTO_EXTENSIONS,
  PROFILE_PHOTO_MAX_BYTES,
  extensionForMime,
  isProfileUserId,
  mimeForExtension,
  type ProfilePhotoMime,
} from "../../shared/profile-photo";

/**
 * The reader's profile photo on this machine: one small image per account,
 * under `<data root>/profile/avatars/<user id>.<ext>`. It stays local rather
 * than going into the user's Supabase metadata, because that metadata rides
 * inside every access token and a photo would make every request heavier;
 * there is no storage bucket for it yet either.
 *
 * Nothing here knows about Electron, so it can be driven against a temp dir.
 */

/**
 * Splits a photo data URL into its type and bytes, or says why not: only the
 * three formats the renderer encodes to, only base64, and nothing over the cap.
 */
export function parseProfilePhotoDataUrl(
  dataUrl: unknown,
): { ok: true; mime: ProfilePhotoMime; bytes: Buffer } | { ok: false; error: string } {
  if (typeof dataUrl !== "string") return { ok: false, error: "No photo given" };
  const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return { ok: false, error: "Not a PNG, JPEG or WebP image" };
  const mime = match[1] as ProfilePhotoMime;
  // Base64 is four characters per three bytes: refuse before decoding anything large.
  if (Math.floor((match[2].length * 3) / 4) > PROFILE_PHOTO_MAX_BYTES + 2) {
    return { ok: false, error: "Photo is too large" };
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) return { ok: false, error: "Photo is empty" };
  if (bytes.length > PROFILE_PHOTO_MAX_BYTES) return { ok: false, error: "Photo is too large" };
  return { ok: true, mime, bytes };
}

function avatarsDir(root: string): string {
  return path.join(root, "profile", "avatars");
}

function requireUserId(userId: unknown): string {
  if (!isProfileUserId(userId)) throw new Error("Not a user id");
  return userId.toLowerCase();
}

/** Every file a user's photo could be stored as, one per format. */
function candidatePaths(root: string, userId: string): string[] {
  return PROFILE_PHOTO_EXTENSIONS.map((ext) => path.join(avatarsDir(root), `${userId}.${ext}`));
}

async function removeQuietly(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** The stored photo as a data URL, or null when the user has none. */
export async function readProfilePhoto(root: string, userId: unknown): Promise<string | null> {
  const id = requireUserId(userId);
  for (const file of candidatePaths(root, id)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      continue;
    }
    const mime = mimeForExtension(path.extname(file).slice(1));
    if (!mime || bytes.length === 0 || bytes.length > PROFILE_PHOTO_MAX_BYTES) continue;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  return null;
}

/**
 * Replaces the user's photo. Written to a temp file and renamed into place, so
 * a crash mid-write never leaves half an image; the other formats' files are
 * removed afterwards, so exactly one photo is ever on disk for an account.
 */
export async function writeProfilePhoto(root: string, userId: unknown, dataUrl: unknown): Promise<string> {
  const id = requireUserId(userId);
  const parsed = parseProfilePhotoDataUrl(dataUrl);
  if (!parsed.ok) throw new Error(parsed.error);
  const dir = avatarsDir(root);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${id}.${extensionForMime(parsed.mime)}`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, parsed.bytes);
  await rename(temp, target);
  for (const file of candidatePaths(root, id)) {
    if (file !== target) await removeQuietly(file);
  }
  return `data:${parsed.mime};base64,${parsed.bytes.toString("base64")}`;
}

/** Forgets the user's photo; the generated mark takes its place again. */
export async function removeProfilePhoto(root: string, userId: unknown): Promise<void> {
  const id = requireUserId(userId);
  for (const file of candidatePaths(root, id)) await removeQuietly(file);
}
