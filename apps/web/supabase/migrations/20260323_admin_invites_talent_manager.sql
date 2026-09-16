-- Allow Talent Manager invites (Internships admin access).
alter table public.admin_invites drop constraint if exists admin_invites_role_check;
alter table public.admin_invites
  add constraint admin_invites_role_check
  check (role in ('staff', 'deputy', 'leader', 'talent_manager'));
