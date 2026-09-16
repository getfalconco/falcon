"use client";

import { useCallback, useEffect, useState } from "react";
import { departmentLabel } from "@/lib/internship-copy";

const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";
const MONO = "var(--font-geist-mono), monospace";

type Task = {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done";
  dueAt: string | null;
};

export default function InternPortal({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [intern, setIntern] = useState<{
    fullName: string;
    email: string;
    department: string;
    status: string;
  } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/portal/${token}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load.");
      if (json.kind !== "intern") throw new Error("This link is for applicants, not interns.");
      setIntern(json.intern);
      setTasks(json.tasks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(taskId: string, status: Task["status"]) {
    await fetch(`/api/jobs/portal/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_task_status", taskId, status }),
    });
    await load();
  }

  if (loading) return <p className="text-[14px] text-[#6b7280]">Loading…</p>;
  if (!intern) return <p className="text-[14px] text-red-700">{error ?? "Not found."}</p>;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-[11px] uppercase tracking-[0.12em] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
          Intern panel · {departmentLabel(intern.department)}
        </p>
        <h1 className="mt-3 text-[32px] leading-[40px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
          {intern.fullName}
        </h1>
        <p className="mt-2 text-[14px] text-[#6b7280]" style={{ fontFamily: GEIST }}>
          {intern.email} · {intern.status}
        </p>
      </header>

      <section className="rounded-2xl border border-black/10 bg-white p-6">
        <h2 className="text-[18px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
          Assignments
        </h2>
        {tasks.length === 0 ? (
          <p className="mt-3 text-[14px] text-[#6b7280]">No tasks yet — founders will assign work here.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {tasks.map((t) => (
              <li key={t.id} className="rounded-lg border border-black/5 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[14px] text-[#1d1b1b]">{t.title}</p>
                    {t.description ? (
                      <p className="mt-1 text-[13px] text-[#6b7280]">{t.description}</p>
                    ) : null}
                    {t.dueAt ? (
                      <p className="mt-1 text-[11px] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
                        Due {new Date(t.dueAt).toLocaleDateString()}
                      </p>
                    ) : null}
                  </div>
                  <select
                    value={t.status}
                    onChange={(e) => void setStatus(t.id, e.target.value as Task["status"])}
                    className="rounded-md border border-black/10 bg-[#fbfbf9] px-2 py-1 text-[12px]"
                  >
                    <option value="todo">To do</option>
                    <option value="in_progress">In progress</option>
                    <option value="done">Done</option>
                  </select>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
