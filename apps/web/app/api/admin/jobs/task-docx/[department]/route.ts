import { NextResponse } from "next/server";
import { requireJobsAdmin } from "@/lib/admin-session";
import {
  downloadTaskDocx,
  getPublishedTaskDoc,
  InternshipTableMissingError,
  listTaskDocs,
} from "@/lib/internship";
import type { Department } from "@/lib/internship-copy";
import { DEPARTMENTS } from "@/lib/internship-copy";

type Ctx = { params: { department: string } };

const DEPT_KEYS = new Set(DEPARTMENTS.map((d) => d.key));

export async function GET(_request: Request, ctx: Ctx) {
  const session = await requireJobsAdmin();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const department = ctx.params.department as Department;
  if (!DEPT_KEYS.has(department)) {
    return NextResponse.json({ error: "Invalid department." }, { status: 400 });
  }

  try {
    const doc = await getPublishedTaskDoc(department);
    if (!doc?.docxPath) {
      // Fall back to latest listed row for that department.
      const all = await listTaskDocs();
      const latest = all.find((d) => d.department === department && d.docxPath);
      if (!latest) {
        return NextResponse.json({ error: "No .docx uploaded for this role yet." }, { status: 404 });
      }
      const file = await downloadTaskDocx(latest);
      if (!file) {
        return NextResponse.json({ error: "File missing from storage." }, { status: 404 });
      }
      return new NextResponse(new Uint8Array(file.buffer), {
        headers: {
          "Content-Type": file.contentType,
          "Content-Disposition": `attachment; filename="${file.fileName}"`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    const file = await downloadTaskDocx(doc);
    if (!file) {
      return NextResponse.json({ error: "File missing from storage." }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(file.buffer), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof InternshipTableMissingError) {
      return NextResponse.json({ error: "Internship tables missing." }, { status: 503 });
    }
    console.error("[admin task-docx GET]", error);
    return NextResponse.json({ error: "Download failed." }, { status: 500 });
  }
}
