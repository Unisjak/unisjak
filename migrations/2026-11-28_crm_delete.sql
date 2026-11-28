-- Superadmin kan rydde op: slette mailtråde og leads
grant update, delete on public.mail_threads to authenticated;
grant delete on public.mail_messages to authenticated;
alter table public.mail_threads drop constraint mail_threads_account_id_fkey, add constraint mail_threads_account_id_fkey foreign key (account_id) references public.crm_accounts(id) on delete set null;
alter table public.agent_queue drop constraint agent_queue_thread_id_fkey, add constraint agent_queue_thread_id_fkey foreign key (thread_id) references public.mail_threads(id) on delete set null;
alter table public.mail_campaign_recipients drop constraint mail_campaign_recipients_account_id_fkey, add constraint mail_campaign_recipients_account_id_fkey foreign key (account_id) references public.crm_accounts(id) on delete set null;
