-- Internship hiring funnel for getfalcon.co/jobs (three-stage application).
-- Service-role only: the Next.js server reads/writes with SUPABASE_SERVICE_ROLE_KEY.

create table if not exists public.internship_cycles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'open' check (status in ('draft', 'open', 'closed')),
  opens_at timestamptz,
  closes_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.internship_task_docs (
  id uuid primary key default gen_random_uuid(),
  department text not null check (department in ('community', 'media', 'research')),
  title text not null,
  body_md text not null default '',
  rubric_md text not null default '',
  deadline_at timestamptz,
  published boolean not null default false,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  docx_path text,
  docx_file_name text,
  docx_byte_size integer,
  docx_uploaded_at timestamptz,
  unique (department, version)
);

create table if not exists public.internship_applications (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid references public.internship_cycles(id) on delete set null,
  access_token text not null unique,
  full_name text not null,
  email text not null,
  school_year text not null default '',
  department text not null check (department in ('community', 'media', 'research')),
  availability text not null default '',
  answers jsonb not null default '{}'::jsonb,
  stage text not null default 'applied'
    check (stage in (
      'applied',
      'task_sent',
      'task_submitted',
      'task_scored',
      'interview_invited',
      'interview_booked',
      'interview_done',
      'accepted',
      'rejected',
      'withdrawn'
    )),
  score_pass boolean,
  score_notes text,
  score_rubric jsonb not null default '{}'::jsonb,
  scored_at timestamptz,
  scored_by text,
  interview_slot_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists internship_applications_email_idx
  on public.internship_applications (lower(email));
create index if not exists internship_applications_stage_idx
  on public.internship_applications (stage);
create index if not exists internship_applications_dept_idx
  on public.internship_applications (department);
create index if not exists internship_applications_created_idx
  on public.internship_applications (created_at desc);

create table if not exists public.internship_submissions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.internship_applications(id) on delete cascade,
  task_doc_id uuid references public.internship_task_docs(id) on delete set null,
  content_url text,
  content_text text,
  file_name text,
  submitted_at timestamptz not null default now(),
  unique (application_id)
);

create table if not exists public.internship_interview_slots (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'America/New_York',
  capacity int not null default 1,
  booked_count int not null default 0,
  is_open boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (booked_count >= 0 and booked_count <= capacity)
);

create index if not exists internship_interview_slots_starts_idx
  on public.internship_interview_slots (starts_at);

create table if not exists public.internship_interviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.internship_applications(id) on delete cascade,
  slot_id uuid not null references public.internship_interview_slots(id) on delete restrict,
  status text not null default 'booked'
    check (status in ('booked', 'rescheduled', 'completed', 'no_show', 'cancelled')),
  booked_at timestamptz not null default now(),
  reminder_sent_at timestamptz,
  unique (application_id)
);

create index if not exists internship_interviews_slot_idx
  on public.internship_interviews (slot_id);

alter table public.internship_applications
  drop constraint if exists internship_applications_interview_slot_id_fkey;
alter table public.internship_applications
  add constraint internship_applications_interview_slot_id_fkey
  foreign key (interview_slot_id) references public.internship_interview_slots(id)
  on delete set null;

create table if not exists public.internship_interns (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.internship_applications(id) on delete cascade,
  department text not null check (department in ('community', 'media', 'research')),
  full_name text not null,
  email text not null,
  status text not null default 'active'
    check (status in ('active', 'completed', 'withdrawn')),
  access_token text not null unique,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.internship_intern_tasks (
  id uuid primary key default gen_random_uuid(),
  intern_id uuid not null references public.internship_interns(id) on delete cascade,
  title text not null,
  description text not null default '',
  status text not null default 'todo'
    check (status in ('todo', 'in_progress', 'done')),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists internship_intern_tasks_intern_idx
  on public.internship_intern_tasks (intern_id);

alter table public.internship_cycles enable row level security;
alter table public.internship_task_docs enable row level security;
alter table public.internship_applications enable row level security;
alter table public.internship_submissions enable row level security;
alter table public.internship_interview_slots enable row level security;
alter table public.internship_interviews enable row level security;
alter table public.internship_interns enable row level security;
alter table public.internship_intern_tasks enable row level security;
-- Intentionally no policies: service-role only from the web server.
