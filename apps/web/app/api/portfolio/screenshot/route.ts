import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import { SCREENSHOT_TYPES, portfolioSources, readScreenshot, type ScreenshotType } from "@/lib/portfolio-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** The browser shrinks images first; this is the ceiling for what still arrives. */
const MAX_BYTES = 10 * 1024 * 1024;
/** The model API takes images up to 5 MB. */
const MAX_MODEL_BYTES = 5 * 1024 * 1024;

/**
 * Reads the holdings in a portfolio screenshot for the signed-in member.
 * The image is processed in memory and dropped: never written or logged.
 *
 *   POST /api/portfolio/screenshot  multipart { image }
 *   200 { holdings: [{ ticker, name, shares?, value? }] }
 *   400 bad upload, 401 not signed in, 413 too large, 422 unreadable,
 *   429 rate limited, 502 reading failed, 503 not configured
 */
export async function POST(request: Request) {
  const ipLimit = rateLimit(`portfolio-shot-ip:${clientIp(request)}`, { limit: 10, windowMs: 10 * 60_000 });
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter);

  if (!portfolioSources().screenshot) {
    return NextResponse.json({ error: "Screenshot upload isn't available yet." }, { status: 503, headers: NO_STORE });
  }

  const user = await userFromAccessToken(bearerToken(request)).catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "Sign in again to upload a screenshot." }, { status: 401, headers: NO_STORE });
  }
  const userLimit = rateLimit(`portfolio-shot-user:${user.id}`, { limit: 8, windowMs: 10 * 60_000 });
  if (!userLimit.ok) return tooManyRequests(userLimit.retryAfter);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "That image is over 10 MB." }, { status: 413, headers: NO_STORE });
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const entry = form.get("image");
    file = entry instanceof File ? entry : null;
  } catch {
    file = null;
  }
  if (!file) {
    return NextResponse.json({ error: "Choose an image to upload." }, { status: 400, headers: NO_STORE });
  }
  if (!SCREENSHOT_TYPES.includes(file.type as ScreenshotType)) {
    return NextResponse.json({ error: "Use a PNG, JPG or WEBP image." }, { status: 400, headers: NO_STORE });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "That image is over 10 MB." }, { status: 413, headers: NO_STORE });
  }
  if (file.size > MAX_MODEL_BYTES) {
    return NextResponse.json(
      { error: "That image is too large to read. Try a smaller screenshot." },
      { status: 413, headers: NO_STORE },
    );
  }

  const result = await readScreenshot(Buffer.from(await file.arrayBuffer()), file.type as ScreenshotType);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }
  return NextResponse.json({ holdings: result.holdings }, { headers: NO_STORE });
}
