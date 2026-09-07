-- Platform Owner / Multi-Entity Owner program - Stage 1: enforce the closed
-- product rule "ONE system/workspace = ONE Owner" in the database itself.
--
-- ============================================================================
-- SCOPE - one table, one new constraint, one superseded index
-- ============================================================================
-- Touches public.election_owners only. No RPC, no grant, no RLS policy, no
-- other table, no application/API code. Adds nothing to any other schema.
--
-- ============================================================================
-- WHY THIS SUPERSEDES PHASE 0
-- ============================================================================
-- 20260823010000_multi_tenant_phase0_platform_foundation.sql modelled
-- election_owners for MULTIPLE equal Owners per workspace, with a derived
-- "representative Owner" (oldest by created_at) and a future "last remaining
-- Owner can never be deleted" business rule. That model has since been
-- explicitly closed and replaced by a later product decision: exactly ONE
-- Owner per system/workspace, with Owner REPLACEMENT (a Platform Owner
-- operation) taking the place of the multi-Owner roster. The derived
-- representative-Owner concept is retired along with it - with N=1 there is
-- nothing to derive.
--
-- Phase 0 left this rule unenforced (only a non-unique index on
-- workspace_id), so nothing in the database prevented a second Owner row.
-- This migration makes the database the authority for the rule rather than
-- relying on application code, matching how the sibling rule on this same
-- table (one Auth account per Owner) has always been enforced - by the
-- election_owners_auth_user_id_key UNIQUE constraint, not by convention.
--
-- ============================================================================
-- WHY A CONSTRAINT, NOT A BARE UNIQUE INDEX
-- ============================================================================
-- Expressed as a UNIQUE CONSTRAINT (not `create unique index`) so it is
-- visible in pg_constraint / \d alongside election_owners_auth_user_id_key -
-- the two uniqueness invariants on this table are then stated the same way,
-- and a violation raises an error naming the constraint, which server code
-- can map to a specific business error rather than parsing an index name.
-- `create unique index` is used elsewhere in this project only where a
-- PARTIAL predicate is required (e.g. the coordinator indexes in
-- 20260830010000); no predicate is needed here - the rule is total.
--
-- ============================================================================
-- WHY THE OLD INDEX IS DROPPED
-- ============================================================================
-- The new constraint creates its own backing UNIQUE btree index on exactly
-- (workspace_id) - the identical column list, index type and operator class
-- as the plain index Phase 0 created (election_owners_workspace_id_idx, line
-- 191). That plain index therefore becomes fully redundant: every lookup it
-- served is served by the constraint's index. Keeping both would leave a
-- duplicate index on a single column. Verified before writing this file that
-- election_owners_workspace_id_idx is referenced by name nowhere in this
-- repository outside its own CREATE statement, and that no foreign key
-- depends on it (election_owners.workspace_id is the REFERENCING side; an
-- index there is a performance aid, never a requirement). This mirrors the
-- create-replacement-then-drop-superseded pattern already used in
-- 20260830010000 for the coordinator uniqueness indexes.
--
-- ============================================================================
-- COMPATIBILITY (verified before authoring, not assumed)
-- ============================================================================
-- Production was checked read-only immediately before this migration was
-- written (authoritative, via a data-only dump scoped to this one table):
-- election_owners holds exactly 1 row across exactly 1 distinct workspace_id,
-- and the "group by workspace_id having count(*) > 1" gate returns ZERO rows.
-- The constraint therefore builds cleanly against Production as it stands.
-- That check MUST be re-run immediately before this migration is applied -
-- it is a point-in-time result, and ADD CONSTRAINT fails loudly (correctly)
-- if a second Owner has appeared in the meantime.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol pipelining, not an implicit
-- transaction.
begin;

alter table public.election_owners
  add constraint election_owners_workspace_id_key unique (workspace_id);

drop index if exists public.election_owners_workspace_id_idx;

comment on constraint election_owners_workspace_id_key on public.election_owners is
  'ONE system/workspace = ONE Owner - the authoritative database enforcement of that closed product rule. Supersedes the Phase 0 multi-Owner model (20260823010000). Replacing a workspace''s Owner is an UPDATE of this one row (a Platform Owner operation), never a second INSERT. Its backing UNIQUE btree index on (workspace_id) also replaces the now-redundant plain index election_owners_workspace_id_idx, dropped by this same migration.';

comment on table public.election_owners is
  'Election Owners - a separate system principal, not a dynamic role. EXACTLY ONE Owner per workspace_id, enforced by election_owners_workspace_id_key (see that constraint''s own comment); this supersedes the original Phase 0 multi-Owner model and its derived "representative Owner" concept, both retired by a later product decision. Owner replacement is a Platform Owner operation performed as an UPDATE of the existing row, never delete+insert. auth_user_id is unique - the same real person/account is never shared across two Election Days. RLS-enabled, zero policies.';

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down". Restores both the Phase 0 index and the Phase 0 table comment
-- verbatim):
--
--   begin;
--   alter table public.election_owners
--     drop constraint if exists election_owners_workspace_id_key;
--   create index if not exists election_owners_workspace_id_idx
--     on public.election_owners (workspace_id);
--   comment on table public.election_owners is
--     'Election Owners - a separate system principal, not a dynamic role, exactly per the approved architecture. Multiple equal Owners may exist per workspace_id; "representative Owner" is a pure derived query (oldest remaining, ORDER BY created_at), no extra column needed. auth_user_id is unique - the same real person/account is never shared across two Election Days, matching the approved architecture directly. "Owner cannot delete self" / "last remaining Owner can never be deleted" are business rules enforced by a future RPC, not a schema constraint. RLS-enabled, zero policies.';
--   commit;
-- ============================================================================
