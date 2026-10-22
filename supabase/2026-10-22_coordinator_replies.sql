-- VaPiq intake assistant, part 2: coordinator emails that need an action and
-- a reply (new patient, prescription for an existing patient, close file).
-- Run once in Supabase → SQL Editor, after 2026-10-20_intake_assistant.sql.
--
-- Life of a task:
--   todo           you still have to act in VaPiq (add / apply / close)
--   reply_ready    action done; the drafted reply waits for you
--   send_approved  you tapped Send — the Mac sends it within ~2 minutes
--   sending → sent (then the email is moved Inbox → Medicum)   | failed
--   done           handled without a reply ("Don't reply")
--   dismissed      not relevant

create table if not exists public.email_tasks (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  kind              text not null check (kind in ('new_patient','prescription','close_file')),
  status            text not null default 'todo'
                    check (status in ('todo','reply_ready','send_approved','sending','sent','failed','done','dismissed')),
  is_test           boolean not null default false,   -- fake data: the Mac never really sends these
  source_key        text not null unique,             -- sha256(message-id + kind)
  pending_id        uuid references public.pending_patients(id) on delete set null,  -- new_patient card
  email_message_id  text,
  email_folder      text,
  email_from        text,
  email_subject     text,
  email_date        timestamptz,
  to_address        text not null,                    -- always the coordinator who wrote
  to_name           text,
  lang              text not null default 'en' check (lang in ('en','fr')),
  file_number       text,
  subject_ref       text,                             -- e.g. "JGC 35290"
  existing_patient  jsonb,                            -- {id, file_number, patient_name, status, dose_prescribed, doses_remaining}
  details           jsonb,                            -- e.g. {pdf_dose: "45"}
  warnings          text[] not null default '{}',
  reply_body        text,                             -- draft; what you approve is what is sent
  decided_by        text,
  decided_at        timestamptz,
  sent_at           timestamptz,
  moved_to_folder   text,
  error             text
);

create index if not exists email_tasks_status_idx on public.email_tasks (status, created_at desc);

alter table public.email_tasks enable row level security;

drop policy if exists "email_tasks authenticated select" on public.email_tasks;
drop policy if exists "email_tasks authenticated insert" on public.email_tasks;
drop policy if exists "email_tasks authenticated update" on public.email_tasks;
drop policy if exists "email_tasks authenticated delete" on public.email_tasks;
create policy "email_tasks authenticated select" on public.email_tasks for select using (auth.role() = 'authenticated');
create policy "email_tasks authenticated insert" on public.email_tasks for insert with check (auth.role() = 'authenticated');
create policy "email_tasks authenticated update" on public.email_tasks for update using (auth.role() = 'authenticated');
create policy "email_tasks authenticated delete" on public.email_tasks for delete using (auth.role() = 'authenticated');
