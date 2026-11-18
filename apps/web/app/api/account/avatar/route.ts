import { NextResponse } from "next/server";
import { AVATAR_BUCKET } from "@/lib/account/avatar";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";

/**
 * GET: whether profile photos can be uploaded yet, i.e. whether the private
 * `avatars` bucket exists (supabase/migrations/20261124_avatars_bucket.sql).
 * Until it does, Settings shows the monogram with a quiet note. The upload
 * itself goes straight from the browser to Supabase Storage with the member's
 * own token (a 10MB body would not fit through a Netlify function); the
 * bucket's size and type limits and its per-user policies enforce the rules
 * on the server side.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const TTL_MS = 60_000;
let cached: { available: boolean; at: number } | null = null;

export async function GET(request: Request) {
  const user = await userFromAccessToken(bearerToken(request)).catch(() => null);
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers: NO_STORE });

  if (cached && Date.now() - cached.at < TTL_MS) return NextResponse.json({ available: cached.available }, { headers: NO_STORE });
  try {
    const { data, error } = await getSupabaseAdmin().storage.getBucket(AVATAR_BUCKET);
    const available = !error && Boolean(data);
    cached = { available, at: Date.now() };
    return NextResponse.json({ available }, { headers: NO_STORE });
  } catch (err) {
    console.error("[account/avatar] bucket", err instanceof Error ? err.name : "unexpected");
    return NextResponse.json({ available: false }, { headers: NO_STORE });
  }
}
