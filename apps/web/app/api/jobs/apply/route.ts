import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import {
  APPLICATION_QUESTIONS,
  DEPARTMENTS,
  type Department,
} from "@/lib/internship-copy";
import {
  createApplication,
  candidatePortalUrl,
  InternshipTableMissingError,
} from "@/lib/internship";
import { sendEmail } from "@/lib/email";

function isDepartment(v: string): v is Department {
  return DEPARTMENTS.some((d) => d.key === v);
}

export async function POST(request: Request) {
  const limited = rateLimit(`jobs-apply:${clientIp(request)}`, {
    limit: 8,
    windowMs: 60 * 60 * 1000,
  });
  if (!limited.ok) return tooManyRequests(limited.retryAfter);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const fullName = String(body.fullName ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const schoolYear = String(body.schoolYear ?? "").trim();
  const department = String(body.department ?? "").trim();
  const availability = String(body.availability ?? "").trim();
  const rawAnswers = (body.answers as Record<string, string> | undefined) ?? {};

  if (!fullName || fullName.length < 2) {
    return NextResponse.json({ error: "Please enter your full name." }, { status: 400 });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email." }, { status: 400 });
  }
  if (!isDepartment(department)) {
    return NextResponse.json({ error: "Please choose a department." }, { status: 400 });
  }
  if (!schoolYear) {
    return NextResponse.json({ error: "Please enter your school year / class." }, { status: 400 });
  }
  if (!availability) {
    return NextResponse.json({ error: "Please share your availability." }, { status: 400 });
  }

  const answers: Record<string, string> = {};
  for (const q of APPLICATION_QUESTIONS) {
    const val = String(rawAnswers[q.id] ?? "").trim();
    if (!val) {
      return NextResponse.json({ error: `Please answer: ${q.label}` }, { status: 400 });
    }
    answers[q.id] = val.slice(0, q.maxLength);
  }

  try {
    const app = await createApplication({
      fullName,
      email,
      schoolYear,
      department,
      availability,
      answers,
    });

    const portal = candidatePortalUrl(app.accessToken);
    try {
      await sendEmail({
        to: email,
        subject: "Falcon internship — application received",
        html: `<p>Hi ${fullName.split(" ")[0]},</p>
<p>We received your application for the <strong>${department}</strong> internship track.</p>
<p>Track your status and complete later stages here (save this link):</p>
<p><a href="${portal}">${portal}</a></p>
<p>— Falcon</p>`,
        text: `Hi ${fullName},\n\nWe received your internship application. Portal: ${portal}\n\n— Falcon`,
      });
    } catch (err) {
      console.warn("[jobs apply] email failed", err);
    }

    return NextResponse.json({
      ok: true,
      portalUrl: portal,
      token: app.accessToken,
    });
  } catch (error) {
    if (error instanceof InternshipTableMissingError) {
      return NextResponse.json({ error: "Jobs system is not configured yet." }, { status: 503 });
    }
    console.error("[jobs apply]", error);
    return NextResponse.json({ error: "Could not submit application." }, { status: 500 });
  }
}
