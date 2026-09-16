"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { TextureButton } from "@meridian/ui";
import {
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_MONO,
  ADMIN_TABLE,
  ADMIN_TABLE_HEAD,
  ADMIN_TABLE_ROW,
  statusBadge,
} from "../admin-theme";

type WaitlistUser = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  status: "pending" | "approved";
  role: string | null;
  phone: string | null;
  application: {
    describes: string | null;
    capital: string | null;
    process: string | null;
    hardest: string | null;
    win: string | null;
    agreement: string | null;
    submittedAt: string | null;
  } | null;
  declined: boolean;
};

/** Application answers, in the order they were asked. */
const ANSWER_ROWS: {
  key: keyof NonNullable<WaitlistUser["application"]>;
  label: string;
}[] = [
  { key: "describes", label: "Describes as" },
  { key: "capital", label: "Trading capital" },
  { key: "process", label: "Decision process" },
  { key: "hardest", label: "Hardest part right now" },
  { key: "win", label: "A clear win in six months" },
  { key: "agreement", label: "Agreement" },
];

export default function WaitlistManager() {
  const router = useRouter();
  const [users, setUsers] = useState<WaitlistUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/admin/waitlist");
      const data = (await res.json()) as { users?: WaitlistUser[]; error?: string };

      if (!res.ok) {
        if (res.status === 401) {
          router.replace("/login?next=/admin/dashboard");
          return;
        }
        throw new Error(data.error ?? "Failed to load users.");
      }

      setUsers(data.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function handleAction(userId: string, action: "approve" | "remove") {
    setActingOn(userId);
    setError(null);

    try {
      const res = await fetch("/api/admin/waitlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action }),
      });

      const data = (await res.json()) as { users?: WaitlistUser[]; error?: string };

      if (!res.ok) {
        throw new Error(data.error ?? "Action failed.");
      }

      setUsers(data.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setActingOn(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button type="button" onClick={() => void loadUsers()} className={ADMIN_BTN_SECONDARY}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>
      {error ? (
        <p className="rounded-xl border border-red-200/80 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <div className={`${ADMIN_CARD} overflow-hidden`}>
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-[#9a9a9a]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading users…
          </div>
        ) : users.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-[#9a9a9a]">No waitlist users yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className={`${ADMIN_TABLE} min-w-[640px] text-sm`}>
              <thead className={ADMIN_TABLE_HEAD}>
                <tr>
                  <th className="w-10 px-5 py-4 font-medium" />
                  <th className="px-5 py-4 font-medium">Email</th>
                  <th className="px-5 py-4 font-medium">Name</th>
                  <th className="px-5 py-4 font-medium">Describes as</th>
                  <th className="px-5 py-4 font-medium">Joined</th>
                  <th className="px-5 py-4 font-medium">Status</th>
                  <th className="px-5 py-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <Fragment key={user.id}>
                  <tr className={ADMIN_TABLE_ROW}>
                    <td className="px-5 py-4">
                      {user.application ? (
                        <button
                          type="button"
                          onClick={() =>
                            setOpenRow(openRow === user.id ? null : user.id)
                          }
                          aria-label={
                            openRow === user.id ? "Hide application" : "Show application"
                          }
                          aria-expanded={openRow === user.id}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-[#9a9a9a] transition hover:bg-black/[0.04] hover:text-[#1d1b1b]"
                        >
                          <ChevronDown
                            className={`h-4 w-4 transition-transform ${
                              openRow === user.id ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                      ) : null}
                    </td>
                    <td className="px-5 py-4 text-[#1d1b1b]">{user.email}</td>
                    <td className="px-5 py-4 text-[#6b7280]">{user.name ?? "—"}</td>
                    <td className="px-5 py-4 text-[#6b7280]">{user.role ?? "—"}</td>
                    <td className="px-5 py-4 text-[#6b7280]">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={statusBadge(
                            user.status === "approved" ? "success" : "warning",
                          )}
                        >
                          {user.status === "approved" ? "Approved" : "Pending"}
                        </span>
                        {user.declined ? (
                          <span
                            title="Did not accept the application terms"
                            className={statusBadge("danger")}
                          >
                            Didn&rsquo;t accept
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-2">
                        {user.status === "pending" ? (
                          <TextureButton
                            type="button"
                            size="sm"
                            variant="primary"
                            className="w-auto"
                            disabled={actingOn === user.id}
                            onClick={() => void handleAction(user.id, "approve")}
                          >
                            {actingOn === user.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            Approve
                          </TextureButton>
                        ) : null}
                        <TextureButton
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="w-auto"
                          disabled={actingOn === user.id}
                          onClick={() => void handleAction(user.id, "remove")}
                        >
                          Remove
                        </TextureButton>
                      </div>
                    </td>
                  </tr>

                  {openRow === user.id && user.application ? (
                    <tr className={ADMIN_TABLE_ROW}>
                      <td colSpan={7} className="bg-[#fbfbf9] px-5 py-5">
                        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                          {user.phone ? (
                            <div>
                              <dt
                                className="text-xs uppercase tracking-wider text-[#9a9a9a]"
                                style={{ fontFamily: ADMIN_MONO }}
                              >
                                Phone
                              </dt>
                              <dd className="mt-1 text-sm text-[#1d1b1b]">{user.phone}</dd>
                            </div>
                          ) : null}
                          {ANSWER_ROWS.map(({ key, label }) => (
                            <div key={key}>
                              <dt
                                className="text-xs uppercase tracking-wider text-[#9a9a9a]"
                                style={{ fontFamily: ADMIN_MONO }}
                              >
                                {label}
                              </dt>
                              <dd className="mt-1 whitespace-pre-wrap text-sm text-[#4b4b48]">
                                {user.application?.[key] ?? "—"}
                              </dd>
                            </div>
                          ))}
                          {user.application.submittedAt ? (
                            <div>
                              <dt
                                className="text-xs uppercase tracking-wider text-[#9a9a9a]"
                                style={{ fontFamily: ADMIN_MONO }}
                              >
                                Applied
                              </dt>
                              <dd className="mt-1 text-sm text-[#1d1b1b]">
                                {new Date(user.application.submittedAt).toLocaleString()}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
