import { registerIpcHandler } from "../ipc-register";
import { loadDesktopEnv } from "../load-desktop-env";

/**
 * Proxies the marketing site's waitlist endpoints from the main process, so the
 * renderer never makes a cross-origin request (which Electron blocks via CORS).
 */

function siteBases(): string[] {
  loadDesktopEnv(true);
  const configured = (process.env.SITE_URL ?? process.env.VITE_SITE_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  const bases = [configured, "https://getfalcon.co"].filter(Boolean);
  return Array.from(new Set(bases));
}

export type Membership = {
  found: boolean;
  name: string | null;
  memberNumber: number | null;
  grantedAt: string | null;
  approved: boolean;
};

async function fetchMembership(email: string): Promise<Membership> {
  const trimmed = email.trim().toLowerCase();
  for (const base of siteBases()) {
    try {
      const res = await fetch(`${base}/api/waitlist?email=${encodeURIComponent(trimmed)}`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "User-Agent": "MeridianDesktop/1.0" },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Partial<Membership>;
      return {
        found: data.found ?? false,
        name: data.name ?? null,
        memberNumber: data.memberNumber ?? null,
        grantedAt: data.grantedAt ?? null,
        approved: data.approved ?? false,
      };
    } catch {
      // try next base
    }
  }
  return { found: false, name: null, memberNumber: null, grantedAt: null, approved: false };
}

type ApplyPayload = {
  name: string;
  email: string;
  password?: string;
  phone?: string;
  application?: Record<string, string>;
};

type ApplyResult =
  | { ok: true; status: "created" | "updated"; memberNumber: number | null }
  | { ok: false; error: string };

async function submitApplication(payload: ApplyPayload): Promise<ApplyResult> {
  const body = JSON.stringify({ ...payload, email: payload.email.trim().toLowerCase() });
  let lastError = "Failed to submit your application.";
  for (const base of siteBases()) {
    try {
      const res = await fetch(`${base}/api/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "MeridianDesktop/1.0" },
        body,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: "created" | "updated";
        memberNumber?: number | null;
        error?: string;
      };
      if (res.ok && data.ok) {
        return {
          ok: true,
          status: data.status ?? "created",
          memberNumber: data.memberNumber ?? null,
        };
      }
      lastError = data.error ?? lastError;
    } catch {
      // try next base
    }
  }
  return { ok: false, error: lastError };
}

export function registerWaitlistHandlers(): void {
  registerIpcHandler("waitlist:membership", async (_event, email: string) =>
    fetchMembership(email),
  );
  registerIpcHandler("waitlist:apply", async (_event, payload: ApplyPayload) =>
    submitApplication(payload),
  );
}
