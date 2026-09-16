import { NextResponse } from "next/server";
import {
  downloadTaskDocx,
  getApplicationByToken,
  getPublishedTaskDoc,
  InternshipTableMissingError,
} from "@/lib/internship";

type Ctx = { params: { token: string } };

/** Candidate downloads the .docx for the department they applied to. */
export async function GET(_request: Request, ctx: Ctx) {
  const { token } = ctx.params;
  try {
    const app = await getApplicationByToken(token);
    if (!app) {
      return NextResponse.json({ error: "Portal link not found." }, { status: 404 });
    }
    if (app.stage === "applied") {
      return NextResponse.json(
        { error: "Your task brief is not available until Stage 2." },
        { status: 409 },
      );
    }

    const doc = await getPublishedTaskDoc(app.department);
    if (!doc?.docxPath) {
      return NextResponse.json(
        { error: "No task document has been published for this role yet." },
        { status: 404 },
      );
    }

    const file = await downloadTaskDocx(doc);
    if (!file) {
      return NextResponse.json({ error: "Task file is missing." }, { status: 404 });
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
      return NextResponse.json({ error: "Jobs system not configured." }, { status: 503 });
    }
    console.error("[jobs portal task GET]", error);
    return NextResponse.json({ error: "Failed to download task." }, { status: 500 });
  }
}
