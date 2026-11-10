-- Dubbi's brain on the Mac listens for changes instead of downloading everything
-- every few seconds (Supabase free plan: 5 GB of downloads a month).
-- Adds Dubbi's tables to the live-sync publication, like 2026-10-23_realtime_sync.sql.
-- Run once in Supabase → SQL Editor. Safe to re-run. Row-level security still
-- applies: only signed-in users receive changes.

do $$
declare t text;
begin
  foreach t in array array['dubbi_asks', 'email_tasks', 'pending_patients', 'dubbi_cases'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Check: should list patients, quick_notes, invoices, injections and the four above
select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1;
