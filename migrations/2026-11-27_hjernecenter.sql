-- Hjernecenter: globale indstillinger, ændringslog og overblik for superadmin.
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  is_public boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.app_settings enable row level security;
drop policy if exists app_settings_read_public on public.app_settings;
create policy app_settings_read_public on public.app_settings for select to anon, authenticated using (is_public);
drop policy if exists app_settings_read_sa on public.app_settings;
create policy app_settings_read_sa on public.app_settings for select to authenticated using (private.is_superadmin());

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  target text,
  detail jsonb
);
alter table public.audit_log enable row level security;
drop policy if exists audit_log_read_sa on public.audit_log;
create policy audit_log_read_sa on public.audit_log for select to authenticated using (private.is_superadmin());
create index if not exists audit_log_at_idx on public.audit_log (at desc);

create or replace function public.sa_set_setting(p_key text, p_value jsonb, p_public boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_superadmin() then raise exception 'Ingen adgang'; end if;
  if p_key not in ('pricing', 'landing', 'banner', 'maintenance', 'defaults') then raise exception 'Ukendt indstilling'; end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' or pg_column_size(p_value) > 20000 then raise exception 'Ugyldig værdi'; end if;
  insert into public.app_settings(key, value, is_public, updated_at, updated_by)
    values (p_key, p_value, p_key <> 'defaults', now(), auth.uid())
    on conflict (key) do update set value = excluded.value, is_public = excluded.is_public, updated_at = now(), updated_by = auth.uid();
  insert into public.audit_log(actor, action, target, detail) values (auth.uid(), 'indstilling', p_key, p_value);
end $$;

create or replace function public.sa_audit_add(p_action text, p_target text, p_detail jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_superadmin() then raise exception 'Ingen adgang'; end if;
  insert into public.audit_log(actor, action, target, detail) values (auth.uid(), left(coalesce(p_action, ''), 80), left(p_target, 200), p_detail);
end $$;

create or replace function public.sa_audit(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_superadmin() then raise exception 'Ingen adgang'; end if;
  return coalesce((select jsonb_agg(x) from (
    select l.id, l.at, l.action, l.target, l.detail, coalesce(p.full_name, 'Ukendt') as who
    from public.audit_log l left join public.profiles p on p.id = l.actor
    order by l.at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) x), '[]'::jsonb);
end $$;

-- Overblik: kunder, brug de seneste 7 dage, anslået månedlig omsætning og mailstatus
create or replace function public.sa_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare pr jsonb; first_p numeric; extra_p numeric; r jsonb;
begin
  if not private.is_superadmin() then raise exception 'Ingen adgang'; end if;
  select value into pr from public.app_settings where key = 'pricing';
  first_p := coalesce((pr->>'first')::numeric, 249); extra_p := coalesce((pr->>'extra')::numeric, 89);
  select jsonb_build_object(
    'customers', coalesce((select jsonb_agg(c order by (c->>'mrr')::numeric desc) from (
      select jsonb_build_object('id', co.id, 'name', co.name, 'stage', coalesce(a.stage, 'aktiv'), 'users', u.n,
        'ks_7d', (select count(*) from public.photo_entries p where p.company_id = co.id and p.created_at > now() - interval '7 days'),
        'time_7d', (select count(*) from public.time_entries t where t.company_id = co.id and t.created_at > now() - interval '7 days'),
        'mrr', case when coalesce(a.stage, 'aktiv') = 'aktiv' and u.n > 0 then first_p + extra_p * (u.n - 1) else 0 end,
        'trial_ends_at', co.trial_ends_at) c
      from public.companies co
      left join public.crm_accounts a on a.company_id = co.id
      cross join lateral (select count(*) n from public.profiles pf where pf.company_id = co.id and pf.active and pf.role <> 'gaest') u
      order by co.created_at desc limit 200) y), '[]'::jsonb),
    'mail', coalesce((select jsonb_object_agg(s, n) from (select status s, count(*) n from public.mail_messages where direction = 'out' and created_at > now() - interval '30 days' group by status) m), '{}'::jsonb),
    'users_total', (select count(*) from public.profiles where active and company_id is not null),
    'ks_total', (select count(*) from public.photo_entries),
    'time_total', (select count(*) from public.time_entries)
  ) into r;
  return r;
end $$;

revoke all on function public.sa_set_setting(text, jsonb, boolean), public.sa_audit_add(text, text, jsonb), public.sa_audit(int), public.sa_overview() from public, anon;
grant execute on function public.sa_set_setting(text, jsonb, boolean), public.sa_audit_add(text, text, jsonb), public.sa_audit(int), public.sa_overview() to authenticated;
