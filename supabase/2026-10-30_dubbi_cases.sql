-- Dubbi's case brain: every Medicum email about a patient, read together.
--   dubbi_emails  each coordinator / reports@ / no-reply@ email your Mac has read
--                 (Inbox and Medicum folder), with the file numbers it mentions
--   dubbi_cases   one per file: Dubbi's reading of the latest situation + proposed actions
--   dubbi_memory  what you taught Dubbi (e.g. "IMG_#_#.pdf is a prescription")
-- Run once in Supabase → SQL Editor. Safe to re-run.
create table if not exists public.dubbi_emails (
  message_id   text primary key,
  created_at   timestamptz not null default now(),
  folder       text,
  email_date   timestamptz,
  from_addr    text,
  from_name    text,
  subject      text,
  body         text check (length(body) <= 8000),
  attachments  jsonb not null default '[]',      -- [{name}]
  file_numbers text[] not null default '{}'
);
create index if not exists dubbi_emails_files_idx on public.dubbi_emails using gin (file_numbers);
create index if not exists dubbi_emails_date_idx on public.dubbi_emails (email_date);

create table if not exists public.dubbi_cases (
  file_number  text primary key,
  updated_at   timestamptz not null default now(),
  basis        text,                             -- which emails it was read from
  status       text not null default 'ready' check (status in ('ready', 'quiet', 'done', 'dismissed', 'failed')),
  analysis     jsonb,                            -- {headline, summary, urgent, cards, actions}
  questions    jsonb not null default '[]',      -- [{pdf, email, pattern}] — "what is this PDF?"
  error        text,
  decided_at   timestamptz,
  decided_by   text,
  result       jsonb
);

create table if not exists public.dubbi_memory (
  key          text primary key,                 -- 'pdf:<file name>' or 'pdfp:<name pattern>'
  kind         text not null default 'pdf_type',
  value        text not null check (length(value) <= 200),
  created_at   timestamptz not null default now(),
  created_by   text
);

-- Same lock as every other table: only your VaPiq account(s)
do $$
declare t text;
begin
  foreach t in array array['dubbi_emails', 'dubbi_cases', 'dubbi_memory'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "vapiq users only" on public.%I', t);
    execute format('create policy "vapiq users only" on public.%I for all to authenticated using (public.is_vapiq_user()) with check (public.is_vapiq_user())', t);
  end loop;
end $$;

-- Check: should list the three tables
select tablename, policyname from pg_policies where schemaname = 'public' and tablename like 'dubbi_%' order by 1;
