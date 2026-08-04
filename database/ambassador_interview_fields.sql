-- Additional interview-detail fields needed for the interview-scheduled
-- ambassador email (timezone label, meeting location/link, and applicant-
-- facing prep notes, distinct from the internal admin_notes field).
-- Apply in Supabase SQL editor or your migration pipeline (see ambassador_program.sql).

alter table public.ambassador_applications
  add column if not exists interview_timezone text,
  add column if not exists interview_location text,
  add column if not exists interview_prep_notes text;
