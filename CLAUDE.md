# KolBox (קולבוקס)

Campaign & election management web platform: import a voter registry, let activists classify voters (supporter/potential/opponent), track everything on an analytics dashboard, and run an election-day ride-coordination screen (`/election-day`, built - see task-plan.md §4 P1). The full turnout/polling-station war room is still post-MVP.

**Read `task-plan.md` first** - it holds the full feature plan, architecture, MVP scope, and a Progress Log.

## Project overview

KolBox turns a raw voter registry into a get-out-the-vote machine. The core loop:

1. **Load data** - import the voter registry (Excel/CSV/JSON) or start from the bundled demo dataset.
2. **Classify** - activists search the registry and tag voters they know: supporter (תומך) / potential (מתלבט) / opponent (מתנגד).
3. **Track** - a dashboard turns raw tags into campaign-manager insight: coverage, trend, top cities, activist leaderboard.
4. **Election day** - `/election-day`, a ride-coordination war room: import a separate ride-list, filter by coordinator/city/status, a global countdown clock, call/WhatsApp a voter or route the request to a pre-registered driver, mark rides arranged and voters voted. Built in full - see task-plan.md §4 P1. _(Still post-MVP: live turnout tracking across polling stations, the broader "freeze tagging" GOTV chase-list flow.)_

MVP = Core Campaign Management mode only. Auth is real (Supabase) - pulled forward from post-MVP; see task-plan.md §5.5. Election Day's ride-coordination mode was also pulled forward and built in full this session; the remaining polling-station turnout war room is not. Voter/activist/classification _data_ still lives in `MockApi` + localStorage, not yet migrated to Supabase (Election Day's ride-list/coordinators data too).

## Non-negotiable requirements

- **Hebrew + RTL everywhere.** `dir="rtl"` is set globally. Use Tailwind logical properties (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`) - never `ml/mr/pl/pr/left/right` unless direction-agnostic.
- **Mobile-first web app** (not a native app). Base styles target phones; enhance with `md:`/`lg:`. Every screen must work at 375px: touch targets ≥44px, tables become cards, drawers become full-screen bottom sheets, the desktop sidebar becomes a bottom nav bar.
- **UI quality is a headline requirement.** Skeleton loaders, empty states, micro-animations, consistent spacing. It should look like a funded SaaS, not a school project.
- **All data access goes through the `ApiClient` interface** (`src/services/api/`). UI never touches localStorage or mock JSON directly - `MockApi` will be swapped for `SupabaseApi` post-MVP with zero UI changes.
- **Never reference the commercial platform this project was inspired by** - not in code, comments, docs, commit messages, or UI. KolBox stands on its own.
- **Update `task-plan.md` after every implementation step** - check off items and add a row to the Progress Log (§6). Mandatory, not optional.

## Auth (real Supabase - see task-plan.md §5.5 for the full design)

Single-campaign model: one Supabase project = one campaign, no multi-tenancy. First sign-up becomes manager; activists are invited by email (magic link) from the Activists page, never self-signup.

- Requires `.env.local` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (copy `.env.example`). Project: `kolbox` (`jcfzgyzqbhznncvldyvw`, eu-central-1).
- `src/services/supabase/client.ts` - the typed client. `src/features/auth/authStore.ts` - real session state via `onAuthStateChange`, no fake localStorage session anymore.
- `profiles.role` can be `null` - a "pending approval" state (organic sign-up after a manager already exists). `AuthGuard` renders `PendingApprovalScreen` for it; never treat a signed-in user as authorized without checking `role`.
- Inviting an activist calls the `invite-activist` Edge Function (manager-only, service-role key never reaches the browser) - don't call `auth.admin.*` from client code.
- Voters/activists/classification data are **not yet** in Supabase - they're still `MockApi`/localStorage (per-browser). `ensureActivistProfile()` + `useSyncActivistProfile` bridge a real activist's Supabase identity to a local mock `Activist` record so tag-counts work. This shim is temporary - remove it once the P2 `MockApi` → `SupabaseApi` migration lands.

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
│   ├── api/                  # ApiClient interface + MockApi implementation
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
