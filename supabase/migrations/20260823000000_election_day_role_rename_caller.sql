-- Election Day role label rename: the built-in "operations"/"משתמש" role
-- (id "seed-user" in src/permissions/builtInRoleSeed.ts; a real DB-generated
-- uuid in any live project) becomes "טלפן/ית" - display label only.
--
-- ============================================================================
-- WHY A DATA UPDATE, NOT A SEED-TEXT EDIT ALONE
-- ============================================================================
-- election_day_roles.name is persisted data, seeded once by
-- 20260805181806_election_day_dynamic_roles_phase0.sql's INSERT. That
-- migration is already applied (locally and, eventually, in Production) and
-- stays fully immutable here - its seed text still reads 'משתמש', byte-for-
-- byte as originally shipped (deliberately NOT edited in place the way this
-- same file's "voting" row historically was, from 'הצבעה' to 'נציג קלפי' -
-- that precedent only ever changes what a NEVER-YET-INITIALIZED project
-- seeds on first run, not an already-migrated one). A plain UPDATE, run as
-- its own standalone forward migration, is the correct way to rename an
-- already-persisted row - this file is that UPDATE. A fresh migration
-- replay therefore seeds 'משתמש' via Phase 0 and then renames it to
-- 'טלפן/ית' via this file, arriving at the same final state as an
-- already-migrated project that only ever runs this file going forward.
-- src/permissions/builtInRoleSeed.ts's `name` field reflects that FINAL
-- state ('טלפן/ית'), not Phase 0's own literal seed text - see that file's
-- own doc comment for the same reasoning already established for permissions
-- added post-Phase-0. scripts/smoke-role-seed-parity.ts parses both this
-- file and Phase 0's seed to assert the full chain end-to-end.
--
-- ============================================================================
-- SCOPE - rename only, verified against this project's local Docker data
-- before writing this migration
-- ============================================================================
-- Confirmed via direct read-only query against the live local
-- election_day_roles table: exactly one row has name = 'משתמש'
-- (scope_type = 'assigned_to_me', 13 permissions, matching
-- builtInRoleSeed.ts's "seed-user" entry exactly) - this is the caller-only
-- operational role (manages reminders/rides/phone/notes, no voter.markVoted,
-- no admin permissions), never the manager ('מנהל') or poll-representative
-- ('נציג קלפי') rows, which this statement's WHERE clause cannot match.
--
-- id, permissions, scope_type, scope_value, created_at, and every
-- election_day_permission_users.role_id pointing at this row are completely
-- untouched - a real DB-generated uuid identity and every existing user
-- assignment survive this rename unchanged, since only the `name` column of
-- the matched row is written. No permission/scope/authorization behavior
-- changes: every permission check in the app reads `permissions`/`scope_type`
-- off the resolved role row, never its `name` text (src/permissions/
-- computePermissions.ts, hasPermission.ts - unaffected by this migration).
--
-- Idempotent by construction: election_day_roles.name is UNIQUE, so a second
-- run of this exact statement matches zero rows (the row no longer has the
-- old name) and is a safe no-op.
begin;

update public.election_day_roles
set name = 'טלפן/ית'
where name = 'משתמש';

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   update public.election_day_roles set name = 'משתמש' where name = 'טלפן/ית';
--   commit;
-- ============================================================================
