import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Constant-time string equality. Hashing both sides to a fixed 32 bytes means
 * neither the comparison nor the buffer length can leak how much of the secret
 * matched, closing the timing oracle on the admin email/password check.
 */
function safeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const COOKIE_NAME = "meridian_admin_session";
const MAX_AGE_SEC = 60 * 60 * 12; // 12 hours

export type AdminAccess = "founder" | "talent_manager";

export type AdminSessionPayload = {
  email: string;
  exp: number;
  /** Founder = full admin; talent_manager = Internships only. */
  access: AdminAccess;
};

function getSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not configured.");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function encodeSession(payload: AdminSessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decodeSession(token: string): AdminSessionPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as AdminSessionPayload & { access?: AdminAccess };

    if (!payload.email || !payload.exp || Date.now() > payload.exp) {
      return null;
    }

    // Legacy cookies (pre-access field) are treated as full founder sessions.
    const access: AdminAccess =
      payload.access === "talent_manager" ? "talent_manager" : "founder";

    return { email: payload.email, exp: payload.exp, access };
  } catch {
    return null;
  }
}

export async function createAdminSession(
  email: string,
  access: AdminAccess = "founder",
): Promise<void> {
  const payload: AdminSessionPayload = {
    email,
    access,
    exp: Date.now() + MAX_AGE_SEC * 1000,
  };

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, encodeSession(payload), {
    httpOnly: true,
    secure:
      process.env.NODE_ENV === "production" &&
      process.env.ADMIN_COOKIE_INSECURE !== "1",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export async function clearAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function getAdminSession(): Promise<AdminSessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return decodeSession(token);
}

/** Full Falcon Admin (env credentials). */
export async function requireFounderAdmin(): Promise<AdminSessionPayload | null> {
  const session = await getAdminSession();
  if (!session || session.access !== "founder") return null;
  return session;
}

/** Founder or Talent Manager — for Internships APIs. */
export async function requireJobsAdmin(): Promise<AdminSessionPayload | null> {
  const session = await getAdminSession();
  if (!session) return null;
  if (session.access === "founder" || session.access === "talent_manager") return session;
  return null;
}

export function verifyAdminCredentials(email: string, password: string): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) return false;

  const emailOk = safeStringEqual(
    email.trim().toLowerCase(),
    adminEmail.trim().toLowerCase(),
  );
  const passOk = safeStringEqual(password, adminPassword);

  return emailOk && passOk;
}

export function isTalentManagerRole(role: unknown): boolean {
  return typeof role === "string" && role.trim().toLowerCase() === "talent_manager";
}
