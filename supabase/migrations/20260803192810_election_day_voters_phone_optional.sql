-- Product decision: a voter without a phone number is a legitimate record
-- and must be able to enter the system - phone becomes optional. This was
-- previously enforced as `not null` both here and in the client-side import
-- validator (electionDayImport.ts), which silently dropped every row
-- missing a phone number with zero reporting - the real cause of a large,
-- silent import gap on real ride-lists. Never invents a phone value; a
-- missing phone stays `null`, never a fabricated/placeholder string.

alter table public.election_day_voters alter column phone drop not null;

-- ============================================================================
-- ROLLBACK (manual - only safe if no row currently has phone = null):
--
--   alter table public.election_day_voters alter column phone set not null;
-- ============================================================================
