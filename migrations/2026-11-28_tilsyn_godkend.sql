-- Bygherre / Tilsyn: admin godkender, hvad der sendes videre; bygherren godkender/afviser udbedring; adgang til kort.

alter table public.photo_entries
  add column if not exists tilsyn_sent_at timestamptz,
  add column if not exists tilsyn_decision text,
  add column if not exists tilsyn_decision_at timestamptz,
  add column if not exists tilsyn_decision_by uuid,
  add column if not exists tilsyn_decision_note text;
alter table public.photo_entries drop constraint if exists photo_entries_tilsyn_decision_chk;
alter table public.photo_entries add constraint photo_entries_tilsyn_decision_chk check (tilsyn_decision is null or tilsyn_decision in ('godkendt', 'afvist'));

alter table public.ks_updates add column if not exists tilsyn_visible boolean not null default false;

-- de nye felter må kun ændres via funktionerne herunder
create or replace function private.guard_tilsyn_cols() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('unisjak.tilsyn', true), '') <> '1' then
    if tg_op = 'INSERT' then
      new.tilsyn_sent_at := null; new.tilsyn_decision := null; new.tilsyn_decision_at := null; new.tilsyn_decision_by := null; new.tilsyn_decision_note := null;
    else
      new.tilsyn_sent_at := old.tilsyn_sent_at; new.tilsyn_decision := old.tilsyn_decision; new.tilsyn_decision_at := old.tilsyn_decision_at;
      new.tilsyn_decision_by := old.tilsyn_decision_by; new.tilsyn_decision_note := old.tilsyn_decision_note;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists photo_entries_guard_tilsyn on public.photo_entries;
create trigger photo_entries_guard_tilsyn before insert or update on public.photo_entries for each row execute function private.guard_tilsyn_cols();

-- kun admin (eller funktionerne) må sætte "synlig for tilsyn" på en opdatering
create or replace function private.guard_tilsyn_visible() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(private.is_manager(), false) and coalesce(current_setting('unisjak.tilsyn', true), '') <> '1' then
    if tg_op = 'INSERT' then new.tilsyn_visible := false; else new.tilsyn_visible := old.tilsyn_visible; end if;
  end if;
  return new;
end $$;
drop trigger if exists ks_updates_guard_visible on public.ks_updates;
create trigger ks_updates_guard_visible before insert or update on public.ks_updates for each row execute function private.guard_tilsyn_visible();

-- tilsyn ser kun egne opdateringer + dem admin har delt
drop policy if exists ks_updates_guest_select on public.ks_updates;
create policy ks_updates_guest_select on public.ks_updates for select to authenticated
  using (company_id = (select private.guest_company_id()) and private.guest_case_ok(photo_id)
         and ((select private.tilsyn_company_id()) is null or user_id = (select auth.uid()) or tilsyn_visible));

-- admin deler/skjuler en opdatering for bygherren
create or replace function public.ks_update_share(p_id uuid, p_on boolean) returns public.ks_updates language plpgsql security definer set search_path = '' as $$
declare r public.ks_updates;
begin
  if not private.is_manager() then raise exception 'Kun admin kan dele med bygherren'; end if;
  perform set_config('unisjak.tilsyn', '1', true);
  update public.ks_updates set tilsyn_visible = coalesce(p_on, false) where id = p_id and company_id = private.my_company_id() returning * into r;
  perform set_config('unisjak.tilsyn', '0', true);
  if r.id is null then raise exception 'Ukendt opdatering'; end if;
  return r;
end $$;

-- admin sender et afsluttet punkt til bygherren/tilsynet til godkendelse
create or replace function public.case_send_to_tilsyn(p_id uuid, p_note text default null) returns public.photo_entries language plpgsql security definer set search_path = '' as $$
declare pt public.photo_entries; r public.photo_entries; v_note text := nullif(left(btrim(coalesce(p_note, '')), 2000), '');
begin
  if not private.is_manager() then raise exception 'Kun admin kan sende til bygherren'; end if;
  select * into pt from public.photo_entries where id = p_id and company_id = private.my_company_id() and kind = 'ks' and category in ('Afvigelse', 'Sikkerhed');
  if not found then raise exception 'Ukendt punkt'; end if;
  if (case when pt.safety_level is not null then pt.safety_closed_at else pt.dev_closed_at end) is null then raise exception 'Afslut punktet først'; end if;
  if not exists (select 1 from public.profiles pr where pr.id = any (pt.case_assignees) and pr.role::text = 'gaest' and pr.guest_kind = 'tilsyn' and pr.active) then
    raise exception 'Der er ingen bygherre/tilsyn på punktet'; end if;
  perform set_config('unisjak.tilsyn', '1', true);
  update public.photo_entries set tilsyn_sent_at = now(), tilsyn_decision = null, tilsyn_decision_at = null, tilsyn_decision_by = null, tilsyn_decision_note = null
   where id = p_id returning * into r;
  insert into public.ks_updates (company_id, photo_id, user_id, kind, text, tilsyn_visible)
    values (r.company_id, r.id, auth.uid(), 'status', 'Sendt til godkendelse hos bygherre/tilsyn' || coalesce(': ' || v_note, ''), true);
  perform set_config('unisjak.tilsyn', '0', true);
  return r;
end $$;

-- bygherre/tilsyn godkender eller afviser (afvist åbner punktet igen)
create or replace function public.case_tilsyn_decide(p_id uuid, p_decision text, p_note text default null) returns public.photo_entries language plpgsql security definer set search_path = '' as $$
declare pt public.photo_entries; r public.photo_entries; v_note text := nullif(left(btrim(coalesce(p_note, '')), 2000), '');
begin
  if private.tilsyn_company_id() is null then raise exception 'Kun bygherre/tilsyn kan godkende'; end if;
  if p_decision not in ('godkendt', 'afvist') then raise exception 'Ugyldigt valg'; end if;
  if p_decision = 'afvist' and v_note is null then raise exception 'Skriv, hvad der ikke er i orden'; end if;
  select * into pt from public.photo_entries where id = p_id and company_id = private.tilsyn_company_id() and kind = 'ks' and category in ('Afvigelse', 'Sikkerhed') and auth.uid() = any (case_assignees);
  if not found then raise exception 'Ukendt punkt'; end if;
  if pt.tilsyn_sent_at is null or pt.tilsyn_decision is not null then raise exception 'Punktet er ikke sendt til din godkendelse'; end if;
  perform set_config('unisjak.tilsyn', '1', true);
  perform set_config('unisjak.case', '1', true);
  perform set_config('unisjak.extra', '1', true);
  if p_decision = 'afvist' then
    update public.photo_entries set tilsyn_decision = 'afvist', tilsyn_decision_at = now(), tilsyn_decision_by = auth.uid(), tilsyn_decision_note = v_note,
        dev_closed_at = null, dev_closed_by = null, dev_close_note = null, safety_closed_at = null, safety_closed_by = null, safety_close_note = null
      where id = p_id returning * into r;
  else
    update public.photo_entries set tilsyn_decision = 'godkendt', tilsyn_decision_at = now(), tilsyn_decision_by = auth.uid(), tilsyn_decision_note = v_note
      where id = p_id returning * into r;
  end if;
  insert into public.ks_updates (company_id, photo_id, user_id, kind, text, tilsyn_visible)
    values (r.company_id, r.id, auth.uid(), 'status', case when p_decision = 'godkendt' then 'Godkendt af bygherre/tilsyn' else 'Afvist af bygherre/tilsyn' end || coalesce(': ' || v_note, ''), true);
  perform set_config('unisjak.tilsyn', '0', true); perform set_config('unisjak.case', '0', true); perform set_config('unisjak.extra', '0', true);
  return r;
end $$;
revoke all on function public.ks_update_share(uuid, boolean), public.case_send_to_tilsyn(uuid, text), public.case_tilsyn_decide(uuid, text, text) from public, anon;
grant execute on function public.ks_update_share(uuid, boolean), public.case_send_to_tilsyn(uuid, text), public.case_tilsyn_decide(uuid, text, text) to authenticated;

-- admin ændrer ansvarlig: den bygherre, der oprettede punktet, bliver stående
create or replace function public.case_assign(p_id uuid, p_users uuid[]) returns public.photo_entries language plpgsql security definer set search_path = '' as $$
declare r public.photo_entries;
begin
  if not private.is_manager() then raise exception 'Kun admin kan vælge ansvarlig'; end if;
  perform set_config('unisjak.case', '1', true);
  update public.photo_entries pe set case_assignees = (
      select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_users, '{}') ||
        case when exists (select 1 from public.profiles pr where pr.id = pe.user_id and pr.role::text = 'gaest' and pr.guest_kind = 'tilsyn') then array[pe.user_id] else '{}'::uuid[] end) x)
   where pe.id = p_id and pe.company_id = private.my_company_id() and pe.kind = 'ks' and pe.category in ('Afvigelse', 'Sikkerhed')
   returning * into r;
  perform set_config('unisjak.case', '0', true);
  if r.id is null then raise exception 'Ukendt punkt'; end if;
  return r;
end $$;

-- bygherre/tilsyn bruger Godkend/Afvis – ikke Afslut/Åbn igen
create or replace function public.case_close(p_id uuid, p_close boolean, p_note text default null) returns public.photo_entries language plpgsql security definer set search_path = '' as $$
declare pt public.photo_entries; r public.photo_entries; was boolean; v_note text := nullif(left(btrim(coalesce(p_note, '')), 2000), '');
begin
  if private.tilsyn_company_id() is not null then raise exception 'Bygherre/tilsyn bruger Godkend eller Afvis'; end if;
  select * into pt from public.photo_entries
   where id = p_id and company_id = private.any_company_id() and kind = 'ks' and not coalesce(is_extra, false) and category in ('Afvigelse', 'Sikkerhed');
  if not found then raise exception 'Ukendt punkt'; end if;
  if not (private.is_manager() or private.is_project_member(pt.project_id)
          or (private.is_guest() and auth.uid() = any (pt.case_assignees))) then raise exception 'Du kan ikke afslutte dette punkt'; end if;
  was := (case when pt.safety_level is not null then pt.safety_closed_at else pt.dev_closed_at end) is not null;
  perform set_config('unisjak.case', '1', true);
  perform set_config('unisjak.extra', '1', true);
  if pt.safety_level is not null then
    update public.photo_entries set
        safety_closed_at = case when p_close then coalesce(safety_closed_at, now()) else null end,
        safety_closed_by = case when p_close then coalesce(safety_closed_by, auth.uid()) else null end,
        safety_close_note = case when p_close then v_note else null end
      where id = p_id returning * into r;
  else
    update public.photo_entries set
        dev_closed_at = case when p_close then coalesce(dev_closed_at, now()) else null end,
        dev_closed_by = case when p_close then coalesce(dev_closed_by, auth.uid()) else null end,
        dev_close_note = case when p_close then v_note else null end
      where id = p_id returning * into r;
  end if;
  perform set_config('unisjak.case', '0', true);
  perform set_config('unisjak.extra', '0', true);
  if was is distinct from p_close then
    insert into public.ks_updates (company_id, photo_id, user_id, kind, text)
      values (r.company_id, r.id, auth.uid(), 'status', case when p_close then 'Afsluttet' || coalesce(': ' || v_note, '') else 'Åbnet igen' end);
  end if;
  return r;
end $$;

-- kort: tilsyn må se byggepladskortene på de sager, de er tilknyttet
drop policy if exists site_maps_tilsyn_select on public.site_maps;
create policy site_maps_tilsyn_select on public.site_maps for select to authenticated
  using (company_id = (select private.tilsyn_company_id()) and (select private.tilsyn_member(project_id)));
drop policy if exists site_maps_obj_tilsyn_select on storage.objects;
create policy site_maps_obj_tilsyn_select on storage.objects for select to authenticated
  using (bucket_id = 'site-maps' and (storage.foldername(name))[1] = (select private.tilsyn_company_id())::text and (select private.tilsyn_member(((storage.foldername(name))[2])::uuid)));
