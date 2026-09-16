-- Task briefs as .docx per department (admin upload → candidate download).
alter table public.internship_task_docs
  alter column body_md set default '',
  alter column rubric_md set default '';

alter table public.internship_task_docs
  add column if not exists docx_path text,
  add column if not exists docx_file_name text,
  add column if not exists docx_byte_size integer,
  add column if not exists docx_uploaded_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'internship-tasks',
  'internship-tasks',
  false,
  10485760,
  array[
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
