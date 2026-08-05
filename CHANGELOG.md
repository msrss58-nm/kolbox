# Changelog

Notable changes to KolBox, in reverse chronological order.

## 2026-08-05 - Election Day: fixed first-user bootstrap regression from the permission engine

Fixed a regression introduced by the Stage 2 permission-engine rollout (commit `5451be2`): when the "ניהול הרשאות משתמשים" roster is empty, `/election-day` is still meant to stay open with no login required so whoever sets it up can reach the button that creates the first account (unchanged, original design) - but that button had started reading `usePermissions().can("electionDay.manageUsers")` alone, and a missing session resolves to zero permissions per Stage 1's no-manager-fallback rule, so the button was silently hidden with no other UI path to reach it. Dormant on the live campaign (already has its 4 real accounts) but a full lockout for any future fresh roster.

- `ElectionDayGuard.tsx` is now the single source of truth for the bootstrap window: `isBootstrap = permissionUsers.length === 0 && user === null`, computed only once the roster fetch has actually resolved (never confused with "still loading").
- `isBootstrap` is passed down through `<Outlet context={{ isBootstrap }} />` and read in `ElectionDayPage.tsx` via `useOutletContext`.
- The exception is narrow and additive - `showManageUsers = can("electionDay.manageUsers") || isBootstrap` - and touches only that one button. Import, clear-data, ride-coordinator management, export, and the countdown-settings gear all stay plain `can(...)` checks, unaffected.
- **No fallback to `manager`.** `resolveEffectiveRole`, `computePermissions`, `hasPermission`, and `PERMISSIONS_BY_ROLE` were not touched - a missing session still resolves to `role: null` and denies all 21 permissions. This is a local `ElectionDayPage` UI exception, not a role or engine change.
- `useElectionDay.ts` was not touched. No DB, migration, RLS, or RPC change.
- This is **not yet** the Stage 3 business-logic guard - `addPermissionUser` itself has no bootstrap-aware exception yet; that remains a Stage 3 concern, deliberately not implemented here.

Verified: `smoke-bootstrap.ts` 37/37 (pure logic - both formulas pinned against the real engine, plus proof no other permission is affected and the engine's own no-session behavior is unchanged), `drive-bootstrap.mjs` 12/12 (Playwright, roster mocked at the network layer via `page.route` - the real `PermissionUser` roster is never read or written), `smoke-permissions.ts` 127/127 and `smoke-permission-ui.ts` 10/10 (regression, unchanged), `tsc -b`/`eslint`/`build` clean.

Shipped as commit `51377a5` ("fix: restore first-user bootstrap access"), pushed, deployed to `https://kolbox-gamma.vercel.app` (`dpl_B1C96wYAwZbs5Dfuh4FWKdVjbry7`, confirmed built from commit `51377a5` exactly). **Focused Production Smoke Test: PASS, 0 console/page errors** - the ordinary path (non-empty roster + no session → redirected to login; manager sees the button via its real permission; operations doesn't) verified via live login against production with two temporary test accounts, deleted immediately after; the roster-empty scenario verified against commit `51377a5`'s actual deployed bundle via `drive-bootstrap.mjs`'s network-mocked roster, so the real roster was never touched. A before/after SHA-256 snapshot of all 1,928 real voters was byte-for-byte identical, and the real 4-account roster was confirmed unchanged.

**Stage 3 (business-logic enforcement on the `useElectionDay` mutation handlers) has still not started.**

## 2026-08-05 - Election Day: permission engine connected to the UI (Stage 2)

Connected the centralized Election Day permission engine (`src/permissions/` - built in Stage 1, commit `390284f`, previously unconnected dead code) to every Election Day UI surface:

- **manager** - unrestricted, sees and can do everything (unchanged from before this work).
- **operations** (today's `role: "user"` in the DB, mapped via `resolveEffectiveRole()`) - no mark-voted/unmark-voted; full access to reminders, ride coordination, phone add/edit, notes, and every operational field (מס"ד/אחראי/הערות/סטטוס תזכורת/סטטוס הסעה); no admin actions (import/clear/manage-ride-coordinators/manage-users/export/settings); restricted to `/election-day` in the main navigation.
- **voting** (not yet a real DB role - see "Known limitations" below) - sees only name, address, phone, and voted status; the only actions available are marking/unmarking a voter as voted, and calling; does not see מס"ד, אחראי (coordinator), הערות (notes), reminders, ride coordination, or phone editing, and no admin action. Search, "הצג רק לא הצביעו", the city filter, and the aggregate turnout dashboard (progress bar/stat cards/pie chart) remain visible - none of them expose a field this role shouldn't see.
- List/row columns are now a declarative projection (`electionDayRowColumns.ts`'s `ELECTION_DAY_ROW_COLUMNS`, filtered by permission) shared by the header and every row, instead of two independently-hardcoded `grid-template-columns` strings - eliminates a latent drift risk between them.
- `AppLayout`'s main-navigation restriction moved from a direct `electionDaySessionUser?.role === "user"` comparison to the permission engine (`app.accessFullNavigation`) - with an explicit session-presence guard, since a missing Election Day session now resolves to zero permissions (Stage 1's fix) and would otherwise have wrongly locked out any ordinary main-app user who has never opened `/election-day`.

Verified: `smoke-permissions.ts` 127/127, a new `smoke-permission-ui.ts` 10/10 (column projection + the `AppLayout` expression, pinned against regression), a new Playwright script 15/15 against a live dev server (temporary `manager`/`user` `PermissionUser` test accounts, deleted afterward), and - since `voting` cannot log in for real until a future DB migration - a dedicated dev-only voting-role UI harness (`vite.harness.config.ts` + `scripts/harness/`) that renders the real, unmodified `ElectionDayPage` with only `usePermissions` swapped for a mock pinned to `voting` via the same real `hasPermission()`/`PERMISSIONS_BY_ROLE` engine, 30/30 against real production data.

Shipped as commit `5451be2` (permission engine itself: `390284f`), pushed, deployed to `https://kolbox-gamma.vercel.app`. **Production Smoke Test: 70/70 PASS** - manager and operations verified via live login against production; voting verified via the harness against production data and commit `5451be2`'s exact source. 0 console errors, 0 page errors. A before/after snapshot confirmed all 1,928 voter records and the real 4-account `PermissionUser` roster were completely unchanged; every temporary test account created for verification was deleted.

**Known limitations (by design, not oversights - see task-plan.md for the full staged plan):**

1. `voting` is not yet a real, loggable-in DB role - `election_day_permission_users.role` still only accepts `manager`/`user`; `user` is treated as `operations` via a single legacy-mapping function until a separate, explicitly-approved migration (Stage 4) backfills real `operations`/`voting` rows.
2. This stage is UI enforcement only - a hidden button is not a security boundary. Business-logic enforcement (blocking the actual mutation call, not just hiding the trigger) is Stage 3, not yet built.
3. No server-side enforcement exists yet - every Election Day mutation still goes through PostgREST directly under permissive RLS (`USING (true)`), exactly as already documented in CLAUDE.md's "Known Security Limitations". A determined caller holding the anon key can still bypass any UI-level restriction.
4. `vite.harness.config.ts` only supports the voting-role harness in dev mode - `vite build --config vite.harness.config.ts` isn't wired to the harness's own entry (`scripts/harness/index.html`; it lacks a `build.rollupOptions.input`) and falls back to the main app's entry instead. A real gap, left unfixed under this milestone's no-code-change scope.
5. Operations' full visibility of operational fields (reminders/rides/phone/notes/מס"ד/אחראי) was verified live in production for manager, and confirmed for operations via permission-equivalence (operations and manager hit the exact same `PermissionGuard` checks with the same result) plus pure-logic column-projection tests - not a second live login under a real coordinator-scoped `operations` account, since the only real coordinator names in the live dataset already belong to real campaign accounts this verification correctly avoided touching.

## 2026-08-04 - Election Day: voter phone add/edit

Added the ability to add or edit a voter's phone number directly from the ride-coordination contact modal (`/election-day`):

- **"הוסף מספר" button** in the phone row when a voter has no phone on file, replacing the old static "לא צוין" text.
- **Pencil icon** next to the phone number when one already exists, opening the same dialog pre-filled with the current value.
- New **`PhoneEditDialog`** component - mobile-first, dynamic title ("הוספת מספר טלפון" / "עדכון מספר טלפון"), Hebrew validation error for an invalid number, a `busy` state that disables the save button to prevent double submission, and a network-failure path that preserves whatever the user typed instead of losing it.
- Accepts Israeli numbers with dashes, spaces, a leading `0`, or a `+972`/`972` country code - all normalized to the same local format the search index already expects, so a newly-added or edited number is immediately findable by search.
- Any signed-in `PermissionUser` can use it, regardless of role - no manager-only restriction was added.
- The update touches only the voter's `phone` field (by internal id) - every other field (name, address, coordinator, notes, ride-request/arranged/completed status, voted status, reminders) is left untouched. No database migration, RLS, or RPC change was needed.
- Live updates propagate through the existing Realtime subscription - no new subscription was introduced.
- Fixed a real bug found while building this: opening `PhoneEditDialog` from within the already-open contact modal is the first place in the app with two modals open at once, and `Modal`'s Escape-key handling and body-scroll lock were previously per-instance-flat - closing or Escaping the inner dialog could have also closed or unlocked the outer one. `Modal.tsx` now tracks an explicit stack of open modals so only the topmost reacts to Escape, and the scroll lock only releases once every modal is closed.
- Verified end-to-end against the real production Supabase project both before and after deployment (safe methodology: real, naturally-occurring test voters, full snapshot before/after, no lasting data change).

Shipped as commit `b7a2a96`, deployed to `https://kolbox-gamma.vercel.app`. Production Smoke Test: **18/18 PASS**.
