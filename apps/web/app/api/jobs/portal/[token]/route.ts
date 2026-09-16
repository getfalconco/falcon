import { NextResponse } from "next/server";
import {
  bookInterview,
  candidatePortalUrl,
  getApplicationByToken,
  getPublishedTaskDoc,
  getSubmission,
  InternshipTableMissingError,
  listOpenSlots,
  submitTask,
  updateInternTaskStatus,
  getInternByToken,
  listInternTasks,
} from "@/lib/internship";
import { sendEmail } from "@/lib/email";

type Ctx = { params: { token: string } };

export async function GET(_request: Request, ctx: Ctx) {
  const { token } = ctx.params;
  try {
    const app = await getApplicationByToken(token);
    if (app) {
      const taskDoc =
        app.stage === "applied"
          ? null
          : await getPublishedTaskDoc(app.department);
      const submission = await getSubmission(app.id);
      const slots =
        app.stage === "interview_invited" || app.stage === "interview_booked"
          ? await listOpenSlots()
          : [];
      return NextResponse.json({
        kind: "candidate",
        application: { ...app, portalUrl: candidatePortalUrl(app.accessToken) },
        taskDoc: taskDoc
          ? {
              title: taskDoc.title,
              deadlineAt: taskDoc.deadlineAt,
              hasDocx: Boolean(taskDoc.docxPath),
              fileName: taskDoc.docxFileName,
              byteSize: taskDoc.docxByteSize,
              // Legacy markdown only if no docx has been uploaded yet.
              bodyMd: taskDoc.docxPath ? null : taskDoc.bodyMd || null,
              downloadPath: taskDoc.docxPath
                ? `/api/jobs/portal/${token}/task`
                : null,
            }
          : null,
        submission,
        slots,
      });
    }

    const intern = await getInternByToken(token);
    if (intern) {
      const tasks = await listInternTasks(intern.id);
      return NextResponse.json({ kind: "intern", intern, tasks });
    }

    return NextResponse.json({ error: "Portal link not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof InternshipTableMissingError) {
      return NextResponse.json({ error: "Jobs system not configured." }, { status: 503 });
    }
    console.error("[jobs portal GET]", error);
    return NextResponse.json({ error: "Failed to load portal." }, { status: 500 });
  }
}

export async function POST(request: Request, ctx: Ctx) {
  const { token } = ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }
  const action = String(body.action ?? "");

  try {
    const app = await getApplicationByToken(token);
    if (app) {
      if (action === "submit_task") {
        if (!["task_sent", "task_submitted"].includes(app.stage)) {
          return NextResponse.json({ error: "Task submission is not open." }, { status: 409 });
        }
        const taskDoc = await getPublishedTaskDoc(app.department);
        await submitTask({
          applicationId: app.id,
          taskDocId: taskDoc?.id ?? null,
          contentUrl: String(body.contentUrl ?? ""),
          contentText: String(body.contentText ?? ""),
        });
        return NextResponse.json({ ok: true });
      }

      if (action === "book_interview") {
        if (app.stage !== "interview_invited" && app.stage !== "interview_booked") {
          return NextResponse.json({ error: "Interview booking is not open." }, { status: 409 });
        }
        await bookInterview(app.id, String(body.slotId ?? ""));
        try {
          await sendEmail({
            to: app.email,
            subject: "Falcon internship — interview confirmed",
            html: `<p>Hi ${app.fullName.split(" ")[0]},</p>
<p>Your 15-minute interview is booked. Details are in your portal.</p>
<p><a href="${candidatePortalUrl(app.accessToken)}">Open portal</a></p>
<p>— Falcon</p>`,
          });
        } catch (err) {
          console.warn("[portal] confirm email failed", err);
        }
        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }

    const intern = await getInternByToken(token);
    if (intern && action === "update_task_status") {
      await updateInternTaskStatus(
        String(body.taskId ?? ""),
        String(body.status ?? "todo") as "todo" | "in_progress" | "done",
      );
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Portal link not found." }, { status: 404 });
  } catch (error) {
    console.error("[jobs portal POST]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action failed." },
      { status: 500 },
    );
  }
}
