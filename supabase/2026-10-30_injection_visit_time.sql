-- Keep the appointment time with each recorded injection, so the invoice can
-- suggest the day's km in the order you saw the patients (home → visits → home).
-- Only a suggestion: nothing about billing, km or time formulas changes.
-- Local wall-clock time, as VaPiq stores appointments ("2026-10-31T13:30").
alter table public.injections add column if not exists visit_time timestamp;
