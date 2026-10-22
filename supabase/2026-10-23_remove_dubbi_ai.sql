-- Dubbi no longer uses a cloud AI: remove its two (empty) tables.
-- Run once in Supabase → SQL Editor. Safe to re-run.
drop table if exists public.dubbi_conversations;
drop table if exists public.dubbi_tokens;
