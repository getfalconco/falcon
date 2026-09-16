import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { type Department } from "@/lib/internship-copy";
import {
  createApplication,
  InternshipTableMissingError,
} from "@/lib/internship";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sendEmail } from "@/lib/email";

// Careers roles ride the internship application pipeline; each role maps onto
// one of its departments (the table's check constraint only allows these).
const ROLE_DEPARTMENTS: Record<string, Department> = {
  "Content Lead": "media",
  "Community Manager": "community",
  "Research Analyst": "research",
};

const CV_BUCKET = "careers-cv";
const CV_MAX_BYTES = 4 * 1024 * 1024;
const CV_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
};
const INTRO_MAX_WORDS = 500;

export async function POST(request: Request) {
  const limited = rateLimit(`careers-apply:${clientIp(request)}`, {
    limit: 8,
    windowMs: 60 * 60 * 1000,
  });
  if (!limited.ok) return tooManyRequests(limited.retryAfter);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const role = String(form.get("role") ?? "").trim();
  const fullName = String(form.get("fullName") ?? "").trim();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const linkedin = String(form.get("linkedin") ?? "").trim();
  const introduction = String(form.get("introduction") ?? "").trim();
  const source = String(form.get("source") ?? "").trim();
  const referral = String(form.get("referral") ?? "").trim();
  const cv = form.get("cv");

  const department = ROLE_DEPARTMENTS[role];
  if (!department) {
    return NextResponse.json({ error: "Unknown role." }, { status: 400 });
  }
  if (!fullName || fullName.length < 2) {
    return NextResponse.json({ error: "Please enter your full name." }, { status: 400 });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email." }, { status: 400 });
  }
  if (!introduction) {
    return NextResponse.json({ error: "Please write a short introduction." }, { status: 400 });
  }
  if (introduction.split(/\s+/).filter(Boolean).length > INTRO_MAX_WORDS) {
    return NextResponse.json(
      { error: `Please keep the introduction under ${INTRO_MAX_WORDS} words.` },
      { status: 400 },
    );
  }
  if (!source) {
    return NextResponse.json({ error: "Please tell us how you found this role." }, { status: 400 });
  }

  // The CV is optional server-side; when present it must be a document within
  // the size cap. Storage failures shouldn't lose the application itself.
  let cvPath = "";
  let cvName = "";
  if (cv instanceof File && cv.size > 0) {
    const ext = CV_TYPES[cv.type];
    if (!ext) {
      return NextResponse.json(
        { error: "Please upload the CV as a PDF or Word document." },
        { status: 400 },
      );
    }
    if (cv.size > CV_MAX_BYTES) {
      return NextResponse.json({ error: "The CV must be 4MB or less." }, { status: 400 });
    }
    cvName = cv.name.replace(/[/\\?%*:|"<>]/g, "_").trim() || `cv${ext}`;
    const path = `${randomBytes(12).toString("hex")}-${cvName}`;
    try {
      const admin = getSupabaseAdmin();
      const buffer = Buffer.from(await cv.arrayBuffer());
      const { error } = await admin.storage
        .from(CV_BUCKET)
        .upload(path, buffer, { contentType: cv.type, upsert: false });
      if (error) console.error("careers cv upload failed", error);
      else cvPath = path;
    } catch (err) {
      // Keep going; the answers still record the file name.
      console.error("careers cv upload threw", err);
    }
  }

  try {
    await createApplication({
      fullName,
      email,
      schoolYear: "N/A (careers)",
      department,
      availability: "Flexible",
      answers: {
        role,
        linkedin,
        introduction,
        source,
        referral,
        cv_name: cvName,
        cv_path: cvPath,
      },
    });

    try {
      await sendEmail({
        to: email,
        subject: `Falcon — application received for ${role}`,
        html: `<p>Hi ${fullName.split(" ")[0]},</p><p>Thanks for applying for the ${role} role at Falcon. We read every application and will get back to you by email.</p><p>Falcon Team</p>`,
      });
    } catch {
      // The application is saved either way.
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InternshipTableMissingError) {
      return NextResponse.json(
        { error: "Applications are not open yet. Please try again later." },
        { status: 503 },
      );
    }
    console.error("careers apply failed", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
