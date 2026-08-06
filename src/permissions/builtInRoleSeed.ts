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
    name: "משתמש",
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
