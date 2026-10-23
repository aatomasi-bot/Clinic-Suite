-- Live sync between devices (iMac ↔ iPhone).
-- VaPiq listens for changes to these tables, but Supabase only sends changes for
-- tables added to its "supabase_realtime" publication — and none were, so a change
-- on one device only appeared on the other after a reload.
-- Run once in Supabase → SQL Editor. Safe to re-run. Row-level security still
-- applies: only signed-in users receive changes.

do $$
declare t text;
begin
  foreach t in array array['patients', 'quick_notes', 'invoices', 'injections'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- So a deleted quick note also tells the other device which file it was
alter table public.quick_notes replica identity full;

-- Check: should list the four tables
select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1;
