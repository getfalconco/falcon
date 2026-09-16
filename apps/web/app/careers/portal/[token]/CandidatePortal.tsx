"use client";

import { useCallback, useEffect, useState } from "react";
import { STAGE_LABELS, departmentLabel, formatByteSize } from "@/lib/internship-copy";

const GEIST = "var(--font-geist-sans), sans-serif";
const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const MONO = "var(--font-geist-mono), monospace";

type Slot = {
  id: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
};

export default function CandidatePortal({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    application: {
      fullName: string;
      email: string;
      department: string;
      stage: string;
      scorePass: boolean | null;
    };
    taskDoc: {
      title: string;
      deadlineAt: string | null;
      hasDocx: boolean;
      fileName: string | null;
      byteSize: number | null;
      bodyMd: string | null;
      downloadPath: string | null;
    } | null;
    submission: { content_url?: string; content_text?: string } | null;
    slots: Slot[];
  } | null>(null);
  const [contentUrl, setContentUrl] = useState("");
  const [contentText, setContentText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/portal/${token}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load.");
      if (json.kind !== "candidate") throw new Error("This link is for interns, not applicants.");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitTask() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/portal/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit_task", contentUrl, contentText }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Submit failed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed.");
    } finally {
      setBusy(false);
    }
  }

  async function bookSlot(slotId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/portal/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "book_interview", slotId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Booking failed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Booking failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-[14px] text-[#6b7280]">Loading portal…</p>;
  }
  if (!data) {
    return <p className="text-[14px] text-red-700">{error ?? "Not found."}</p>;
  }

  const { application: app, taskDoc, submission, slots } = data;
  const field =
    "mt-1.5 w-full rounded-lg border border-black/10 bg-[#fbfbf9] px-3 py-2.5 text-[14px] outline-none";

  return (
    <div className="space-y-8">
      <header>
        <p className="text-[11px] uppercase tracking-[0.12em] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
          {STAGE_LABELS[app.stage] ?? app.stage}
        </p>
        <h1 className="mt-3 text-[32px] leading-[40px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
          Hi {app.fullName.split(" ")[0]}.
        </h1>
        <p className="mt-2 text-[14px] text-[#6b7280]" style={{ fontFamily: GEIST }}>
          {departmentLabel(app.department)} · {app.email}
        </p>
      </header>

      {error ? <p className="text-[13px] text-red-700">{error}</p> : null}

      {app.stage === "applied" ? (
        <div className="rounded-2xl border border-black/10 bg-white p-6">
          <p className="text-[15px] text-[#4b4b48]" style={{ fontFamily: GEIST }}>
            Application received. Falcon will advance strong applicants to Stage 2 with a department task.
            Keep this page bookmarked.
          </p>
        </div>
      ) : null}

      {(app.stage === "task_sent" || app.stage === "task_submitted") && taskDoc ? (
        <section className="space-y-4 rounded-2xl border border-black/10 bg-white p-6">
          <h2 className="text-[20px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
            {taskDoc.title}
          </h2>
          {taskDoc.deadlineAt ? (
            <p className="text-[12px] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
              Deadline {new Date(taskDoc.deadlineAt).toLocaleString()}
            </p>
          ) : null}

          {taskDoc.hasDocx && taskDoc.downloadPath ? (
            <div className="rounded-xl border border-black/10 bg-[#f7f7f4] px-4 py-4">
              <p className="text-[14px] text-[#4b4b48]" style={{ fontFamily: GEIST }}>
                Download the Word brief for your role, complete it, then submit below.
              </p>
              <a
                href={taskDoc.downloadPath}
                className="mt-3 inline-flex h-10 items-center rounded-lg bg-[#1c1917] px-4 text-[13px] text-[#e7e7e7]"
              >
                Download {taskDoc.fileName ?? "task.docx"}
                {taskDoc.byteSize ? (
                  <span className="ml-2 text-[#9a9a9a]">({formatByteSize(taskDoc.byteSize)})</span>
                ) : null}
              </a>
            </div>
          ) : taskDoc.bodyMd ? (
            <pre
              className="whitespace-pre-wrap text-[14px] leading-relaxed text-[#4b4b48]"
              style={{ fontFamily: GEIST }}
            >
              {taskDoc.bodyMd}
            </pre>
          ) : (
            <p className="text-[14px] text-[#6b7280]">
              Your task brief is being prepared. Check back soon or contact Falcon if this persists.
            </p>
          )}

          {app.stage === "task_sent" ? (
            <div className="space-y-3 border-t border-black/5 pt-4">
              <label className="block text-[12px] text-[#6b7280]" style={{ fontFamily: MONO }}>
                Submission URL (Google Doc / Notion / drive)
                <input className={field} value={contentUrl} onChange={(e) => setContentUrl(e.target.value)} />
              </label>
              <label className="block text-[12px] text-[#6b7280]" style={{ fontFamily: MONO }}>
                Or paste your work
                <textarea
                  className={`${field} min-h-[120px]`}
                  value={contentText}
                  onChange={(e) => setContentText(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={busy || (!contentUrl.trim() && !contentText.trim())}
                onClick={() => void submitTask()}
                className="h-10 rounded-lg bg-[#1c1917] px-4 text-[13px] text-[#e7e7e7] disabled:opacity-50"
              >
                {busy ? "Submitting…" : "Submit task"}
              </button>
            </div>
          ) : (
            <p className="text-[14px] text-[#4b4b48]">
              Submitted
              {submission?.content_url ? (
                <>
                  {" "}
                  ·{" "}
                  <a className="underline" href={submission.content_url} target="_blank" rel="noreferrer">
                    open link
                  </a>
                </>
              ) : null}
              . Waiting for scoring.
            </p>
          )}
        </section>
      ) : null}

      {app.stage === "task_scored" || app.stage === "rejected" ? (
        <div className="rounded-2xl border border-black/10 bg-white p-6">
          <p className="text-[15px] text-[#4b4b48]">
            {app.scorePass
              ? "Your task passed. Falcon will invite you to book an interview next."
              : "This application did not advance past Stage 2. Thank you for the time you put in."}
          </p>
        </div>
      ) : null}

      {(app.stage === "interview_invited" || app.stage === "interview_booked") && (
        <section className="space-y-3 rounded-2xl border border-black/10 bg-white p-6">
          <h2 className="text-[20px] text-[#1d1b1b]" style={{ fontFamily: SERIF }}>
            Stage 3 · 15-minute interview
          </h2>
          {app.stage === "interview_booked" ? (
            <p className="text-[14px] text-[#4b4b48]">You&rsquo;re booked. A confirmation email was sent.</p>
          ) : (
            <ul className="space-y-2">
              {slots.length === 0 ? (
                <li className="text-[14px] text-[#6b7280]">No open slots yet — check back soon.</li>
              ) : (
                slots.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/5 px-3 py-2"
                  >
                    <span className="text-[13px] text-[#1d1b1b]">
                      {new Date(s.startsAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: s.timezone,
                      })}{" "}
                      ({s.timezone})
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void bookSlot(s.id)}
                      className="rounded-md bg-[#1c1917] px-3 py-1.5 text-[12px] text-white"
                    >
                      Book
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
          <p className="text-[12px] text-[#9a9a9a]">
            You may reschedule once from this page while slots remain open. No-shows are recorded.
          </p>
        </section>
      )}

      {app.stage === "accepted" ? (
        <p className="text-[15px] text-[#4b4b48]">
          Accepted — check your email for the intern panel link.
        </p>
      ) : null}
    </div>
  );
}
