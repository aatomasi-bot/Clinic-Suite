-- VaPiq intake assistant: staging table for assignments found in email,
-- plus iPhone push subscriptions. Run once in Supabase → SQL Editor.
-- Same access model as the rest of VaPiq: signed-in users only (RLS).

create table if not exists public.pending_patients (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  -- pending  = new file number, waiting for your approval
  -- exists   = file number already in patients; informational only, nothing written
  -- approved / rejected / dismissed = decided in the Approvals page
  status              text not null default 'pending'
                      check (status in ('pending','exists','approved','rejected','dismissed')),
  is_test             boolean not null default false,  -- fake data: approving never writes to patients
  source_key          text not null unique,            -- sha256(message-id + attachment); stops double-processing
  email_from          text,
  email_subject       text,
  email_date          timestamptz,
  attachment_name     text,
  subject_file_number text,
  record              jsonb not null,                  -- proposed patients row (DB column names)
  missing_fields      text[] not null default '{}',
  warnings            text[] not null default '{}',
  existing_patient    jsonb,                           -- for status=exists: {file_number, patient_name, status}
  decided_at          timestamptz,
  decided_by          text,
  patient_id          text                             -- patients.id once approved
);

create index if not exists pending_patients_status_idx on public.pending_patients (status, created_at desc);

alter table public.pending_patients enable row level security;

drop policy if exists "pending_patients authenticated select" on public.pending_patients;
drop policy if exists "pending_patients authenticated insert" on public.pending_patients;
drop policy if exists "pending_patients authenticated update" on public.pending_patients;
drop policy if exists "pending_patients authenticated delete" on public.pending_patients;
create policy "pending_patients authenticated select" on public.pending_patients for select using (auth.role() = 'authenticated');
create policy "pending_patients authenticated insert" on public.pending_patients for insert with check (auth.role() = 'authenticated');
create policy "pending_patients authenticated update" on public.pending_patients for update using (auth.role() = 'authenticated');
create policy "pending_patients authenticated delete" on public.pending_patients for delete using (auth.role() = 'authenticated');


create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions authenticated all" on public.push_subscriptions;
create policy "push_subscriptions authenticated all" on public.push_subscriptions
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
