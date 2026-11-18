-- Profile photos for Settings > Account. Private bucket: each member reads and
-- writes only their own file, `<user_id>/avatar.<png|jpg|webp>`, and the app
-- shows it through a short-lived signed URL. The size and type limits match
-- lib/account/avatar.ts, so Storage rejects anything the browser check misses.
-- The path is kept in auth user_metadata.avatar_path.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars: owner reads own" on storage.objects;
create policy "avatars: owner reads own" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatars: owner uploads own" on storage.objects;
create policy "avatars: owner uploads own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and name in (
      (select auth.uid())::text || '/avatar.png',
      (select auth.uid())::text || '/avatar.jpg',
      (select auth.uid())::text || '/avatar.webp'
    )
  );

drop policy if exists "avatars: owner replaces own" on storage.objects;
create policy "avatars: owner replaces own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (
    bucket_id = 'avatars'
    and name in (
      (select auth.uid())::text || '/avatar.png',
      (select auth.uid())::text || '/avatar.jpg',
      (select auth.uid())::text || '/avatar.webp'
    )
  );

drop policy if exists "avatars: owner removes own" on storage.objects;
create policy "avatars: owner removes own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
