"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Loader2, Upload } from "lucide-react";
import {
  DEPARTMENTS,
  STAGE_LABELS,
  departmentLabel,
  formatByteSize,
  type Department,
} from "@/lib/internship-copy";
import { cn } from "@/lib/utils";
import AdminTabs from "./AdminTabs";
import {
  ADMIN_BTN_GHOST,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CARD_SOFT,
  ADMIN_INPUT,
  ADMIN_MICRO_LABEL,
  ADMIN_MONO,
  ADMIN_TABLE,
  ADMIN_TABLE_HEAD,
  ADMIN_TABLE_ROW,
  statusBadge,
} from "../admin-theme";

const PANEL = `${ADMIN_CARD} p-5 sm:p-6`;

type Application = {
  id: string;
  fullName: string;
  email: string;
  department: string;
  stage: string;
  schoolYear: string;
  availability: string;
  answers: Record<string, string>;
  scorePass: boolean | null;
  portalUrl: string;
  createdAt: string;
};

type TaskDoc = {
  id: string;
  department: string;
  title: string;
  published: boolean;
  docxPath: string | null;
  docxFileName: string | null;
  docxByteSize: number | null;
  docxUploadedAt: string | null;
  updatedAt?: string;
};

type Slot = {
  id: string;
  startsAt: string;
  endsAt: string;
  bookedCount: number;
  capacity: number;
  isOpen: boolean;
};

type InternRow = {
  id: string;
  fullName: string;
  email: string;
  department: string;
  portalUrl: string;
  tasks: { id: string; title: string; status: string }[];
};

function latestDocsByDepartment(docs: TaskDoc[]): TaskDoc[] {
  const map = new Map<string, TaskDoc>();
  for (const d of docs) {
    if (!map.has(d.department)) map.set(d.department, d);
  }
  return DEPARTMENTS.map((dept) => map.get(dept.key)).filter(Boolean) as TaskDoc[];
}

export default function JobsManager() {
  const [tab, setTab] = useState<"funnel" | "tasks" | "slots" | "interns">("funnel");
  const [apps, setApps] = useState<Application[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [docs, setDocs] = useState<TaskDoc[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [interns, setInterns] = useState<InternRow[]>([]);
  const [selected, setSelected] = useState<Application | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [slotStart, setSlotStart] = useState("");
  const [slotEnd, setSlotEnd] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskInternId, setTaskInternId] = useState("");
  const [uploadingDept, setUploadingDept] = useState<string | null>(null);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, s, t, sl, i] = await Promise.all([
        fetch("/api/admin/jobs?view=applications").then((r) => r.json()),
        fetch("/api/admin/jobs?view=summary").then((r) => r.json()),
        fetch("/api/admin/jobs?view=tasks").then((r) => r.json()),
        fetch("/api/admin/jobs?view=slots").then((r) => r.json()),
        fetch("/api/admin/jobs?view=interns").then((r) => r.json()),
      ]);
      if (a.error) throw new Error(a.error);
      setApps(a.applications ?? []);
      setSummary(s.summary ?? {});
      setDocs(t.docs ?? []);
      setSlots(sl.slots ?? []);
      setInterns(i.interns ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const taskDocs = useMemo(() => latestDocsByDepartment(docs), [docs]);

  useEffect(() => {
    setTitleDrafts((prev) => {
      const next = { ...prev };
      for (const d of taskDocs) {
        if (next[d.department] === undefined) next[d.department] = d.title;
      }
      return next;
    });
  }, [taskDocs]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/admin/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Action failed.");
    await load();
    return json;
  }

  async function uploadDocx(department: Department, file: File) {
    setUploadingDept(department);
    setError(null);
    try {
      const form = new FormData();
      form.set("department", department);
      form.set("file", file);
      const title = titleDrafts[department]?.trim();
      if (title) form.set("title", title);
      const res = await fetch("/api/admin/jobs/task-docx", { method: "POST", body: form });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Upload failed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploadingDept(null);
    }
  }

  async function saveTitle(doc: TaskDoc) {
    const title = titleDrafts[doc.department]?.trim();
    if (!title || title === doc.title) return;
    try {
      await post({ action: "update_task_doc", id: doc.id, title });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save title.");
    }
  }

  const tabs = [
    { id: "funnel" as const, label: "Funnel" },
    { id: "tasks" as const, label: "Task docs" },
    { id: "slots" as const, label: "Interview slots" },
    { id: "interns" as const, label: "Interns" },
  ];

  return (
    <div className="space-y-6">
      <AdminTabs tabs={tabs} active={tab} onChange={(id) => setTab(id as typeof tab)} />

      {error ? (
        <p className="rounded-xl border border-red-200/80 bg-red-50 px-4 py-2.5 text-[13px] text-red-800">
          {error}
        </p>
      ) : null}

      {tab === "funnel" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {Object.entries(summary).map(([k, v]) => (
              <span
                key={k}
                className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] text-[#6b7280]"
              >
                {STAGE_LABELS[k] ?? k}
                <span className="ml-1.5 tabular-nums text-[#1d1b1b]">{v}</span>
              </span>
            ))}
          </div>

          <div className={`${PANEL} overflow-hidden p-0`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[12.5px]">
                <thead className="border-b border-black/[0.08] text-[11px] uppercase tracking-[0.04em] text-[#9a9a9a]">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Dept</th>
                    <th className="px-4 py-3 font-medium">Stage</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05]">
                  {apps.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-12 text-center text-[#9a9a9a]">
                        No applications yet.
                      </td>
                    </tr>
                  ) : (
                    apps.map((a) => (
                      <tr key={a.id} className="text-[#4b4b48]">
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className="text-left hover:text-[#1d1b1b]"
                            onClick={() => setSelected(a)}
                          >
                            <span className="font-medium text-[#1d1b1b]">{a.fullName}</span>
                            <div className="text-[11px] text-[#9a9a9a]">{a.email}</div>
                          </button>
                        </td>
                        <td className="px-4 py-3 text-[#6b7280]">{departmentLabel(a.department)}</td>
                        <td className="px-4 py-3 text-[#6b7280]">{STAGE_LABELS[a.stage] ?? a.stage}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            {a.stage === "applied" ? (
                              <button
                                type="button"
                                className={ADMIN_BTN_GHOST}
                                onClick={() =>
                                  void post({ action: "advance", id: a.id, stage: "task_sent" })
                                }
                              >
                                Send task
                              </button>
                            ) : null}
                            {a.stage === "task_submitted" || a.stage === "task_scored" ? (
                              <>
                                <button
                                  type="button"
                                  className="inline-flex h-8 items-center rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-[12px] text-emerald-800 hover:bg-emerald-100"
                                  onClick={() =>
                                    void post({
                                      action: "score",
                                      id: a.id,
                                      pass: true,
                                      notes,
                                      rubric: {},
                                    })
                                  }
                                >
                                  Pass
                                </button>
                                <button
                                  type="button"
                                  className="inline-flex h-8 items-center rounded-lg border border-red-200 bg-red-50 px-2.5 text-[12px] text-red-800 hover:bg-red-100"
                                  onClick={() =>
                                    void post({
                                      action: "score",
                                      id: a.id,
                                      pass: false,
                                      notes,
                                      rubric: {},
                                    })
                                  }
                                >
                                  Fail
                                </button>
                              </>
                            ) : null}
                            {a.stage === "task_scored" && a.scorePass ? (
                              <button
                                type="button"
                                className="inline-flex h-8 items-center rounded-lg border border-sky-200 bg-sky-50 px-2.5 text-[12px] text-sky-800 hover:bg-sky-100"
                                onClick={() =>
                                  void post({
                                    action: "advance",
                                    id: a.id,
                                    stage: "interview_invited",
                                  })
                                }
                              >
                                Invite interview
                              </button>
                            ) : null}
                            {a.stage === "interview_booked" || a.stage === "interview_done" ? (
                              <button
                                type="button"
                                className="inline-flex h-8 items-center rounded-lg border border-fuchsia-200 bg-fuchsia-50 px-2.5 text-[12px] text-fuchsia-800 hover:bg-fuchsia-100"
                                onClick={() => void post({ action: "accept", id: a.id })}
                              >
                                Accept
                              </button>
                            ) : null}
                            <a
                              href={a.portalUrl}
                              target="_blank"
                              rel="noreferrer"
                              className={ADMIN_BTN_GHOST}
                            >
                              Portal
                            </a>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {selected ? (
            <div className={PANEL}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[15px] font-medium text-[#1d1b1b]">{selected.fullName}</p>
                  <p className="mt-1 text-[12px] text-[#9a9a9a]">
                    {selected.schoolYear} · {selected.availability}
                  </p>
                </div>
                <button type="button" className={ADMIN_BTN_GHOST} onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
              <ul className="mt-4 space-y-2.5 text-[13px] text-[#4b4b48]">
                {Object.entries(selected.answers).map(([k, v]) => (
                  <li key={k} className="rounded-lg border border-black/[0.06] bg-[#fbfbf9] px-3 py-2">
                    <span className="text-[11px] uppercase tracking-[0.04em] text-[#9a9a9a]">{k}</span>
                    <p className="mt-1">{v}</p>
                  </li>
                ))}
              </ul>
              <label className="mt-4 block text-[11px] uppercase tracking-[0.04em] text-[#9a9a9a]">
                Score notes
                <textarea
                  className={`${ADMIN_INPUT} mt-2 w-full`}
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "tasks" ? (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-[#6b7280]">
            Upload one <span className="text-[#4b4b48]">.docx</span> brief per role. When you send Stage
            2, the applicant downloads the file for the department they applied to.
          </p>
          <div className="grid gap-4 lg:grid-cols-3">
            {DEPARTMENTS.map((dept) => {
              const d = taskDocs.find((x) => x.department === dept.key);
              const busy = uploadingDept === dept.key;
              return (
                <TaskDocCard
                  key={dept.key}
                  department={dept.key}
                  label={dept.label}
                  doc={d}
                  title={titleDrafts[dept.key] ?? d?.title ?? ""}
                  onTitleChange={(v) =>
                    setTitleDrafts((prev) => ({ ...prev, [dept.key]: v }))
                  }
                  onTitleBlur={() => {
                    if (d) void saveTitle(d);
                  }}
                  uploading={busy}
                  onUpload={(file) => void uploadDocx(dept.key, file)}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {tab === "slots" ? (
        <div className="space-y-4">
          <div className={`${PANEL} flex flex-wrap items-end gap-3`}>
            <label className="text-[11px] uppercase tracking-[0.04em] text-[#9a9a9a]">
              Starts
              <input
                type="datetime-local"
                className={`${ADMIN_INPUT} mt-1.5 block`}
                value={slotStart}
                onChange={(e) => setSlotStart(e.target.value)}
              />
            </label>
            <label className="text-[11px] uppercase tracking-[0.04em] text-[#9a9a9a]">
              Ends
              <input
                type="datetime-local"
                className={`${ADMIN_INPUT} mt-1.5 block`}
                value={slotEnd}
                onChange={(e) => setSlotEnd(e.target.value)}
              />
            </label>
            <button
              type="button"
              className={ADMIN_BTN_PRIMARY}
              onClick={() =>
                void post({
                  action: "create_slot",
                  startsAt: new Date(slotStart).toISOString(),
                  endsAt: new Date(slotEnd).toISOString(),
                })
              }
            >
              Add 15-min slot
            </button>
          </div>
          <ul className="space-y-2">
            {slots.length === 0 ? (
              <li className={`${PANEL} text-[13px] text-[#9a9a9a]`}>No interview slots yet.</li>
            ) : (
              slots.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.08] bg-white px-4 py-3 text-[13px] text-[#4b4b48]"
                >
                  <span>
                    {new Date(s.startsAt).toLocaleString()} →{" "}
                    {new Date(s.endsAt).toLocaleTimeString()}
                  </span>
                  <span className="text-[11px] text-[#9a9a9a]">
                    {s.bookedCount}/{s.capacity} booked · {s.isOpen ? "open" : "closed"}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      {tab === "interns" ? (
        <div className="space-y-4">
          <div className={`${PANEL} flex flex-wrap gap-2`}>
            <select
              className={ADMIN_INPUT}
              value={taskInternId}
              onChange={(e) => setTaskInternId(e.target.value)}
            >
              <option value="">Assign to…</option>
              {interns.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.fullName}
                </option>
              ))}
            </select>
            <input
              className={`${ADMIN_INPUT} min-w-[180px] flex-1`}
              placeholder="Task title"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
            />
            <button
              type="button"
              className={ADMIN_BTN_PRIMARY}
              onClick={() =>
                void post({
                  action: "create_intern_task",
                  internId: taskInternId,
                  title: taskTitle,
                }).then(() => setTaskTitle(""))
              }
            >
              Add task
            </button>
          </div>
          <ul className="grid gap-3 lg:grid-cols-2">
            {interns.map((i) => (
              <li key={i.id} className={PANEL}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-[14px] font-medium text-[#1d1b1b]">{i.fullName}</p>
                    <p className="mt-0.5 text-[12px] text-[#9a9a9a]">
                      {departmentLabel(i.department)} · {i.email}
                    </p>
                  </div>
                  <a
                    href={i.portalUrl}
                    className={ADMIN_BTN_GHOST}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Panel
                  </a>
                </div>
                <ul className="mt-3 space-y-1.5 text-[12px] text-[#6b7280]">
                  {i.tasks.length === 0 ? (
                    <li>No tasks yet.</li>
                  ) : (
                    i.tasks.map((t) => (
                      <li
                        key={t.id}
                        className="flex justify-between gap-2 rounded-lg border border-black/[0.06] px-2.5 py-1.5"
                      >
                        <span>{t.title}</span>
                        <span className="text-[#c4c4c0]">{t.status}</span>
                      </li>
                    ))
                  )}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function TaskDocCard({
  department,
  label,
  doc,
  title,
  onTitleChange,
  onTitleBlur,
  uploading,
  onUpload,
}: {
  department: Department;
  label: string;
  doc?: TaskDoc;
  title: string;
  onTitleChange: (v: string) => void;
  onTitleBlur: () => void;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasFile = Boolean(doc?.docxPath);

  return (
    <div className={`${PANEL} flex h-full flex-col`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.08em] text-[#9a9a9a]">Active position</p>
          <h3 className="mt-1 text-[15px] font-medium text-[#1d1b1b]">{label}</h3>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.06em]",
            hasFile
              ? "bg-emerald-50 text-emerald-800 border-emerald-200/80"
              : "bg-amber-50 text-amber-800 border-amber-200/80",
          )}
        >
          {hasFile ? "Ready" : "Needs .docx"}
        </span>
      </div>

      <label className="mt-4 block text-[11px] uppercase tracking-[0.04em] text-[#9a9a9a]">
        Brief title
        <input
          className={`${ADMIN_INPUT} mt-1.5 w-full`}
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={onTitleBlur}
          placeholder="Shown to applicants"
        />
      </label>

      <div
        className={cn(
          "mt-4 flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed px-4 py-8 text-center transition",
          hasFile
            ? "border-black/15 bg-[#fbfbf9]"
            : "border-black/20 bg-white hover:border-black/30 hover:bg-[#fbfbf9]",
        )}
      >
        <FileText className="h-8 w-8 text-[#9a9a9a]" strokeWidth={1.5} />
        {hasFile ? (
          <>
            <p className="mt-3 max-w-full truncate text-[13px] text-[#1d1b1b]" title={doc?.docxFileName ?? ""}>
              {doc?.docxFileName}
            </p>
            <p className="mt-1 text-[11px] text-[#9a9a9a]">
              {formatByteSize(doc?.docxByteSize)}
              {doc?.docxUploadedAt
                ? ` · ${new Date(doc.docxUploadedAt).toLocaleDateString()}`
                : ""}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <a
                href={`/api/admin/jobs/task-docx/${department}`}
                className={ADMIN_BTN_GHOST}
              >
                Download
              </a>
              <button
                type="button"
                className={ADMIN_BTN_PRIMARY}
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
              >
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Replace
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-[13px] text-[#4b4b48]">Drop a Word brief here</p>
            <p className="mt-1 text-[11px] text-[#9a9a9a]">.docx only · max 10 MB</p>
            <button
              type="button"
              className={`${ADMIN_BTN_PRIMARY} mt-4`}
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Upload .docx
            </button>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </div>
    </div>
  );
}
