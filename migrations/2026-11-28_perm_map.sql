-- Admin kan vælge, om den enkelte bruger må se Byggepladskort (standard: ja)
alter table public.profiles add column if not exists perm_map boolean not null default true;
grant update (perm_map) on public.profiles to authenticated;
