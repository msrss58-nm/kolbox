# KolBox (קולבוקס)

Campaign & election management web platform: import a voter registry, let activists classify voters (supporter/potential/opponent), track everything on an analytics dashboard, and run an election-day ride-coordination screen (`/election-day`, built - see task-plan.md §4 P1). The full turnout/polling-station war room is still post-MVP.

**Read `task-plan.md` first** - it holds the full feature plan, architecture, MVP scope, and a Progress Log.

## Project overview

KolBox turns a raw voter registry into a get-out-the-vote machine. The core loop:

1. **Load data** - import the voter registry (Excel/CSV/JSON) or start from the bundled demo dataset.
2. **Classify** - activists search the registry and tag voters they know: supporter (תומך) / potential (מתלבט) / opponent (מתנגד).
3. **Track** - a dashboard turns raw tags into campaign-manager insight: coverage, trend, top cities, activist leaderboard.
4. **Election day** - `/election-day`, a ride-coordination war room: import a separate ride-list, filter by coordinator/city/status, a global countdown clock, call/WhatsApp a voter or route the request to a pre-registered driver, mark rides arranged and voters voted. Built in full - see task-plan.md §4 P1. _(Still post-MVP: live turnout tracking across polling stations, the broader "freeze tagging" GOTV chase-list flow.)_

MVP = Core Campaign Management mode only. Auth is real (Supabase) - pulled forward from post-MVP; see task-plan.md §5.5. Election Day's ride-coordination mode was also pulled forward and built in full this session; the remaining polling-station turnout war room is not. Voter/activist/classification _data_ still lives in `MockApi` + localStorage. Election Day's own data (ride-list contacts, ride-status log, ride-coordinator roster, permission-user roster, countdown deadline) has since moved to a shared Supabase backend (`src/services/api/supabaseElectionDayApi.ts`, `supabase/migrations/*_election_day_*.sql`) so it works across real devices - see task-plan.md's Progress Log and "Known Security Limitations" below.

## Non-negotiable requirements

- **Hebrew + RTL everywhere.** `dir="rtl"` is set globally. Use Tailwind logical properties (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`) - never `ml/mr/pl/pr/left/right` unless direction-agnostic.
- **Mobile-first web app** (not a native app). Base styles target phones; enhance with `md:`/`lg:`. Every screen must work at 375px: touch targets ≥44px, tables become cards, drawers become full-screen bottom sheets, the desktop sidebar becomes a bottom nav bar.
- **UI quality is a headline requirement.** Skeleton loaders, empty states, micro-animations, consistent spacing. It should look like a funded SaaS, not a school project.
- **All data access goes through the `ApiClient` interface** (`src/services/api/`). UI never touches localStorage or mock JSON directly - `MockApi` will be swapped for `SupabaseApi` post-MVP with zero UI changes.
- **Never reference the commercial platform this project was inspired by** - not in code, comments, docs, commit messages, or UI. KolBox stands on its own.
- **Update `task-plan.md` after every implementation step** - check off items and add a row to the Progress Log (§6). Mandatory, not optional.

## Auth (real Supabase - see task-plan.md §5.5 for the full design)

Single-campaign model: one Supabase project = one campaign, no multi-tenancy. First sign-up becomes manager; activists are invited by email (magic link) from the Activists page, never self-signup.

- Requires `.env.local` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (copy `.env.example`). Project: `kolbox Project` (`nbymfgphnsounqncfjgl`, ap-southeast-1).
- `src/services/supabase/client.ts` - the typed client. `src/features/auth/authStore.ts` - real session state via `onAuthStateChange`, no fake localStorage session anymore.
- `profiles.role` can be `null` - a "pending approval" state (organic sign-up after a manager already exists). `AuthGuard` renders `PendingApprovalScreen` for it; never treat a signed-in user as authorized without checking `role`.
- Inviting an activist calls the `invite-activist` Edge Function (manager-only, service-role key never reaches the browser) - don't call `auth.admin.*` from client code.
- Voters/activists/classification data are **not yet** in Supabase - they're still `MockApi`/localStorage (per-browser). `ensureActivistProfile()` + `useSyncActivistProfile` bridge a real activist's Supabase identity to a local mock `Activist` record so tag-counts work. This shim is temporary - remove it once the P2 `MockApi` → `SupabaseApi` migration lands.

## Election Day's own local login (separate from the Supabase auth above)

`/election-day` has its own, self-contained "session" - **not** Supabase, not connected to `profiles`/`UserRole` in any way, deliberately scoped to this one screen.

- `src/features/election-day/electionDaySession.ts` - a zustand store (`useElectionDaySession`) that checks an entered name/password against `ApiClient.listPermissionUsers()` (the local roster managed from the "ניהול הרשאות משתמשים" button/modal - `PermissionUser { id, name, password, role: "user"|"manager" }`, plaintext, `MockApi`/localStorage only - there is no hashing and no real security boundary here, by design, for an internal tool). A successful login persists just `{id, name, role}` to its own localStorage key so a refresh doesn't sign out.
- `ElectionDayGuard.tsx` wraps only the `/election-day` route: **while the permissions roster is empty the screen stays fully open** (no login required) so whoever sets it up can reach "ניהול הרשאות משתמשים" to add the first account - once any account exists, `ElectionDayLoginScreen.tsx` gates it.
- Row-level scoping: `useElectionDay.ts`'s `scopedContacts` filters to `coordinator === sessionUser.name` for `role: "user"`; `role: "manager"` (or no session yet, pre-roster) sees everything. Same choke point pattern every derived value (`stats`/`coordinatorBreakdown`/`rideCoordinationQueue`/etc.) reads through instead of the raw fetched list.
- UI-level restriction for `role: "user"`: the whole load/delete/ride-coordinators/permissions/export button row on `ElectionDayPage.tsx` isn't rendered at all, and - the one place this session reaches outside the Election Day feature - `AppLayout.tsx`'s shared sidebar/bottom-nav renders every other nav item as an inert, non-interactive `<span>` instead of a `NavLink` (visible but genuinely unclickable, not just styled to look disabled).
- **Router structure** (`router.tsx`): `AppLayout` is the shared parent for both the main app and Election Day (one sidebar/nav for both), but `AuthGuard` (Supabase) only wraps the main app's routes (`/`, `/voters`, `/activists`, `/import`, `/team`) as a nested child inside `AppLayout` - `/election-day` sits as a sibling route directly under `AppLayout`, gated only by `ElectionDayGuard`, never by `AuthGuard`. Don't nest `/election-day` under `AuthGuard` - it would force every Election Day operator to also hold a real Supabase account (contradicting this section's opening line) and would break the empty-roster bootstrap above, since `AuthGuard` would redirect to `/login` before `ElectionDayGuard` ever runs.

## Known Security Limitations (Election Day → Supabase migration)

Accepted, explicit trade-offs from the approved Election Day → Supabase migration plan (see task-plan.md) - not oversights, deliberately not solved yet:

- **No rate limiting on `election_day_login`** - the Postgres RPC (pgcrypto bcrypt compare) is reachable by anyone holding the public anon key, not just from a browser actually running the app - there is no brute-force/throttling protection on password guessing today.
- **`election_day_list_permission_users()` requires no login at all** - by design, since PermissionUser has no real Supabase Auth identity behind it (see "Election Day's own local login" above), this RPC has no caller-identity check whatsoever. Anyone with the anon key can list every PermissionUser's `{id, name, role}` (never `password_hash`, which no RPC ever returns) without going through `ElectionDayLoginScreen.tsx` at all.
- **Election Day's core tables use permissive RLS** (`USING (true)` for `anon`+`authenticated` on `election_day_voters`/`election_day_ride_status_events`/`election_day_ride_coordinators`/`election_day_settings`) - the same trust level as today's per-browser MockApi, just shared across devices now. The "user sees only their own coordinator's contacts" rule stays enforced client-side only (`useElectionDay.ts`'s `scopedContacts`), never at the database level.

## Resolved: Election Day phone-optional import fix

A real ride-list import used to silently drop every row missing a phone number (no reporting at all) - product decision: phone is optional, a voter without one is still a legitimate record. Fixed end-to-end and verified live: the `election_day_voters_phone_optional` migration (`alter column phone drop not null`) is pushed - `information_schema.columns` confirms `phone.is_nullable = YES` in production - and the real ~1,900-row ride-list has been re-imported and verified: **1928/1928 rows landed, 0 rejected** (968 with no phone, 960 with a phone - the 960 matches exactly what silently made it through under the old buggy import). Re-verified multi-device Realtime sync against this full dataset (two independent browser contexts both show 1928 total; a `voted` toggle on client A propagated live to client B with no refresh, no console/network errors).

**A second, related bug was found and fixed during this verification**: `SupabaseElectionDayApi.listElectionDayVoters()` and `.listRideStatusEvents()` used a plain unranged `.select("*")`, which PostgREST silently caps at its default max-rows (1000) - with the real dataset at 1928 rows, the app displayed exactly 1000 and dropped the rest with no error of any kind (same failure shape as the phone bug: legitimate rows present in the database but invisible in the app). Both methods now page through with `.range()` in a loop until a short page is returned. No migration needed for this one - it was a client-side query bug, not a schema issue.

## Resolved: name search was order-dependent

The contact search only matched a single substring against `"${firstName} ${lastName}"` - "נחום משה" never found a voter stored as "משה נחום", and phone-only fields weren't searched consistently. Replaced with `src/features/election-day/electionDaySearch.ts`'s `matchesElectionDaySearch()` - normalizes (trim/lowercase/collapse whitespace), builds one combined searchable string per contact from every field (name, city, street, house number, coordinator, masad, phone as-typed and digits-only), tokenizes the query, and requires every token to appear somewhere in that string regardless of order. Verified against the full 1928-row live dataset (reversed word order, half-names, prefixes, messy whitespace, partial phone with/without dashes) with sub-second response times.

## Resolved: election-day ride-list import wasn't atomic

A production-readiness audit found the import ran as 3 separate REST calls (delete ride-status events, delete voters, insert new voters) with no transactional guarantee - a dropped connection or failed insert between the deletes and the insert would have left the live table permanently empty. Fixed via `election_day_import_voters(p_voters jsonb)`, a `security invoker` Postgres function (migrations `election_day_atomic_import` + a same-day follow-up `election_day_atomic_import_where_fix` - Supabase's hosted Postgres enforces "DELETE requires a WHERE clause," which the first version's bare `delete from` hit immediately; both deletes now say `where true`) - a function body is one implicit transaction, so any failure inside rolls back everything, never a half-deleted table. `SupabaseElectionDayApi.importElectionDayVoters()` now calls this RPC in one round trip instead of three. Verified empirically: a deliberate NOT-NULL-violating payload left the existing 1928 rows completely untouched (proving rollback), and a real full re-import of the real ~1,900-row file succeeded end-to-end afterward with no console/network errors, multi-device Realtime sync intact.

Same audit also found and fixed a silent data-corruption bug in `electionDayImport.ts`: a house number like `"53/3"` (entrance suffix) or `"10א"` (building-letter suffix) - both real, common Israeli address formats - was blindly coerced with `Number(...)`, which returns `NaN` and silently zeroed the address. Now extracts the leading digit run instead (`parseHouseNumber`), recovering the real number for these cases; a source cell Excel itself auto-formatted as a date (a spreadsheet data-entry artifact, unrecoverable at the app layer) still falls back to 0, unchanged from before.

## Resolved: import had no confirmation, and network failures leaked a raw English error

A quality-gate closure pass found the "טען קובץ בוחרים" import button fired immediately on file selection - unlike the equally-destructive "מחק קובץ בוחרים" (clear all), which already went through `ConfirmDialog`, an accidental/stale file selection mid-election-day would silently wipe every vote/ride-status recorded that day with zero confirmation. Fixed: file selection now stages the file and opens a `ConfirmDialog` (`ELECTION_DAY_TEXT.import.confirm*`) explicitly warning that the import replaces the existing list and can change already-recorded election-day data - the import only runs after explicit confirmation. Verified live: selecting a file shows the dialog without importing, cancel leaves the data completely untouched, confirm proceeds normally.

Also found while testing real network disruption (`context.setOffline()` mid-action against the live Supabase project): every failed request surfaced the raw browser-internal message `TypeError: Failed to fetch` verbatim in the toast - not a clear message for a Hebrew-speaking user. Root cause: Supabase-js re-throws a plain `Error` whose `.message` is the _stringified_ original fetch error, not a real `TypeError` instance, so a naive `instanceof TypeError` check wouldn't have caught it either. Fixed in `useAsyncAction.ts` (the shared hook every mutation across the whole app goes through, not just Election Day) - `isNetworkFailure()` matches on message content ("failed to fetch" / "networkerror" / "load failed") regardless of the error's actual class, and shows `COMMON_TEXT.networkError` ("אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב") instead. Also fixed a second, related bug found in the same code path: `options.errorMessage` (documented as the fallback message for a messageless error, and genuinely relied on by the voter-registry import wizard) was silently never read - the catch block always fell back to a hardcoded default instead. Verified live against the real 1928-row dataset with real network disconnects: offline mid-"mark as voted", mid-ride-status-toggle, and mid-import (both before and after the request left the browser) all show the friendly Hebrew message, never a raw leak, never a silent state change, and the data is provably unchanged after reconnecting - a deliberate NOT-NULL-violating import and an offline-interrupted import both left the existing 1928 rows completely intact.

A 20-concurrent-browser-context load test (login, full 1928-row read, concurrent voted/ride-status updates, Realtime) against the actual **production build** (not `vite dev`, which bottlenecks hard under concurrent unbundled-module requests and isn't representative of the deployed static build) showed 0 navigation failures, 0 console/network errors, and all 20 clients converging on the correct state within 11s; the real Supabase request round-trip under this load measured median ~4.1s / p90 ~6.1s (vs ~1-2s single-user) - elevated but error-free, and this is a one-time page-load cost, not a per-action cost.

A follow-up 40/50-concurrent-client load gate (the actual production requirement) isolated backend capacity from local test-harness capacity: raw concurrent HTTP calls straight to Supabase (no browser) succeeded 40/40 and 50/50 with sub-2s max latency, while a literal 40-full-browser-context UI run failed on this specific dev laptop (2 physical cores, ~3-4GB free RAM) - traced via bisection (4/10/15 clients) to local Chromium rendering contention, not an app or backend defect (see task-plan.md's Progress Log for the full evidence). Verdict: **PASS**, backend and application logic verified sound at the required concurrency; a real 40-50-browser UI run on stronger hardware (CI/cloud) remains a recommended but non-blocking follow-up.

## Current state: Production Hardening pushed, deployed, and smoke-tested - ready for real use

Commit `0246221` ("fix: harden election day for production...") closed the Election Day production-readiness hardening pass described in the sections above. It's since been pushed and deployed: `origin/master` == `0246221` (`7056d76..0246221 master -> master`, confirmed both via `git rev-list --left-right --count origin/master...master` = `0 0` and Vercel's `meta.githubCommitSha`). `git status` is clean (only doc updates pending, not yet committed).

Vercel auto-deployed from the push (Git integration, not a manual CLI deploy this time) - deployment `dpl_9rbgczzgqUH2kjd2Q9XHYU5y46Uo`, `readyState: READY`, `target: production`, aliased to `https://kolbox-gamma.vercel.app`.

A safe production smoke test followed (no real import, no voter-record mutation - see task-plan.md's Progress Log for the full methodology and per-check results): **15/15 checks passed** - bootstrap open-access, PermissionUser create/login/delete for both `manager` and `user` roles, role-scoped UI (control-panel row hidden + inert nav for `user`), search, and a toggle-and-revert CRUD round trip on a dedicated `RideCoordinator` test record. Verified after cleanup: the real 1,928-row voter dataset was untouched, the permission-user roster and ride-coordinator table were both back to empty. Realtime itself wasn't re-exercised against production in this pass (touching it live would have required mutating real voter/ride-status data, which was explicitly out of scope) - it was already verified exhaustively earlier this session (multi-device sync against the full 1928-row dataset, 20-client and 40/50-client load gates).

**The Election Day production hardening milestone is closed. The system is ready for real election-day use at `https://kolbox-gamma.vercel.app/election-day`.**

## Deployment (Vercel)

- **Production URL: `https://kolbox-gamma.vercel.app`** - live since 2026-07-19.
- Vercel project `kolbox`, scope/team `nahom10`. `vercel link` auto-connected the GitHub repo (`msrss58-nm/kolbox`) as part of linking.
- Production env vars are set directly in the Vercel project settings (not in this repo): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` - same two vars as local `.env`, marked Sensitive/Encrypted in Vercel. If either is missing, the build fails at `src/services/supabase/client.ts`'s throw.
- `vercel.json` at repo root has the SPA rewrite (`/(.*) → /index.html`) needed for `react-router` client-side routing on refresh/deep-links - required, don't remove it.
- Earlier deploys were CLI-only (`vercel --prod` from a local working copy); the `0246221` deploy confirmed the GitHub Git integration now auto-deploys on push to `master` - production and `origin/master` are in sync as of this deploy. Always check `git status`/`git log` before assuming what's live matches what's in git, since a manual `vercel --prod` from a dirty working copy is still possible and would break that assumption again.

## Code conventions

These were established during a deliberate refactor pass - follow them for all new code, don't regress to the patterns they replaced.

### No hardcoded UI text

Every Hebrew label, button caption, toast message, and error string lives in a **constants file** - never inline in JSX beyond genuinely one-off, single-use copy.

- **Cross-cutting constants** in `src/constants/`:
  - `routes.ts` - `ROUTES` path constants + `NAV_ITEMS` (nav config with icons)
  - `labels.ts` - domain enum labels (`CLASSIFICATION_LABELS`, `RANK_LABELS`, `ROLE_LABELS`, `CLASSIFICATIONS`)
  - `config.ts` - `APP_CONFIG`: every timing/threshold/size magic number (debounce ms, mock latency range, demo dataset size, campaign goal ratio, voter page-size options, etc.)
  - `chart.ts` - shared Recharts colors/tooltip styles
  - `common-text.ts` - generic action words reused across forms (ביטול/שמירה/הוספה)
- **Feature-local constants** colocated per feature, named `<feature>.constants.ts` (e.g. `src/features/voters/voters.constants.ts`, `activists.constants.ts`, `dashboard.constants.ts`, `import.constants.ts`, `auth.constants.ts`). Holds that feature's page titles, field labels, empty-state copy, and toast-message builders (functions like `(count) => \`...${count}...\`` for dynamic text).

Domain **types** stay pure in `src/types/index.ts` - no label maps or UI strings there; labels live in `constants/labels.ts`.

### Hooks over repeated effects

Shared, reusable hooks live in `src/hooks/`:

- **`useAsyncData(fetcher)`** - replaces the `useState(null) + useEffect(fetch)` pattern repeated on every page. Returns `{ data, loading, error, reload, setData }`. `fetcher` must be stable (`useCallback`). `setData` is an escape hatch for optimistic local updates (e.g. patching one classified voter into an already-fetched list) without a network round-trip.
- **`useAsyncAction(action, { successMessage, errorMessage })`** - replaces the `setBusy(true) → try/catch/finally → toast` block repeated in every mutation (classify, save, import). Returns `{ run, busy }`.
- **`useDebouncedValue(value, delayMs)`** - generic debounce (search inputs).
- **`useIsDesktop()`**, **`useCountUp(target)`** - existing UI hooks, also live here.

Feature-specific hooks are colocated per feature (`useVoterRegistry`, `useDashboardData`, `useActivists`, `useImportWizard`) and own that feature's state/mutations so the page component stays a thin view. A page component's job is composing hooks + presentational subcomponents - not holding business logic.

**React Compiler purity rule:** never call `Date.now()` (or any impure function) synchronously during render or inside a `useMemo`/`useState` initializer that runs during render - it belongs inside an async fetcher (effect phase) or an event handler. See `lib/activity.ts` / `ActivistDrawer.tsx` for the pattern.

**Avoid `setState` synchronously inside `useEffect` bodies** (the `react-hooks/set-state-in-effect` rule will flag it) when the goal is "reset state when some value changes." Use the sanctioned render-phase-compare pattern instead - track the previous value in `useState`, compare it during render, and call `setState` conditionally in the render body (not inside `useEffect`). See `hooks/useAsyncData.ts`, `ActivistModal.tsx`, and `useVoterRegistry.ts`'s selection-reset for worked examples.

### Small, composable components

Split any page that grows past ~150 lines into: one page-level orchestrator + a feature hook (state/mutations) + small presentational subcomponents (one concern each) + a `<feature>.constants.ts`. Example shape (voters):

```
VotersPage.tsx        orchestrator - composes everything below
useVoterRegistry.ts   filters, pagination, fetch, selection, classify mutations
VoterFilters.tsx       filter controls (compact + full variants, no duplication)
VoterListHeader.tsx   desktop column header
VoterList.tsx          list/skeleton/empty-state for the current page (≤100 rows)
VoterRow.tsx           one row (desktop table row + mobile card)
BulkActionsBar.tsx    selection action bar
voters.constants.ts   all of the above's copy
```

Cross-cutting UI primitives like `components/ui/Pagination.tsx` (page-size selector + prev/next) are generic and reusable - no feature-specific text baked in; labels come from `constants/common-text.ts`.

Extract a pure function (e.g. `src/features/import/importMapping.ts`, `src/lib/activity.ts`) whenever logic doesn't need component state - pure functions are trivially testable and reusable.

### Git commits

Plain commits - author is the repo owner, no AI co-author trailer, no mention of AI tooling in messages, comments, or docs.

## Stack

React 19 · Vite 7 · TypeScript (strict) · Tailwind CSS v4 (CSS-config via `@theme`, no tailwind.config.js) · Recharts · zustand · react-router v7 (library mode) · lucide-react · xlsx (SheetJS) for Excel import/export · react-datepicker (themed via `.kb-datepicker*` overrides in `index.css`) for the election-day deadline field

## Commands

```
npm run dev           # start dev server
npm run build          # tsc -b && vite build
npm run lint            # eslint
npm run format:write  # prettier
```

## Structure

```
src/
├── app/                    # Shell: router, layout, auth guard
│   ├── router.tsx
│   ├── AppLayout.tsx       # sidebar (desktop) / bottom-nav (mobile) + topbar + <Outlet/>
│   ├── AuthGuard.tsx
│   └── appShell.constants.ts
├── constants/              # Cross-cutting constants - see "No hardcoded UI text" above
│   ├── routes.ts
│   ├── labels.ts
│   ├── config.ts
│   ├── chart.ts
│   └── common-text.ts
├── hooks/                  # Shared hooks - see "Hooks over repeated effects" above
│   ├── useAsyncData.ts
│   ├── useAsyncAction.ts
│   ├── useDebouncedValue.ts
│   ├── useIsDesktop.ts
│   └── useCountUp.ts
├── features/
│   ├── auth/                # LoginPage, authStore (zustand), auth.constants.ts
│   ├── dashboard/            # KPI section, charts (each own file), leaderboard, useDashboardData
│   ├── voters/               # registry list, filters, drawer, classification, useVoterRegistry
│   ├── activists/            # podium, roster, drawer, ranks, useActivists
│   ├── import/                # 3-step wizard (upload/map/summary), useImportWizard
│   └── election-day/          # ride-coordination screen (built, see task-plan.md §4 P1) - full turnout war room still post-MVP
├── services/
│   ├── api/                  # ApiClient interface + MockApi implementation; the `api` singleton composes MockApi with SupabaseElectionDayApi (Election Day's slice only)
│   ├── storage/               # localStorage adapter
│   └── excel/                  # xlsx parsing/export + column-mapping auto-detect
├── data/
│   ├── generator.ts           # deterministic seeded mock dataset generator
│   ├── pools.ts                 # name/city/street pools for the generator
│   └── fixtures/sample-records.json  # one example row per DB entity (reference for the Supabase schema)
├── components/
│   ├── ui/                    # Button, Card, Badge, Modal, Drawer, Toast, Field, Skeleton, EmptyState, Pagination…
│   ├── Logo.tsx, PageHeader.tsx
├── lib/                       # Pure utilities: formatters, Israeli ID checksum, rank math, activity binning
└── types/                     # Domain types only - no labels/strings (see constants/labels.ts)
```

**Key decisions**

| Concern       | Choice                                                                                           | Why                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Routing       | `react-router` v7 (library mode)                                                                 | Standard, simple                                                               |
| State         | `zustand`                                                                                        | Tiny, TS-friendly; auth store persisted to localStorage                        |
| Data fetching | `useAsyncData`/`useAsyncAction` hooks                                                            | One pattern for every page instead of repeated boilerplate                     |
| Charts        | **Recharts**                                                                                     | Most popular React chart lib, simple API, RTL-workable, responsive containers  |
| Tables        | Server-side pagination (offset/limit, 10/25/50/100 per page)                                     | Bounds rendered rows to ≤100 - no virtualization needed; card layout on mobile |
| Excel         | `xlsx` (SheetJS, patched build via CDN - the npm build has a known high-severity advisory)       | Parse/export .xlsx client-side                                                 |
| Icons         | `lucide-react`                                                                                   | Clean, consistent                                                              |
| Fake API      | `MockApi` class w/ artificial latency, seeded from generator, debounced localStorage persistence | Swapping to Supabase = implement same `ApiClient` interface                    |

**Responsive strategy (mobile-first)**

- Breakpoints: base = phone, `md:` = tablet, `lg:` = desktop.
- Navigation: desktop = fixed RTL sidebar; mobile = bottom navigation bar.
- Voter/activist lists: desktop = table rows; mobile = stacked cards. Same data, two render branches in one row component.
- Drawers/modals: desktop = side drawer / centered modal; mobile = full-screen bottom sheet.
- Charts: Recharts `ResponsiveContainer` everywhere; KPI cards wrap into a 2-col grid on phone.

## Domain vocabulary

| Hebrew       | English          | Meaning                                                                                           |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------- |
| בוחר         | Voter            | Registry record (ID, name, address, polling station)                                              |
| סיווג        | Classification   | supporter (תומך, green) / potential (מתלבט, amber) / opponent (מתנגד, red) / unclassified (slate) |
| פעיל         | Activist         | Field user who tags voters; has gamified rank by tag count                                        |
| קלפי         | Polling station  | Where votes are cast; has live turnout on election day                                            |
| מנהל קמפיין  | Campaign manager | Admin role, sees all analytics                                                                    |
| משקיף        | Poll observer    | Election-day role, marks voters as "voted"                                                        |
| פנקס הבוחרים | Voter registry   | The imported base dataset                                                                         |
