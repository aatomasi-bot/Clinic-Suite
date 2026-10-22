-- Security fix: vapiq_pins and vapiq_reminders had row-level security OFF
-- ("UNRESTRICTED"), so anyone with the app's public key could read them.
-- VaPiq only ever reads/writes the signed-in user's own row (user_id = you),
-- so each row is now visible only to its owner. The app keeps working as before.
-- Run once in Supabase → SQL Editor.

alter table public.vapiq_pins      enable row level security;
alter table public.vapiq_reminders enable row level security;

drop policy if exists "vapiq_pins owner only"      on public.vapiq_pins;
drop policy if exists "vapiq_reminders owner only" on public.vapiq_reminders;

create policy "vapiq_pins owner only" on public.vapiq_pins
  for all using (auth.uid()::text = user_id::text) with check (auth.uid()::text = user_id::text);

create policy "vapiq_reminders owner only" on public.vapiq_reminders
  for all using (auth.uid()::text = user_id::text) with check (auth.uid()::text = user_id::text);
