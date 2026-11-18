/**
 * Profile photos: the rules the picker checks before uploading. The same
 * limits are set on the `avatars` bucket itself (file_size_limit,
 * allowed_mime_types; supabase/migrations/20261124_avatars_bucket.sql), so
 * Supabase Storage rejects anything that slips past the browser, and the
 * bucket's policies only let a member write `<their id>/avatar.<ext>`.
 */

export const AVATAR_BUCKET = "avatars";
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
export const AVATAR_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export type AvatarType = keyof typeof AVATAR_TYPES;
export type AvatarExt = (typeof AVATAR_TYPES)[AvatarType];
export const AVATAR_EXTS: AvatarExt[] = Object.values(AVATAR_TYPES);
/** For the file input's `accept`. */
export const AVATAR_ACCEPT = Object.keys(AVATAR_TYPES).join(",");

export type AvatarCheck = { ok: true; ext: AvatarExt; type: AvatarType } | { ok: false; error: string };

export function checkAvatar(file: { type: string; size: number }): AvatarCheck {
  const type = file.type.toLowerCase();
  if (!(type in AVATAR_TYPES)) return { ok: false, error: "Use a PNG, JPEG, or WebP image." };
  if (!(file.size > 0)) return { ok: false, error: "That file is empty." };
  if (file.size > AVATAR_MAX_BYTES) return { ok: false, error: "That image is over 10MB." };
  return { ok: true, type: type as AvatarType, ext: AVATAR_TYPES[type as AvatarType] };
}

/** Where a member's photo is stored in the bucket. */
export function avatarPath(userId: string, ext: AvatarExt): string {
  return `${userId}/avatar.${ext}`;
}

/** True only for one of this member's own avatar paths (user_metadata is client-writable). */
export function isOwnAvatarPath(userId: string, path: unknown): path is string {
  return typeof path === "string" && AVATAR_EXTS.some((ext) => path === avatarPath(userId, ext));
}

/** The generated stand-in: up to two initials and a hue picked from the user id. */
export type Monogram = { letters: string; hue: number };

/** Soft hues that read well as a pale fill with darker letters, and the reverse in dark mode. */
const HUES = [12, 28, 45, 95, 150, 175, 200, 220, 255, 285, 320, 345];

export function monogram(name: string | null | undefined, seed: string, fallback?: string | null): Monogram {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  let letters = "";
  if (words.length) {
    const first = Array.from(words[0]!)[0] ?? "";
    const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0] ?? "" : "";
    letters = (first + last).toUpperCase();
  }
  if (!letters) letters = (Array.from((fallback ?? "").trim())[0] ?? "").toUpperCase();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return { letters, hue: HUES[h % HUES.length]! };
}
