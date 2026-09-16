"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Link2, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Invite, InviteRole, InviteStatus } from "@/lib/admin-invites";
import {
  ADMIN_BTN_GHOST,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_INPUT,
  ADMIN_MONO,
  ADMIN_TAB_ACTIVE,
  ADMIN_TAB_IDLE,
  ADMIN_TAB_LIST,
  ADMIN_TABLE,
  ADMIN_TABLE_HEAD,
  MICRO_LABEL,
  formatRelativeTime,
  statusBadge,
} from "../admin-theme";

const ROLES: { key: InviteRole; label: string; dot: string }[] = [
  { key: "staff", label: "Staff", dot: "bg-emerald-500" },
  { key: "deputy", label: "Deputy", dot: "bg-sky-500" },
  { key: "leader", label: "Leader", dot: "bg-fuchsia-500" },
  { key: "talent_manager", label: "Talent Manager", dot: "bg-amber-500" },
];

const STATUS_VARIANT: Record<InviteStatus, "success" | "neutral" | "warning"> = {
  active: "success",
  claimed: "neutral",
  expired: "warning",
};

function expiryLabel(invite: Invite): string {
  if (invite.status === "claimed") return `claimed ${formatRelativeTime(invite.claimedAt ?? invite.createdAt)}`;
  if (invite.status === "expired") return "expired";
  const ms = Date.parse(invite.expiresAt) - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `expires in ${h}h`;
  return `expires in ${Math.max(1, Math.round(ms / 60_000))}m`;
}

export default function InviteManager({
  initialInvites,
  missingTable,
}: {
  initialInvites: Invite[];
  missingTable: boolean;
}) {
  const [invites, setInvites] = useState<Invite[]>(initialInvites);
  const [role, setRole] = useState<InviteRole>("staff");
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [grantEmail, setGrantEmail] = useState("");
  const [granting, setGranting] = useState(false);
  const [grantMessage, setGrantMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/invites");
      const data = (await res.json()) as { invites?: Invite[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to refresh.");
      setInvites(data.invites ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  async function createLink() {
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = (await res.json()) as { invite?: Invite; url?: string; error?: string };
      if (!res.ok || !data.invite || !data.url) {
        throw new Error(data.error ?? "Failed to create link.");
      }
      setInvites((prev) => [data.invite as Invite, ...prev]);
      setLastLink(data.url);
      try {
        await navigator.clipboard.writeText(data.url);
        setCopied(true);
      } catch {
        // Clipboard blocked
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create link.");
    } finally {
      setCreating(false);
    }
  }

  async function copyLink() {
    if (!lastLink) return;
    try {
      await navigator.clipboard.writeText(lastLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function grantTalentManager() {
    const email = grantEmail.trim().toLowerCase();
    if (!email || granting) return;
    setGranting(true);
    setGrantMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: "talent_manager" }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to grant role.");
      setGrantMessage(
        `${email} is now a Talent Manager. They sign in at /login?next=/admin/dashboard/jobs to open Internships.`,
      );
      setGrantEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant role.");
    } finally {
      setGranting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button type="button" onClick={() => void refresh()} className={ADMIN_BTN_SECONDARY}>
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          Refresh
        </button>
      </div>
      {missingTable ? (
        <p className="rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          The <code className="rounded bg-black/[0.04] px-1">admin_invites</code> table does not exist
          yet. Run <code className="rounded bg-black/[0.04] px-1">apps/web/supabase/admin_invites.sql</code>{" "}
          in the Supabase SQL editor to enable invite links.
        </p>
      ) : null}

      <div className={`${ADMIN_CARD} p-5`}>
        <p className={MICRO_LABEL} style={{ fontFamily: ADMIN_MONO }}>
          Create invite link
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className={ADMIN_TAB_LIST}>
            {ROLES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRole(r.key)}
                className={cn(
                  "flex items-center gap-1.5",
                  role === r.key ? ADMIN_TAB_ACTIVE : ADMIN_TAB_IDLE,
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", r.dot)} />
                {r.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void createLink()}
            disabled={creating || missingTable}
            className={ADMIN_BTN_PRIMARY}
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
            Create link
          </button>
        </div>

        {lastLink ? (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-black/10 bg-[#fbfbf9] px-3 py-2">
            <span
              className="min-w-0 flex-1 truncate text-[12px] text-[#1d1b1b]"
              style={{ fontFamily: ADMIN_MONO }}
            >
              {lastLink}
            </span>
            <button type="button" onClick={() => void copyLink()} className={ADMIN_BTN_GHOST}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : null}

        {error ? <p className="mt-3 text-[12px] text-red-700">{error}</p> : null}
      </div>

      <div className={`${ADMIN_CARD} p-5`}>
        <p className={MICRO_LABEL} style={{ fontFamily: ADMIN_MONO }}>
          Grant Talent Manager (existing account)
        </p>
        <p className="mt-1.5 text-[12px] text-[#6b7280]">
          Sets Internships-only admin access on an account that already signed up. No invite link needed.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="email"
            value={grantEmail}
            onChange={(e) => setGrantEmail(e.target.value)}
            placeholder="aras@…"
            className={`${ADMIN_INPUT} h-9 w-full max-w-[280px]`}
          />
          <button
            type="button"
            onClick={() => void grantTalentManager()}
            disabled={granting || !grantEmail.trim()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-amber-500 px-3.5 text-[12.5px] font-medium text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {granting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Grant Talent Manager
          </button>
        </div>
        {grantMessage ? (
          <p className="mt-3 text-[12px] text-emerald-800">{grantMessage}</p>
        ) : null}
      </div>

      <div className={`${ADMIN_CARD} overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3">
          <h2 className="text-[13px] font-medium text-[#1d1b1b]">Invite links</h2>
          <span className="text-[11px] text-[#9a9a9a]">{invites.length} total</span>
        </div>

        {invites.length === 0 ? (
          <div className="flex items-center justify-center px-4 py-16 text-[12px] text-[#9a9a9a]">
            No invite links yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className={ADMIN_TABLE}>
              <thead>
                <tr className={ADMIN_TABLE_HEAD}>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium">Expiry / claim</th>
                  <th className="px-4 py-2.5 font-medium">Claimed by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.05]">
                {invites.map((inv) => {
                  const roleMeta = ROLES.find((r) => r.key === inv.role);
                  return (
                    <tr key={inv.id} className="text-[13px] text-[#4b4b48]">
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 font-medium text-[#1d1b1b]">
                          <span className={cn("h-1.5 w-1.5 rounded-full", roleMeta?.dot)} />
                          {roleMeta?.label ?? inv.role}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className={statusBadge(STATUS_VARIANT[inv.status])}>{inv.status}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[#9a9a9a]">
                        {formatRelativeTime(inv.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[#9a9a9a]">
                        {expiryLabel(inv)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[#9a9a9a]">
                        {inv.claimedEmail ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
