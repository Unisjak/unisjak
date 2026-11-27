-- UniSjak: automatisk test af virksomheds-isolation og rolle-afskærmning.
-- Kør mod en frisk database (se tests/run_isolation.sh). Forventet slutlinje: "RESULTAT: BESTÅET".
\set ON_ERROR_STOP 1
\set QUIET 1
drop schema if exists iso_t cascade;
create schema iso_t;
create table iso_t.res(actor text, kind text, item text, ok boolean, detail text);
create table iso_t.ids(k text primary key, v uuid);
grant usage on schema iso_t to authenticated;
grant all on iso_t.res to authenticated;
grant select on iso_t.ids to authenticated;

-- ---------- testdata: to virksomheder, hver med admin og medarbejder ----------
do $$
declare ca uuid; cb uuid; ua1 uuid; ua2 uuid; ub1 uuid; ub2 uuid; pa uuid; pb uuid; tb uuid; xb uuid;
begin
  insert into public.companies(name) values ('Testfirma Alfa') returning id into ca;
  insert into public.companies(name) values ('Testfirma Beta') returning id into cb;
  insert into auth.users(email) values ('a-admin@test.dk') returning id into ua1;
  insert into auth.users(email) values ('a-emp@test.dk')   returning id into ua2;
  insert into auth.users(email) values ('b-admin@test.dk') returning id into ub1;
  insert into auth.users(email) values ('b-emp@test.dk')   returning id into ub2;
  insert into public.profiles(id, company_id, full_name, role) values
    (ua1, ca, 'Alfa Admin', 'admin'), (ua2, ca, 'Alfa Medarbejder', 'svend'),
    (ub1, cb, 'Beta Admin', 'admin'), (ub2, cb, 'Beta Medarbejder', 'svend');
  insert into public.projects(company_id, name) values (ca, 'Alfa projekt') returning id into pa;
  insert into public.projects(company_id, name) values (cb, 'Beta projekt') returning id into pb;
  insert into public.time_entries(company_id, project_id, user_id, work_date, hours) values (cb, pb, ub2, current_date, 7.5);
  insert into public.photo_entries(company_id, project_id, user_id, kind) values (cb, pb, ub2, 'ks') returning id into xb;
  insert into public.tasks(company_id, project_id, text, created_by) values (cb, pb, 'Beta opgave', ub1) returning id into tb;
  insert into iso_t.ids values ('ca',ca),('cb',cb),('ua1',ua1),('ua2',ua2),('ub1',ub1),('ub2',ub2),('pa',pa),('pb',pb),('xb',xb),('tb',tb);
end $$;

-- fingerprint af alle Beta-rækker (alle tabeller med company_id)
create function iso_t.fp() returns text language plpgsql as $$
declare r record; acc text := ''; cb uuid := (select v from iso_t.ids where k='cb'); s text;
begin
  for r in select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
           where c.table_schema='public' and c.column_name='company_id' order by 1 loop
    execute format('select coalesce(md5(string_agg(x::text, ''|'' order by x::text)), '''') from public.%I x where company_id = $1', r.table_name) into s using cb;
    acc := acc || r.table_name || ':' || s || ';';
  end loop;
  return md5(acc);
end $$;
create table iso_t.base(fp text);
insert into iso_t.base select iso_t.fp();

-- ---------- hjælper: kald alle SECURITY DEFINER-funktioner som en given bruger ----------
create function iso_t.run_rpc(p_actor text, p_sub uuid) returns void language plpgsql as $$
declare f record; a record; args text; cand uuid; cands uuid[]; ok boolean; msg text; n int;
        sa boolean := (p_actor like '%superadmin%');
begin
  select array_agg(v) into cands from iso_t.ids where k in ('pb','xb','tb','cb','ub2');
  for f in
    select p.oid, p.proname, p.pronargs, pg_get_function_identity_arguments(p.oid) as ia
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
    order by p.proname
  loop
    foreach cand in array cands loop
      args := '';
      for a in select t.typname, o.ord from unnest((select proargtypes from pg_proc where oid=f.oid)::oid[]) with ordinality o(oid,ord) join pg_type t on t.oid=o.oid order by o.ord loop
        args := args || case when args='' then '' else ',' end || case a.typname
          when 'uuid' then format('%L::uuid', cand)
          when '_uuid' then format('array[%L]::uuid[]', cand)
          when 'date' then 'current_date'
          when 'text' then '''x'''
          when '_text' then 'array[''x'']::text[]'
          when 'bool' then 'true'
          when 'int4' then '1'
          when 'numeric' then '1'
          when 'jsonb' then '''{}''::jsonb'
          when 'timestamptz' then 'now()'
          else 'null' end;
      end loop;
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', p_sub::text, true);
        execute format('select public.%I(%s)', f.proname, args);
        ok := true; msg := 'kørte uden fejl';
      exception when others then ok := false; msg := sqlerrm;
      end;
      execute 'reset role';
      insert into iso_t.res values (p_actor, 'rpc', f.proname || '(' || cand || ')', ok, msg);
    end loop;
  end loop;
end $$;

-- ---------- hjælper: tabeller (RLS) ----------
create function iso_t.run_tables(p_actor text, p_sub uuid) returns void language plpgsql as $$
declare r record; n bigint; cb uuid := (select v from iso_t.ids where k='cb');
begin
  for r in select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
           where c.table_schema='public' and c.column_name='company_id' order by 1 loop
    -- læs
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', p_sub::text, true);
      execute format('select count(*) from public.%I where company_id = $1', r.table_name) into n using cb;
      execute 'reset role';
      insert into iso_t.res values (p_actor, 'laes', r.table_name, n = 0, 'så ' || n || ' Beta-rækker');
    exception when others then execute 'reset role'; insert into iso_t.res values (p_actor, 'laes', r.table_name, true, 'afvist: ' || sqlerrm); end;
    -- slet
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', p_sub::text, true);
      execute format('delete from public.%I where company_id = $1', r.table_name) using cb;
      get diagnostics n = row_count;
      execute 'reset role';
      insert into iso_t.res values (p_actor, 'slet', r.table_name, n = 0, 'slettede ' || n || ' Beta-rækker');
    exception when others then execute 'reset role'; insert into iso_t.res values (p_actor, 'slet', r.table_name, true, 'afvist: ' || sqlerrm); end;
  end loop;
end $$;

-- ---------- kør ----------
select iso_t.run_rpc('a-medarbejder', (select v from iso_t.ids where k='ua2'));
select iso_t.run_rpc('a-admin',       (select v from iso_t.ids where k='ua1'));
select iso_t.run_tables('a-medarbejder', (select v from iso_t.ids where k='ua2'));
select iso_t.run_tables('a-admin',       (select v from iso_t.ids where k='ua1'));

-- ---------- tjek 1: ingen sa_* kan køres af ikke-superadmin ----------
insert into iso_t.res
select 'regel', 'sa-afvist', item, not ok, 'sa_* skal afvises for almindelig bruger: ' || detail
from iso_t.res where kind='rpc' and item like 'sa\_%' escape '\';

-- ---------- tjek 2: Beta-data uændret efter alle kald ----------
insert into iso_t.res select 'regel', 'beta-uaendret', 'fingerprint', (select fp from iso_t.base) = iso_t.fp(), 'Beta-data før og efter';

-- ---------- tjek 3: anon kan ikke køre nogen funktion ----------
insert into iso_t.res
select 'regel', 'anon', p.proname, not has_function_privilege('anon', p.oid, 'execute'), 'anon må ikke kunne udføre'
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef;

-- ---------- tjek 4: tabeller i public uden RLS ----------
insert into iso_t.res
select 'regel', 'rls-slaaet-til', c.relname, c.relrowsecurity, 'RLS skal være slået til'
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r';

-- ---------- rapport ----------
\echo
\echo '=== Fejl (tom liste = ingen) ==='
select actor, kind, item, detail from iso_t.res where
  (kind in ('laes','slet','sa-afvist','beta-uaendret','anon','rls-slaaet-til') and not ok) order by 1,2,3;
\echo '=== Opsummering ==='
select kind, count(*) as antal, count(*) filter (where kind in ('laes','slet','sa-afvist','beta-uaendret','anon','rls-slaaet-til') and not ok) as fejl
from iso_t.res group by kind order by kind;
select case when exists (select 1 from iso_t.res where kind in ('laes','slet','sa-afvist','beta-uaendret','anon','rls-slaaet-til') and not ok)
  then 'RESULTAT: FEJLET' else 'RESULTAT: BESTÅET' end as resultat;
