-- CVs and resumes uploaded through the careers apply flow. Private bucket:
-- only the service role (admin panel) ever reads these.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'careers-cv',
  'careers-cv',
  false,
  4194304,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
