-- Dubbi voice assistant: conversations and "Hey Siri, Dubbi" keys.
-- Run once in Supabase → SQL Editor. Safe to re-run.
-- Each row belongs to one user; nobody else (and no anonymous visitor) can read it.

create table if not exists public.dubbi_conversations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  source           text not null default 'app' check (source in ('app','siri')),
  messages         jsonb not null default '[]'::jsonb,   -- the conversation, append-only
  pending_actions  jsonb not null default '[]'::jsonb    -- actions Dubbi proposed, waiting for your "yes"
);
create index if not exists dubbi_conversations_user_idx on public.dubbi_conversations (user_id, updated_at desc);
alter table public.dubbi_conversations enable row level security;
drop policy if exists "dubbi_conversations owner" on public.dubbi_conversations;
create policy "dubbi_conversations owner" on public.dubbi_conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Siri keys: only a SHA-256 hash is stored; the key itself is shown once.
create table if not exists public.dubbi_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid(),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  label         text not null default 'Siri',
  token_hash    text not null unique
);
alter table public.dubbi_tokens enable row level security;
drop policy if exists "dubbi_tokens owner" on public.dubbi_tokens;
create policy "dubbi_tokens owner" on public.dubbi_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Conversations are working memory, not records: keep 7 days.
-- (The Dubbi function deletes older ones each time it runs.)
