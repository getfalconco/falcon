import { NextResponse } from "next/server";
import { requireJobsAdmin } from "@/lib/admin-session";
import {
  acceptApplication,
  bookInterview,
  createInternTask,
  createInterviewSlot,
  funnelSummary,
  getSubmission,
  InternshipTableMissingError,
  internPortalUrl,
  listAllSlots,
  listApplications,
  listInternTasks,
  listInterns,
  listTaskDocs,
  scoreApplication,
  updateApplicationStage,
  updateTaskDoc,
  candidatePortalUrl,
} from "@/lib/internship";
import { sendEmail } from "@/lib/email";
import type { ApplicationStage } from "@/lib/internship";
import { departmentLabel } from "@/lib/internship-copy";

export async function GET(request: Request) {
  const session = await requireJobsAdmin();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const url = new URL(request.url);
  const view = url.searchParams.get("view") ?? "applications";

  try {
    if (view === "summary") {
      return NextResponse.json({ summary: await funnelSummary() });
    }
    if (view === "tasks") {
      return NextResponse.json({ docs: await listTaskDocs() });
    }
    if (view === "slots") {
      return NextResponse.json({ slots: await listAllSlots() });
    }
    if (view === "interns") {
      const interns = await listInterns();
      const withTasks = await Promise.all(
        interns.map(async (i) => ({
          ...i,
          portalUrl: internPortalUrl(i.accessToken),
          tasks: await listInternTasks(i.id),
        })),
      );
      return NextResponse.json({ interns: withTasks });
    }
    if (view === "submission") {
      const id = url.searchParams.get("id");
      if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
      return NextResponse.json({ submission: await getSubmission(id) });
    }

    const stage = url.searchParams.get("stage") ?? undefined;
    const department = url.searchParams.get("department") ?? undefined;
    const applications = await listApplications({ stage, department });
    return NextResponse.json({
      applications: applications.map((a) => ({
        ...a,
        portalUrl: candidatePortalUrl(a.accessToken),
      })),
    });
  } catch (error) {
    if (error instanceof InternshipTableMissingError) {
      return NextResponse.json({ error: "Internship tables missing. Run the SQL migration." }, { status: 503 });
    }
    console.error("[admin jobs GET]", error);
    return NextResponse.json({ error: "Failed to load jobs data." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireJobsAdmin();
  if (!session) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const action = String(body.action ?? "");

  try {
    if (action === "advance") {
      const id = String(body.id ?? "");
      const stage = String(body.stage ?? "") as ApplicationStage;
      const app = await updateApplicationStage(id, stage);
      if (stage === "task_sent" || stage === "interview_invited") {
        const portal = candidatePortalUrl(app.accessToken);
        try {
          await sendEmail({
            to: app.email,
            subject:
              stage === "task_sent"
                ? "Falcon internship — Stage 2 task"
                : "Falcon internship — book your interview",
            html: `<p>Hi ${app.fullName.split(" ")[0]},</p>
<p>Your ${departmentLabel(app.department)} application moved to the next stage.</p>
<p><a href="${portal}">Open your portal</a></p>
<p>— Falcon</p>`,
          });
        } catch (err) {
          console.warn("[admin jobs] notify failed", err);
        }
      }
      return NextResponse.json({ ok: true, application: app });
    }

    if (action === "score") {
      const app = await scoreApplication({
        id: String(body.id ?? ""),
        pass: Boolean(body.pass),
        notes: String(body.notes ?? ""),
        rubric: (body.rubric as Record<string, unknown>) ?? {},
        scoredBy: session.email,
      });
      return NextResponse.json({ ok: true, application: app });
    }

    if (action === "accept") {
      const intern = await acceptApplication(String(body.id ?? ""));
      const portal = internPortalUrl(intern.accessToken);
      try {
        await sendEmail({
          to: intern.email,
          subject: "Welcome to Falcon — internship accepted",
          html: `<p>Hi ${intern.fullName.split(" ")[0]},</p>
<p>You're in. Open your intern panel:</p>
<p><a href="${portal}">${portal}</a></p>
<p>— Falcon</p>`,
        });
      } catch (err) {
        console.warn("[admin jobs] accept email failed", err);
      }
      return NextResponse.json({ ok: true, intern, portalUrl: portal });
    }

    if (action === "create_slot") {
      const slot = await createInterviewSlot({
        startsAt: String(body.startsAt ?? ""),
        endsAt: String(body.endsAt ?? ""),
        timezone: String(body.timezone ?? "America/New_York"),
      });
      return NextResponse.json({ ok: true, slot });
    }

    if (action === "book") {
      await bookInterview(String(body.applicationId ?? ""), String(body.slotId ?? ""));
      return NextResponse.json({ ok: true });
    }

    if (action === "update_task_doc") {
      const doc = await updateTaskDoc(String(body.id ?? ""), {
        title: body.title !== undefined ? String(body.title) : undefined,
        bodyMd: body.bodyMd !== undefined ? String(body.bodyMd) : undefined,
        rubricMd: body.rubricMd !== undefined ? String(body.rubricMd) : undefined,
        published: body.published !== undefined ? Boolean(body.published) : undefined,
        deadlineAt: body.deadlineAt !== undefined ? (body.deadlineAt as string | null) : undefined,
      });
      return NextResponse.json({ ok: true, doc });
    }

    if (action === "create_intern_task") {
      const task = await createInternTask({
        internId: String(body.internId ?? ""),
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        dueAt: (body.dueAt as string | null) ?? null,
      });
      return NextResponse.json({ ok: true, task });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    console.error("[admin jobs POST]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action failed." },
      { status: 500 },
    );
  }
}
