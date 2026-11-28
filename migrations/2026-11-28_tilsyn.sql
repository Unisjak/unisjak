-- Bygherre / Tilsyn: en gæstebruger med ekstra standardrettigheder.
-- Ser sager (fejl og mangler / sikkerhed) tildelt dem, og må oprette nye på de sager (projekter), admin har tilknyttet dem.

alter table public.profiles add column if not exists guest_kind text not null default 'entreprenor';
alter table public.profiles drop constraint if exists profiles_guest_kind_chk;
alter table public.profiles add constraint profiles_guest_kind_chk check (guest_kind in ('entreprenor', 'tilsyn'));
grant update (guest_kind) on public.profiles to authenticated;

-- kun admin må ændre typen (en bruger må ikke gøre sig selv til tilsyn)
create or replace function private.guard_guest_kind() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.guest_kind is distinct from old.guest_kind and not coalesce(private.is_admin(), false) and auth.uid() is not null then
    raise exception 'Kun admin kan ændre brugertypen';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_guest_kind on public.profiles;
create trigger profiles_guard_guest_kind before update on public.profiles for each row execute function private.guard_guest_kind();

create or replace function private.tilsyn_company_id() returns uuid language sql stable security definer set search_path = '' as $$
  select company_id from public.profiles where id = auth.uid() and active and role::text = 'gaest' and guest_kind = 'tilsyn'
$$;

create or replace function private.tilsyn_member(p_project uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members pm
                  where pm.project_id = p_project and pm.user_id = auth.uid()
                    and pm.company_id = (select private.tilsyn_company_id()))
$$;

-- gæst kender en sag, hvis vedkommende har opgaver/sager på den – eller (tilsyn) er tilknyttet den af admin
create or replace function private.guest_has_project(p_project uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t
                  where t.project_id = p_project and auth.uid() = any (t.assignees)
                    and t.company_id = (select private.guest_company_id()))
      or exists (select 1 from public.photo_entries p
                  where p.project_id = p_project and p.kind = 'ks' and p.category in ('Afvigelse', 'Sikkerhed')
                    and auth.uid() = any (p.case_assignees) and p.company_id = (select private.guest_company_id()))
      or (select private.tilsyn_member(p_project))
$$;

-- tilsyn må oprette fejl og mangler + sikkerhed på tilknyttede sager (og ser dem selv, fordi de er sat som ansvarlig)
drop policy if exists photos_tilsyn_insert on public.photo_entries;
create policy photos_tilsyn_insert on public.photo_entries for insert to authenticated
  with check (
    company_id = (select private.tilsyn_company_id())
    and user_id = (select auth.uid())
    and kind = 'ks' and category in ('Afvigelse', 'Sikkerhed')
    and (select auth.uid()) = any (case_assignees)
    and (select private.tilsyn_member(project_id))
  );

-- gæster må ikke tilknyttes sager som medlem – undtagen Bygherre/Tilsyn
create or replace function private.no_guest_member() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles p where p.id = new.user_id and p.role::text = 'gaest' and p.guest_kind <> 'tilsyn') then
    raise exception 'En gæstebruger kan kun få tildelt opgaver';
  end if;
  return new;
end $$;
drop trigger if exists trg_no_guest on public.project_members;
create trigger trg_no_guest before insert or update on public.project_members for each row execute function private.no_guest_member();
