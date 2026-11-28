-- Byggepladskort: tegning/luftfoto pr. projekt, justeret med kontrolpunkter (pixel <-> GPS/UTM). KS-pins bruger de GPS-koordinater, KS-punkterne allerede har.
create table if not exists public.site_maps (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  file_path text not null check (char_length(file_path) < 300),
  width int not null check (width between 100 and 8000),
  height int not null check (height between 100 and 8000),
  ctrl jsonb not null default '[]'::jsonb check (jsonb_typeof(ctrl) = 'array' and jsonb_array_length(ctrl) <= 12),
  crs text not null default 'EPSG:25832' check (crs in ('EPSG:25832', 'EPSG:25833', 'WGS84')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (file_path like company_id::text || '/' || project_id::text || '/%')
);
create index if not exists site_maps_project_idx on public.site_maps (project_id, created_at);
alter table public.site_maps enable row level security;
revoke all on public.site_maps from anon;
grant select, insert, update, delete on public.site_maps to authenticated;

create policy site_maps_select on public.site_maps for select to authenticated
  using (company_id = (select private.my_company_id()) and ((select private.is_manager()) or private.is_project_member(project_id)));
create policy site_maps_insert on public.site_maps for insert to authenticated
  with check (company_id = (select private.my_company_id()) and (select private.is_manager())
              and exists (select 1 from public.projects p where p.id = project_id and p.company_id = company_id));
create policy site_maps_update on public.site_maps for update to authenticated
  using (company_id = (select private.my_company_id()) and (select private.is_manager()))
  with check (company_id = (select private.my_company_id()) and (select private.is_manager())
              and exists (select 1 from public.projects p where p.id = project_id and p.company_id = company_id));
create policy site_maps_delete on public.site_maps for delete to authenticated
  using (company_id = (select private.my_company_id()) and (select private.is_manager()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-maps', 'site-maps', false, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy site_maps_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'site-maps' and (storage.foldername(name))[1] = (select private.my_company_id())::text
         and ((select private.is_manager()) or private.is_project_member(((storage.foldername(name))[2])::uuid)));
create policy site_maps_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'site-maps' and (storage.foldername(name))[1] = (select private.my_company_id())::text and (select private.is_manager()));
create policy site_maps_obj_update on storage.objects for update to authenticated
  using (bucket_id = 'site-maps' and (storage.foldername(name))[1] = (select private.my_company_id())::text and (select private.is_manager()));
create policy site_maps_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'site-maps' and (storage.foldername(name))[1] = (select private.my_company_id())::text and (select private.is_manager()));
