import { NextResponse } from "next/server";
import { requireJobsAdmin } from "@/lib/admin-session";
import {
  InternshipTableMissingError,
  uploadDepartmentTaskDocx,
} from "@/lib/internship";
import type { Department } from "@/lib/internship-copy";
import { DEPARTMENTS } from "@/lib/internship-copy";

const MAX_BYTES = 10 * 1024 * 1024;
const DEPT_KEYS = new Set(DEPARTMENTS.map((d) => d.key));

export async function POST(request: Request) {
  const session = await requireJobsAdmin();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const department = String(form.get("department") ?? "") as Department;
    const titleRaw = form.get("title");
    const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : undefined;
    const file = form.get("file");

    if (!DEPT_KEYS.has(department)) {
      return NextResponse.json({ error: "Invalid department." }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a .docx file." }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File must be between 1 byte and 10 MB." }, { status: 400 });
    }

    const name = file.name || "task.docx";
    if (!name.toLowerCase().endsWith(".docx")) {
      return NextResponse.json({ error: "Only .docx files are accepted." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const doc = await uploadDepartmentTaskDocx(
      department,
      { buffer, fileName: name, byteSize: file.size },
      { title },
    );

    return NextResponse.json({ ok: true, doc });
  } catch (error) {
    if (error instanceof InternshipTableMissingError) {
      return NextResponse.json({ error: "Internship tables missing." }, { status: 503 });
    }
    console.error("[admin task-docx]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}
