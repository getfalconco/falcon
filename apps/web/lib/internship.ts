import { randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "./supabase-admin";
import {
  DEFAULT_TASK_DOCS,
  type Department,
} from "./internship-copy";

export type ApplicationStage =
  | "applied"
  | "task_sent"
  | "task_submitted"
  | "task_scored"
  | "interview_invited"
  | "interview_booked"
  | "interview_done"
  | "accepted"
  | "rejected"
  | "withdrawn";

export type InternshipApplication = {
  id: string;
  cycleId: string | null;
  accessToken: string;
  fullName: string;
  email: string;
  schoolYear: string;
  department: Department;
  availability: string;
  answers: Record<string, string>;
  stage: ApplicationStage;
  scorePass: boolean | null;
  scoreNotes: string | null;
  scoreRubric: Record<string, unknown>;
  scoredAt: string | null;
  scoredBy: string | null;
  interviewSlotId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskDoc = {
  id: string;
  department: Department;
  title: string;
  bodyMd: string;
  rubricMd: string;
  deadlineAt: string | null;
  published: boolean;
  version: number;
  updatedAt: string;
  docxPath: string | null;
  docxFileName: string | null;
  docxByteSize: number | null;
  docxUploadedAt: string | null;
};

export type InterviewSlot = {
  id: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  capacity: number;
  bookedCount: number;
  isOpen: boolean;
};

export type Intern = {
  id: string;
  applicationId: string;
  department: Department;
  fullName: string;
  email: string;
  status: "active" | "completed" | "withdrawn";
  accessToken: string;
  notes: string;
  createdAt: string;
};

export type InternTask = {
  id: string;
  internId: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done";
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class InternshipTableMissingError extends Error {
  constructor() {
    super("internship tables do not exist");
    this.name = "InternshipTableMissingError";
  }
}

function isMissingTableError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /internship_/i.test(error.message ?? "") && /exist/i.test(error.message ?? "");
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function siteOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    process.env.URL?.replace(/\/$/, "") ||
    "https://getfalcon.co"
  );
}

export function candidatePortalUrl(token: string): string {
  return `${siteOrigin()}/careers/portal/${token}`;
}

export function internPortalUrl(token: string): string {
  return `${siteOrigin()}/careers/intern/${token}`;
}

function mapApplication(row: Record<string, unknown>): InternshipApplication {
  return {
    id: String(row.id),
    cycleId: (row.cycle_id as string | null) ?? null,
    accessToken: String(row.access_token),
    fullName: String(row.full_name),
    email: String(row.email),
    schoolYear: String(row.school_year ?? ""),
    department: row.department as Department,
    availability: String(row.availability ?? ""),
    answers: (row.answers as Record<string, string>) ?? {},
    stage: row.stage as ApplicationStage,
    scorePass: (row.score_pass as boolean | null) ?? null,
    scoreNotes: (row.score_notes as string | null) ?? null,
    scoreRubric: (row.score_rubric as Record<string, unknown>) ?? {},
    scoredAt: (row.scored_at as string | null) ?? null,
    scoredBy: (row.scored_by as string | null) ?? null,
    interviewSlotId: (row.interview_slot_id as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTaskDoc(row: Record<string, unknown>): TaskDoc {
  return {
    id: String(row.id),
    department: row.department as Department,
    title: String(row.title),
    bodyMd: String(row.body_md ?? ""),
    rubricMd: String(row.rubric_md ?? ""),
    deadlineAt: (row.deadline_at as string | null) ?? null,
    published: Boolean(row.published),
    version: Number(row.version),
    updatedAt: String(row.updated_at),
    docxPath: (row.docx_path as string | null) ?? null,
    docxFileName: (row.docx_file_name as string | null) ?? null,
    docxByteSize: row.docx_byte_size != null ? Number(row.docx_byte_size) : null,
    docxUploadedAt: (row.docx_uploaded_at as string | null) ?? null,
  };
}

function mapSlot(row: Record<string, unknown>): InterviewSlot {
  return {
    id: String(row.id),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    timezone: String(row.timezone ?? "America/New_York"),
    capacity: Number(row.capacity),
    bookedCount: Number(row.booked_count),
    isOpen: Boolean(row.is_open),
  };
}

function mapIntern(row: Record<string, unknown>): Intern {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    department: row.department as Department,
    fullName: String(row.full_name),
    email: String(row.email),
    status: row.status as Intern["status"],
    accessToken: String(row.access_token),
    notes: String(row.notes ?? ""),
    createdAt: String(row.created_at),
  };
}

function mapInternTask(row: Record<string, unknown>): InternTask {
  return {
    id: String(row.id),
    internId: String(row.intern_id),
    title: String(row.title),
    description: String(row.description ?? ""),
    status: row.status as InternTask["status"],
    dueAt: (row.due_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getOpenCycleId(): Promise<string | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_cycles")
    .select("id")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return data?.id ?? null;
}

export async function createApplication(input: {
  fullName: string;
  email: string;
  schoolYear: string;
  department: Department;
  availability: string;
  answers: Record<string, string>;
}): Promise<InternshipApplication> {
  const admin = getSupabaseAdmin();
  const cycleId = await getOpenCycleId();
  const accessToken = newToken();

  const { data, error } = await admin
    .from("internship_applications")
    .insert({
      cycle_id: cycleId,
      access_token: accessToken,
      full_name: input.fullName.trim(),
      email: input.email.trim().toLowerCase(),
      school_year: input.schoolYear.trim(),
      department: input.department,
      availability: input.availability.trim(),
      answers: input.answers,
      stage: "applied",
    })
    .select("*")
    .single();

  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return mapApplication(data as Record<string, unknown>);
}

export async function listApplications(filters?: {
  stage?: string;
  department?: string;
}): Promise<InternshipApplication[]> {
  const admin = getSupabaseAdmin();
  let q = admin
    .from("internship_applications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (filters?.stage) q = q.eq("stage", filters.stage);
  if (filters?.department) q = q.eq("department", filters.department);

  const { data, error } = await q;
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return (data ?? []).map((r) => mapApplication(r as Record<string, unknown>));
}

export async function getApplicationByToken(token: string): Promise<InternshipApplication | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_applications")
    .select("*")
    .eq("access_token", token)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return data ? mapApplication(data as Record<string, unknown>) : null;
}

export async function getApplicationById(id: string): Promise<InternshipApplication | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_applications")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return data ? mapApplication(data as Record<string, unknown>) : null;
}

export async function updateApplicationStage(
  id: string,
  stage: ApplicationStage,
  extra: Record<string, unknown> = {},
): Promise<InternshipApplication> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_applications")
    .update({ stage, updated_at: new Date().toISOString(), ...extra })
    .eq("id", id)
    .select("*")
    .single();
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return mapApplication(data as Record<string, unknown>);
}

export async function ensureDefaultTaskDocs(): Promise<void> {
  const admin = getSupabaseAdmin();
  for (const dept of Object.keys(DEFAULT_TASK_DOCS) as Department[]) {
    const { data } = await admin
      .from("internship_task_docs")
      .select("id")
      .eq("department", dept)
      .limit(1)
      .maybeSingle();
    if (data) continue;
    const seed = DEFAULT_TASK_DOCS[dept];
    const { error } = await admin.from("internship_task_docs").insert({
      department: dept,
      title: seed.title,
      body_md: "",
      rubric_md: seed.rubric_md,
      published: true,
      version: 1,
    });
    if (error && !isMissingTableError(error)) throw error;
  }
}

const TASK_DOCX_BUCKET = "internship-tasks";
const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function sanitizeDocxFileName(name: string): string {
  const base = name.replace(/[/\\?%*:|"<>]/g, "_").trim() || "task.docx";
  return base.toLowerCase().endsWith(".docx") ? base : `${base}.docx`;
}

export async function uploadDepartmentTaskDocx(
  department: Department,
  file: { buffer: Buffer; fileName: string; byteSize: number },
  opts?: { title?: string },
): Promise<TaskDoc> {
  await ensureDefaultTaskDocs();
  const admin = getSupabaseAdmin();

  const existing = await getPublishedTaskDoc(department);
  let docId = existing?.id;
  if (!docId) {
    const { data, error } = await admin
      .from("internship_task_docs")
      .insert({
        department,
        title: opts?.title?.trim() || DEFAULT_TASK_DOCS[department].title,
        body_md: "",
        rubric_md: "",
        published: true,
        version: 1,
      })
      .select("*")
      .single();
    if (error) throw error;
    docId = String(data.id);
  }

  const safeName = sanitizeDocxFileName(file.fileName);
  const path = `${department}/${docId}/${safeName}`;

  if (existing?.docxPath && existing.docxPath !== path) {
    await admin.storage.from(TASK_DOCX_BUCKET).remove([existing.docxPath]).catch(() => {});
  }

  const { error: upErr } = await admin.storage.from(TASK_DOCX_BUCKET).upload(path, file.buffer, {
    contentType: DOCX_CONTENT_TYPE,
    upsert: true,
  });
  if (upErr) throw upErr;

  const { data, error } = await admin
    .from("internship_task_docs")
    .update({
      title: opts?.title?.trim() || existing?.title || DEFAULT_TASK_DOCS[department].title,
      body_md: "",
      docx_path: path,
      docx_file_name: safeName,
      docx_byte_size: file.byteSize,
      docx_uploaded_at: new Date().toISOString(),
      published: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", docId)
    .select("*")
    .single();
  if (error) throw error;
  return mapTaskDoc(data as Record<string, unknown>);
}

export async function downloadTaskDocx(
  doc: TaskDoc,
): Promise<{ buffer: Buffer; fileName: string; contentType: string } | null> {
  if (!doc.docxPath) return null;
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.storage.from(TASK_DOCX_BUCKET).download(doc.docxPath);
  if (error || !data) return null;
  const ab = await data.arrayBuffer();
  return {
    buffer: Buffer.from(ab),
    fileName: doc.docxFileName ?? "task.docx",
    contentType: DOCX_CONTENT_TYPE,
  };
}

export async function listTaskDocs(): Promise<TaskDoc[]> {
  await ensureDefaultTaskDocs();
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_task_docs")
    .select("*")
    .order("department")
    .order("version", { ascending: false });
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return (data ?? []).map((r) => mapTaskDoc(r as Record<string, unknown>));
}

export async function getPublishedTaskDoc(department: Department): Promise<TaskDoc | null> {
  await ensureDefaultTaskDocs();
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_task_docs")
    .select("*")
    .eq("department", department)
    .eq("published", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return data ? mapTaskDoc(data as Record<string, unknown>) : null;
}

export async function updateTaskDoc(
  id: string,
  patch: { title?: string; bodyMd?: string; rubricMd?: string; published?: boolean; deadlineAt?: string | null },
): Promise<TaskDoc> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_task_docs")
    .update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.bodyMd !== undefined ? { body_md: patch.bodyMd } : {}),
      ...(patch.rubricMd !== undefined ? { rubric_md: patch.rubricMd } : {}),
      ...(patch.published !== undefined ? { published: patch.published } : {}),
      ...(patch.deadlineAt !== undefined ? { deadline_at: patch.deadlineAt } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapTaskDoc(data as Record<string, unknown>);
}

export async function submitTask(input: {
  applicationId: string;
  taskDocId: string | null;
  contentUrl?: string;
  contentText?: string;
}): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error: subErr } = await admin.from("internship_submissions").upsert(
    {
      application_id: input.applicationId,
      task_doc_id: input.taskDocId,
      content_url: input.contentUrl?.trim() || null,
      content_text: input.contentText?.trim() || null,
      submitted_at: new Date().toISOString(),
    },
    { onConflict: "application_id" },
  );
  if (subErr) throw subErr;
  await updateApplicationStage(input.applicationId, "task_submitted");
}

export async function getSubmission(applicationId: string) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_submissions")
    .select("*")
    .eq("application_id", applicationId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function scoreApplication(input: {
  id: string;
  pass: boolean;
  notes: string;
  rubric: Record<string, unknown>;
  scoredBy: string;
}): Promise<InternshipApplication> {
  const nextStage: ApplicationStage = input.pass ? "task_scored" : "rejected";
  return updateApplicationStage(input.id, nextStage, {
    score_pass: input.pass,
    score_notes: input.notes,
    score_rubric: input.rubric,
    scored_at: new Date().toISOString(),
    scored_by: input.scoredBy,
  });
}

export async function listOpenSlots(): Promise<InterviewSlot[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_interview_slots")
    .select("*")
    .eq("is_open", true)
    .gt("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(100);
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return (data ?? [])
    .map((r) => mapSlot(r as Record<string, unknown>))
    .filter((s) => s.bookedCount < s.capacity);
}

export async function listAllSlots(): Promise<InterviewSlot[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_interview_slots")
    .select("*")
    .order("starts_at", { ascending: true })
    .limit(200);
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return (data ?? []).map((r) => mapSlot(r as Record<string, unknown>));
}

export async function createInterviewSlot(input: {
  startsAt: string;
  endsAt: string;
  timezone?: string;
}): Promise<InterviewSlot> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_interview_slots")
    .insert({
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      timezone: input.timezone ?? "America/New_York",
      capacity: 1,
      booked_count: 0,
      is_open: true,
    })
    .select("*")
    .single();
  if (error) throw error;
  return mapSlot(data as Record<string, unknown>);
}

export async function bookInterview(applicationId: string, slotId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data: slot, error: slotErr } = await admin
    .from("internship_interview_slots")
    .select("*")
    .eq("id", slotId)
    .single();
  if (slotErr) throw slotErr;
  const mapped = mapSlot(slot as Record<string, unknown>);
  if (!mapped.isOpen || mapped.bookedCount >= mapped.capacity) {
    throw new Error("That interview slot is no longer available.");
  }

  const { error: bookErr } = await admin.from("internship_interviews").upsert(
    {
      application_id: applicationId,
      slot_id: slotId,
      status: "booked",
      booked_at: new Date().toISOString(),
    },
    { onConflict: "application_id" },
  );
  if (bookErr) throw bookErr;

  const { error: bumpErr } = await admin
    .from("internship_interview_slots")
    .update({ booked_count: mapped.bookedCount + 1 })
    .eq("id", slotId)
    .eq("booked_count", mapped.bookedCount);
  if (bumpErr) throw bumpErr;

  await updateApplicationStage(applicationId, "interview_booked", {
    interview_slot_id: slotId,
  });
}

export async function acceptApplication(id: string): Promise<Intern> {
  const app = await getApplicationById(id);
  if (!app) throw new Error("Application not found.");
  await updateApplicationStage(id, "accepted");
  const admin = getSupabaseAdmin();
  const token = newToken();
  const { data, error } = await admin
    .from("internship_interns")
    .upsert(
      {
        application_id: id,
        department: app.department,
        full_name: app.fullName,
        email: app.email,
        status: "active",
        access_token: token,
      },
      { onConflict: "application_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return mapIntern(data as Record<string, unknown>);
}

export async function listInterns(): Promise<Intern[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_interns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTableError(error)) throw new InternshipTableMissingError();
    throw error;
  }
  return (data ?? []).map((r) => mapIntern(r as Record<string, unknown>));
}

export async function getInternByToken(token: string): Promise<Intern | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_interns")
    .select("*")
    .eq("access_token", token)
    .maybeSingle();
  if (error) throw error;
  return data ? mapIntern(data as Record<string, unknown>) : null;
}

export async function listInternTasks(internId: string): Promise<InternTask[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_intern_tasks")
    .select("*")
    .eq("intern_id", internId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => mapInternTask(r as Record<string, unknown>));
}

export async function createInternTask(input: {
  internId: string;
  title: string;
  description?: string;
  dueAt?: string | null;
}): Promise<InternTask> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("internship_intern_tasks")
    .insert({
      intern_id: input.internId,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      due_at: input.dueAt ?? null,
      status: "todo",
    })
    .select("*")
    .single();
  if (error) throw error;
  return mapInternTask(data as Record<string, unknown>);
}

export async function updateInternTaskStatus(
  id: string,
  status: InternTask["status"],
): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from("internship_intern_tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function funnelSummary(): Promise<Record<string, number>> {
  const apps = await listApplications();
  const counts: Record<string, number> = {};
  for (const a of apps) {
    counts[a.stage] = (counts[a.stage] ?? 0) + 1;
  }
  counts.total = apps.length;
  return counts;
}
