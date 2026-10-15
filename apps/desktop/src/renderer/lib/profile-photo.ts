import { useEffect, useState } from "react";
import {
  PROFILE_PHOTO_ACCEPT,
  PROFILE_PHOTO_MAX_BYTES,
  PROFILE_PHOTO_SIZE,
  PROFILE_PHOTO_SOURCE_MAX_BYTES,
} from "../../shared/profile-photo";

/**
 * The reader's profile photo in the renderer: picked in the account pane,
 * shown there and in the account pill. The main process keeps the file (one
 * per account, on this machine); this module keeps the one copy the page
 * shows, so a photo changed in the settings panel is in the top bar the same
 * moment, without either knowing about the other.
 *
 * Without the desktop bridge (the settings preview harness) a photo lives in
 * memory only, so the pane can still be driven.
 */

/** user id → data URL, or null once we know there is none. */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function publish(userId: string, dataUrl: string | null): void {
  cache.set(userId, dataUrl);
  for (const listener of listeners) listener();
}

function load(userId: string): void {
  if (cache.has(userId) || inflight.has(userId)) return;
  const bridge = window.meridian;
  if (!bridge?.getProfilePhoto) {
    publish(userId, null);
    return;
  }
  const job = bridge
    .getProfilePhoto(userId)
    .then((res) => {
      // A photo saved while this read was out wins over what the read found.
      if (!cache.has(userId)) publish(userId, res.ok ? res.dataUrl : null);
    })
    .catch(() => {
      if (!cache.has(userId)) publish(userId, null);
    })
    .finally(() => inflight.delete(userId));
  inflight.set(userId, job);
}

/** The signed-in reader's photo as a data URL, or null for the generated mark. */
export function useProfilePhoto(userId: string | null | undefined): string | null {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    if (userId) load(userId);
    return () => {
      listeners.delete(listener);
    };
  }, [userId]);
  return userId ? (cache.get(userId) ?? null) : null;
}

export async function saveProfilePhoto(userId: string, dataUrl: string): Promise<void> {
  const bridge = window.meridian;
  if (!bridge?.setProfilePhoto) {
    publish(userId, dataUrl);
    return;
  }
  const res = await bridge.setProfilePhoto({ userId, dataUrl });
  if (!res.ok) throw new Error(res.error);
  publish(userId, res.dataUrl);
}

export async function clearProfilePhoto(userId: string): Promise<void> {
  const bridge = window.meridian;
  if (bridge?.removeProfilePhoto) {
    const res = await bridge.removeProfilePhoto(userId);
    if (!res.ok) throw new Error(res.error);
  }
  publish(userId, null);
}

/** What the file picker accepts, for `<input accept>`. */
export const PROFILE_PHOTO_INPUT_ACCEPT = PROFILE_PHOTO_ACCEPT;

/** Why a picked file cannot become a photo; the pane words it in the reader's language. */
export type ProfilePhotoProblem = "type" | "size" | "unreadable" | "empty" | "too-large";

/** A reason a picked file cannot become a photo: `reason` to word it by, the English as the message. */
export class ProfilePhotoError extends Error {
  constructor(
    readonly reason: ProfilePhotoProblem,
    message: string,
  ) {
    super(message);
  }
}

function encode(canvas: HTMLCanvasElement, quality: number): string {
  const webp = canvas.toDataURL("image/webp", quality);
  if (webp.startsWith("data:image/webp")) return webp;
  return canvas.toDataURL("image/jpeg", quality);
}

/** Bytes a base64 data URL decodes to, without decoding it. */
function encodedBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
}

/**
 * Turns a picked file into the photo that gets stored: the largest centred
 * square, scaled to PROFILE_PHOTO_SIZE and encoded as WebP (JPEG where WebP
 * encoding is missing), stepping the quality down until it fits the cap. A
 * 256px square lands far below the cap in practice; the loop is the guarantee.
 */
export async function prepareProfilePhoto(file: File): Promise<string> {
  if (!PROFILE_PHOTO_ACCEPT.split(",").includes(file.type)) {
    throw new ProfilePhotoError("type", "Choose a PNG, JPEG, WebP or GIF image");
  }
  if (file.size > PROFILE_PHOTO_SOURCE_MAX_BYTES) {
    throw new ProfilePhotoError("size", "That image is over 15 MB");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ProfilePhotoError("unreadable", "That image could not be read");
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side < 1) throw new ProfilePhotoError("empty", "That image is empty");
    const canvas = document.createElement("canvas");
    canvas.width = PROFILE_PHOTO_SIZE;
    canvas.height = PROFILE_PHOTO_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ProfilePhotoError("unreadable", "That image could not be read");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // JPEG has no transparency; a white ground keeps a transparent PNG from going black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE);
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      PROFILE_PHOTO_SIZE,
      PROFILE_PHOTO_SIZE,
    );
    for (const quality of [0.86, 0.75, 0.6, 0.45]) {
      const dataUrl = encode(canvas, quality);
      if (encodedBytes(dataUrl) <= PROFILE_PHOTO_MAX_BYTES) return dataUrl;
    }
    throw new ProfilePhotoError("too-large", "That image is too large to store");
  } finally {
    bitmap.close();
  }
}
