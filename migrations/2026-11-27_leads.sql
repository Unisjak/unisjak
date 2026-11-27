-- Leads fra forsiden og selvtilmelding -> CRM (med kilde), samt engangs-claim til mailnotifikation.
drop function if exists public.create_company(text, text);
create or replace function public.create_company(p_company_name text, p_full_name text, p_source text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_company uuid; v_email text; v_acc uuid;
begin
  if v_uid is null then raise exception 'Ikke logget ind'; end if;
  if not exists (select 1 from auth.users where id = v_uid and email_confirmed_at is not null) then raise exception 'E-mail er ikke bekræftet'; end if;
  if exists (select 1 from public.profiles where id = v_uid) then raise exception 'Brugeren tilhører allerede en virksomhed'; end if;
  insert into public.companies (name) values (btrim(p_company_name)) returning id into v_company;
  insert into public.profiles (id, company_id, full_name, role) values (v_uid, v_company, btrim(p_full_name), 'admin');
  -- CRM-kort så nye selvtilmeldinger vises i Kontrolcenteret med det samme
  select lower(email) into v_email from auth.users where id = v_uid;
  insert into public.crm_accounts (company_id, name, stage, source, next_followup)
    values (v_company, left(btrim(p_company_name), 160), 'proeve', left(coalesce(nullif(btrim(p_source), ''), 'Selvtilmelding'), 120), current_date)
    on conflict (company_id) do nothing returning id into v_acc;
  if v_acc is not null then
    if v_email ~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$' then
      insert into public.crm_contacts (account_id, name, email) values (v_acc, left(btrim(p_full_name), 120), v_email);
    end if;
    insert into public.crm_events (account_id, kind, text, created_by) values (v_acc, 'system', 'Tilmeldte sig selv på unisjak.dk', null);
  end if;
  return v_company;
end $$;
revoke all on function public.create_company(text, text, text) from public, anon;
grant execute on function public.create_company(text, text, text) to authenticated;

create or replace function public.public_lead(p_name text, p_company text, p_email text, p_phone text, p_message text, p_source text, p_hp text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare n text := btrim(coalesce(p_name, '')); e text := lower(btrim(coalesce(p_email, ''))); c text := btrim(coalesce(p_company, ''));
        ph text := nullif(btrim(coalesce(p_phone, '')), ''); m text := btrim(coalesce(p_message, '')); v_acc uuid;
begin
  if coalesce(p_hp, '') <> '' then return null; end if;           -- spam-fælde: lader som om det lykkedes
  if char_length(n) < 2 or char_length(n) > 120 then raise exception 'Skriv dit navn'; end if;
  if e !~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$' or char_length(e) > 200 then raise exception 'Skriv en gyldig e-mailadresse'; end if;
  if char_length(c) > 160 or char_length(m) > 2000 or (ph is not null and char_length(ph) > 40) then raise exception 'Teksten er for lang'; end if;
  select a.id into v_acc from public.crm_contacts k join public.crm_accounts a on a.id = k.account_id
    where k.email = e and a.company_id is null and a.created_at > now() - interval '24 hours' limit 1;
  if v_acc is not null then return v_acc; end if;                  -- samme person igen inden for 24 timer: samme sag
  if (select count(*) from public.crm_events where kind = 'system' and meta->>'lead' = '1' and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Der er travlt lige nu. Prøv igen om lidt, eller skriv til hej@unisjak.dk.';
  end if;
  insert into public.crm_accounts (name, stage, source, next_followup)
    values (left(coalesce(nullif(c, ''), n), 160), 'lead', left(coalesce(nullif(btrim(p_source), ''), 'Forsiden'), 120), current_date) returning id into v_acc;
  insert into public.crm_contacts (account_id, name, email, phone) values (v_acc, left(n, 120), e, ph);
  insert into public.crm_events (account_id, kind, text, meta, created_by)
    values (v_acc, 'system', 'Henvendelse fra forsiden' || case when m <> '' then ': ' || left(m, 3800) else '' end, jsonb_build_object('lead', '1'), null);
  return v_acc;
end $$;
revoke all on function public.public_lead(text, text, text, text, text, text, text) from public;
grant execute on function public.public_lead(text, text, text, text, text, text, text) to anon, authenticated;

-- Kun til Netlify-funktionen (service-nøgle): henter leadet én gang, så mailnotifikationen kun sendes én gang.
create or replace function public.lead_notify_claim(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a record; k record; ev record; r jsonb;
begin
  select * into a from public.crm_accounts where id = p_id and company_id is null and stage = 'lead' and created_at > now() - interval '1 day';
  if not found then return null; end if;
  if exists (select 1 from public.crm_events where account_id = p_id and meta->>'notified' = '1') then return null; end if;
  select * into k from public.crm_contacts where account_id = p_id order by created_at limit 1;
  select * into ev from public.crm_events where account_id = p_id and meta->>'lead' = '1' order by created_at limit 1;
  if not found then return null; end if;
  insert into public.crm_events (account_id, kind, text, meta, created_by) values (p_id, 'system', 'Mailnotifikation sendt', jsonb_build_object('notified', '1'), null);
  r := jsonb_build_object('company', a.name, 'source', a.source, 'name', k.name, 'email', k.email, 'phone', k.phone, 'text', ev.text);
  return r;
end $$;
revoke all on function public.lead_notify_claim(uuid) from public, anon, authenticated;
grant execute on function public.lead_notify_claim(uuid) to service_role;
