-- Superadmin kan opsætte byggepladskort for en kunde. Adgang via policies + to læse-RPC'er (superadmin ser ikke kundens sager direkte via RLS).
create or replace function private.proj_in_company(p_project uuid, p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.projects p where p.id = p_project and p.company_id = p_company)
$$;
revoke all on function private.proj_in_company(uuid, uuid) from public, anon;
grant execute on function private.proj_in_company(uuid, uuid) to authenticated;

create policy site_maps_sa_select on public.site_maps for select to authenticated using ((select private.is_superadmin()));
create policy site_maps_sa_insert on public.site_maps for insert to authenticated
  with check ((select private.is_superadmin()) and private.proj_in_company(project_id, company_id));
create policy site_maps_sa_update on public.site_maps for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()) and private.proj_in_company(project_id, company_id));
create policy site_maps_sa_delete on public.site_maps for delete to authenticated using ((select private.is_superadmin()));

create policy site_maps_obj_sa_select on storage.objects for select to authenticated using (bucket_id = 'site-maps' and (select private.is_superadmin()));
create policy site_maps_obj_sa_insert on storage.objects for insert to authenticated with check (bucket_id = 'site-maps' and (select private.is_superadmin()));
create policy site_maps_obj_sa_update on storage.objects for update to authenticated using (bucket_id = 'site-maps' and (select private.is_superadmin()));
create policy site_maps_obj_sa_delete on storage.objects for delete to authenticated using (bucket_id = 'site-maps' and (select private.is_superadmin()));

create or replace function public.sa_projects(p_company uuid)
returns table (id uuid, name text, case_number text, status text, lat double precision, lng double precision, n_maps bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_superadmin() then raise exception 'Ingen adgang'; end if;
  return query select p.id, p.name, p.case_number, p.status, p.lat, p.lng,
                      (select count(*) from public.site_maps m where m.project_id = p.id)
               from public.projects p where p.company_id = p_company order by p.created_at desc limit 200;
end $$;
revoke all on function public.sa_projects(uuid) from public, anon;
grant execute on function public.sa_projects(uuid) to authenticated;

create or replace function public.sa_ks_points(p_project uuid)
returns table (id uuid, category text, title text, note text, lat double precision, lng double precision, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_superadmin() then raise exception 'Ingen adgang'; end if;
  return query select e.id, e.category, e.title, e.note, e.lat, e.lng, e.created_at
               from public.photo_entries e where e.project_id = p_project and e.kind = 'ks' order by e.created_at limit 500;
end $$;
revoke all on function public.sa_ks_points(uuid) from public, anon;
grant execute on function public.sa_ks_points(uuid) to authenticated;
