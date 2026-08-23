import type { RoleRecord } from "./types";

/**
 * The 3 built-in roles, mirrored verbatim from the Phase 0 migration's seed
 * (`supabase/migrations/20260805181806_election_day_dynamic_roles_phase0.sql`)
 * - same `name`/`permissions`/`scopeType` values, byte-for-byte. `id` is a
 * placeholder (the real id is a DB-generated uuid) - never compared or
 * relied upon by the running app (a real session always resolves by the
 * DB's actual `role_id`); tests key off these placeholder ids instead.
 *
 * Two consumers:
 * - `MockApi.listElectionDayRoles()` - interface compliance only. Never
 *   actually reached in the running app (the `api` singleton always
 *   delegates every Election Day method to `SupabaseElectionDayApi` - see
 *   `services/api/index.ts`), kept in sync here only so `MockApi` still
 *   type-checks as `ApiClient` and behaves sanely if ever exercised directly
 *   (e.g. a future unit test).
 * - `scripts/fixtures/electionDayRoles.ts` re-exports this exact array for
 *   the Node smoke tests, plus a dedicated test
 *   (`scripts/smoke-role-seed-parity.ts`) that parses the migration SQL
 *   itself and asserts these arrays never drift out of sync with it.
 *
 * Because this is frozen to Phase 0's literal migration text (parity-checked
 * against it, not against the live catalog), it does NOT include permissions
 * added to `election_day_roles` after Phase 0 via a later migration's raw
 * `UPDATE ... array_append(...)` - `electionDay.manageNonVotingReasons` and
 * `voter.viewReminderHistory` are two real precedents already missing here
 * for exactly that reason (see CLAUDE.md's "Known Security Limitations").
 * `electionDay.manageCoordinatorAllocation` (Coordinator Allocation
 * Management Phase 4) is a third: adding it to `ALL_PERMISSIONS` makes it
 * exist in the code catalog, but does NOT, by itself, grant it to any
 * persisted Production role, including manager - that requires a dedicated
 * backfill migration mirroring the two precedents above, deliberately not
 * created in Phase 4 (see that phase's own report).
 *
 * One exception to "frozen to Phase 0's literal text", by the same
 * established pattern: `seed-user`'s `name` here is `"טלפן/ית"`, not Phase
 * 0's original seeded `"משתמש"` - the display-name rename (2026-08-23) is
 * deliberately NOT done by editing Phase 0's already-applied migration text
 * (an immutable historical record), but by a later, standalone forward
 * migration (`20260823000000_election_day_role_rename_caller.sql`) that
 * `UPDATE`s the persisted row's `name` only - `permissions`/`scopeType` are
 * completely unaffected and still match Phase 0's original seed byte-for-
 * byte. This field therefore reflects the FINAL name after that forward
 * migration replays, not Phase 0's own literal seed value, exactly mirroring
 * how the permissions exceptions above already represent post-Phase-0 state
 * for the same reason. `scripts/smoke-role-seed-parity.ts` parses both
 * migration files and asserts this chain end-to-end.
 */
export const BUILT_IN_ROLE_SEED: readonly RoleRecord[] = [
  {
    id: "seed-manager",
    name: "מנהל",
    description: "גישה מלאה לכל הפעולות והנתונים, כולל ניהול משתמשים ותפקידים.",
    permissions: [
      "voter.markVoted",
      "voter.manageReminder",
      "voter.manageRide",
      "voter.editPhone",
      "voter.editNotes",
      "electionDay.import",
      "electionDay.clearData",
      "electionDay.export",
      "electionDay.manageSettings",
      "electionDay.manageUsers",
      "electionDay.manageRideCoordinators",
      "app.accessFullNavigation",
      "voter.viewName",
      "voter.viewAddress",
      "voter.viewPhone",
      "voter.viewMasad",
      "voter.viewCoordinator",
      "voter.viewNotes",
      "voter.viewReminderStatus",
      "voter.viewRideStatus",
      "voter.viewVotedStatus",
      "electionDay.manageRolesAndPermissions",
    ],
    scopeType: "all",
    scopeValue: null,
  },
  {
    id: "seed-user",
    name: "טלפן/ית",
    description:
      "ניהול תפעולי של אנשי קשר - תזכורות, הסעות, עדכון פרטים - ללא סימון הצבעה וללא פעולות ניהול.",
    permissions: [
      "voter.manageReminder",
      "voter.manageRide",
      "voter.editPhone",
      "voter.editNotes",
      "voter.viewName",
      "voter.viewAddress",
      "voter.viewPhone",
      "voter.viewMasad",
      "voter.viewCoordinator",
      "voter.viewNotes",
      "voter.viewReminderStatus",
      "voter.viewRideStatus",
      "voter.viewVotedStatus",
    ],
    scopeType: "assigned_to_me",
    scopeValue: null,
  },
  {
    id: "seed-voting",
    name: "נציג קלפי",
    description: "סימון וביטול סימון הצבעה בלבד, עם פרטי זיהוי בסיסיים.",
    permissions: [
      "voter.markVoted",
      "voter.viewName",
      "voter.viewAddress",
      "voter.viewPhone",
      "voter.viewVotedStatus",
    ],
    scopeType: "assigned_to_me",
    scopeValue: null,
  },
];
