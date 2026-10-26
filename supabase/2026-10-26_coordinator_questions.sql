-- Coordinator questions ("has the patient been contacted yet?"): your Mac makes a
-- reply card with what VaPiq knows about the file; Dubbi shows it, you edit and tap Send.
-- Run once in Supabase → SQL Editor. Safe to re-run.
alter table public.email_tasks drop constraint if exists email_tasks_kind_check;
alter table public.email_tasks add constraint email_tasks_kind_check
  check (kind in ('new_patient', 'prescription', 'close_file', 'on_hold', 'back', 'permanent', 'medicum_note', 'question'));
