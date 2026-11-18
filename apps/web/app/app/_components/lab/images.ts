"use client";

/**
 * Images attached to a Desk message, prepared in the browser before sending:
 * PNG, JPEG, WebP or GIF only; anything over 2000 px on the long edge, or
 * heavier than ~1.5 MB, is redrawn at 2000 px as WebP (JPEG where the browser
 * cannot write WebP) at quality 0.85, so a request stays well under the 6 MB
 * body limit of the hosting. A small thumbnail (400 px) is what the session
 * keeps; the full image lives in memory for this page visit only.
 */

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGES = 4;
const MAX_EDGE = 2000;
const THUMB_EDGE = 400;
const KEEP_AS_IS_BYTES = 1_500_000;
/** The route's limit is 5 MB; stay under it after base64 overhead is ignored. */
const MAX_BYTES = 4_500_000;

export type PreparedImage = {
  id: string;
  mediaType: string;
  /** Base64, no data: prefix. */
  data: string;
  /** A small data: URL for the thread and storage. */
  thumb: string;
  w: number;
  h: number;
};

export class ImageError extends Error {}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

async function decode(file: File): Promise<{ source: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageError("This image could not be opened.");
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Draws the image at most `edge` px on the long side; WebP when the browser writes it, else JPEG on white. */
async function redraw(source: CanvasImageSource, w: number, h: number, edge: number, quality: number): Promise<{ blob: Blob; w: number; h: number }> {
  const scale = Math.min(1, edge / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageError("This image could not be prepared.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, cw, ch);
  const webp = await canvasBlob(canvas, "image/webp", quality);
  if (webp && webp.type === "image/webp") return { blob: webp, w: cw, h: ch };
  // JPEG has no transparency: paint white under the image.
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  const jpeg = await canvasBlob(canvas, "image/jpeg", quality);
  if (!jpeg) throw new ImageError("This image could not be prepared.");
  return { blob: jpeg, w: cw, h: ch };
}

export async function prepareImage(file: File, id: string): Promise<PreparedImage> {
  if (!IMAGE_TYPES.includes(file.type)) throw new ImageError("Only PNG, JPEG, WebP or GIF images can be attached.");
  const img = await decode(file);
  try {
    let out: { blob: Blob; w: number; h: number };
    if (Math.max(img.w, img.h) <= MAX_EDGE && file.size <= KEEP_AS_IS_BYTES) out = { blob: file, w: img.w, h: img.h };
    else {
      out = await redraw(img.source, img.w, img.h, MAX_EDGE, 0.85);
      if (out.blob.size > KEEP_AS_IS_BYTES) out = await redraw(img.source, img.w, img.h, 1600, 0.75);
    }
    if (out.blob.size > MAX_BYTES) throw new ImageError("This image is too large to send.");
    const thumb = await blobToDataUrl((await redraw(img.source, img.w, img.h, THUMB_EDGE, 0.72)).blob);
    const url = await blobToDataUrl(out.blob);
    const comma = url.indexOf(",");
    return { id, mediaType: out.blob.type || file.type, data: url.slice(comma + 1), thumb, w: out.w, h: out.h };
  } finally {
    img.close();
  }
}
