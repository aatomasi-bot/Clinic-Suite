-- VaPiq intake assistant, part 3: pair the coordinator email with the
-- reports@medicum.ca email for the same new patient, track documents, and
-- support the safety net (overdue alerts, morning summary, journey tracker).
-- Run once in Supabase → SQL Editor, after the earlier files. Safe to re-run.

alter table public.email_tasks add column if not exists group_key       text;          -- file number the emails share
alter table public.email_tasks add column if not exists cc_addresses    text[] not null default '{}';
alter table public.email_tasks add column if not exists documents       jsonb;         -- {assignment:bool, enrollment:bool, files:[{name,type,from}]}
alter table public.email_tasks add column if not exists related_emails  jsonb not null default '[]'::jsonb;  -- [{from,subject,date,message_id,folder}]
alter table public.email_tasks add column if not exists alerted_at      timestamptz;   -- last overdue alert sent
alter table public.email_tasks add column if not exists asked_docs_at   timestamptz;   -- when you asked for missing documents
alter table public.pending_patients add column if not exists alerted_at timestamptz;

-- "waiting_docs": you asked the coordinator for missing documents; the card
-- comes back to "todo" by itself when they arrive.
alter table public.email_tasks drop constraint if exists email_tasks_status_check;
alter table public.email_tasks add constraint email_tasks_status_check
  check (status in ('todo','waiting_docs','reply_ready','send_approved','sending','sent','failed','done','dismissed'));

create index if not exists email_tasks_group_idx on public.email_tasks (kind, group_key);

-- One row per day: what the 7:00 AM summary said (counts only, no patient details).
create table if not exists public.assistant_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null,            -- 'morning_summary' | 'overdue_alert' | 'monthly_check'
  summary     jsonb not null
);
alter table public.assistant_log enable row level security;
drop policy if exists "assistant_log authenticated all" on public.assistant_log;
create policy "assistant_log authenticated all" on public.assistant_log
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
