-- Emails you write to Medicum from VaPiq (one or several patients, name + file
-- number). VaPiq saves them already approved; your Mac sends them from
-- abdulmedicum@yahoo.com within ~2 minutes, like coordinator replies.
-- Run once in Supabase → SQL Editor. Safe to re-run.
alter table public.email_tasks drop constraint if exists email_tasks_kind_check;
alter table public.email_tasks add constraint email_tasks_kind_check
  check (kind in ('new_patient', 'prescription', 'close_file', 'on_hold', 'back', 'permanent', 'medicum_note'));
