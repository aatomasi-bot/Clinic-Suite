-- Dubbi's brain: the questions you ask Dubbi, answered by Claude on your Mac.
-- The phone writes the question; your Mac (assistant/brain.js) writes the answer.
-- Questions are removed after 7 days.
-- Run once in Supabase → SQL Editor. Safe to re-run.
create table if not exists public.dubbi_asks (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_email  text,
  conv        text,                        -- one Dubbi conversation (so "and the next one?" works)
  question    text not null check (length(question) <= 1000),
  lang        text,
  status      text not null default 'asked' check (status in ('asked', 'thinking', 'answered', 'failed', 'cancelled')),
  answer      jsonb,                       -- {say, show:[file], action:{type,file}} or {error}
  answered_at timestamptz
);
create index if not exists dubbi_asks_status_idx on public.dubbi_asks (status, created_at);

-- Same lock as every other table: only your VaPiq account(s)
alter table public.dubbi_asks enable row level security;
drop policy if exists "vapiq users only" on public.dubbi_asks;
create policy "vapiq users only" on public.dubbi_asks for all to authenticated
  using (public.is_vapiq_user()) with check (public.is_vapiq_user());

-- Check: should say "vapiq users only"
select policyname from pg_policies where schemaname = 'public' and tablename = 'dubbi_asks';
