/**
 * The reader's profile photo, as the renderer and the main process agree on
 * it. The renderer crops and scales the picked image to a small square before
 * it ever leaves the page, so what crosses IPC is a data URL of a few dozen
 * kilobytes; the main process checks it again before writing, because a file
 * on disk outlives whatever bug let a bad one through (main/profile).
 */

/** The square edge the renderer draws the photo at, in pixels. */
export const PROFILE_PHOTO_SIZE = 256;

/** The largest picked file the renderer will try to read at all. */
export const PROFILE_PHOTO_SOURCE_MAX_BYTES = 15 * 1024 * 1024;

/** The largest encoded photo the main process will store. */
export const PROFILE_PHOTO_MAX_BYTES = 512 * 1024;

/** What the file picker offers. GIFs keep only their first frame. */
export const PROFILE_PHOTO_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const MIME_EXT = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

export type ProfilePhotoMime = keyof typeof MIME_EXT;

export const PROFILE_PHOTO_EXTENSIONS: ReadonlyArray<string> = Object.values(MIME_EXT);

export function extensionForMime(mime: ProfilePhotoMime): string {
  return MIME_EXT[mime];
}

export function mimeForExtension(ext: string): ProfilePhotoMime | null {
  const entry = Object.entries(MIME_EXT).find(([, e]) => e === ext);
  return entry ? (entry[0] as ProfilePhotoMime) : null;
}

/** Supabase user ids are UUIDs; anything else never becomes part of a path. */
export function isProfileUserId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export type ProfilePhotoResult = { ok: true; dataUrl: string | null } | { ok: false; error: string };
