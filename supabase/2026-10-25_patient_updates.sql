-- Patient updates from coordinators: on hold / back / permanent (Oct 25, 2026).
-- The assistant prepares a card for each; you confirm in Dubbi.
-- Run once in Supabase → SQL Editor. Safe to re-run.
alter table public.email_tasks drop constraint if exists email_tasks_kind_check;
alter table public.email_tasks add constraint email_tasks_kind_check
  check (kind in ('new_patient', 'prescription', 'close_file', 'on_hold', 'back', 'permanent'));
