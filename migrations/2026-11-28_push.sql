-- Push-notifikationer: abonnementer pr. enhed (se også netlify/functions/push-notify.mjs)
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
create policy push_sub_select on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy push_sub_insert on public.push_subscriptions for insert to authenticated with check (user_id = (select auth.uid()) and (company_id is null or company_id = (select private.my_company_id())));
create policy push_sub_update on public.push_subscriptions for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy push_sub_delete on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));
grant select, insert, update, delete on public.push_subscriptions to authenticated;
-- Registrering via RPC, så samme enhed kan skifte bruger
create or replace function public.push_register(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad endpoint'; end if;
  insert into public.push_subscriptions(user_id, company_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), private.my_company_id(), p_endpoint, p_p256dh, p_auth, left(p_ua, 300))
  on conflict (endpoint) do update set user_id = auth.uid(), company_id = private.my_company_id(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, created_at = now();
end $$;
revoke all on function public.push_register(text, text, text, text) from public, anon;
grant execute on function public.push_register(text, text, text, text) to authenticated;
