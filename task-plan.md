# KolBox (קולבוקס) - Task Plan

> A campaign & election management platform - turns raw voter data into election-day victory.
> Stack: **React 19 + Vite + TypeScript + Tailwind CSS v4 + Recharts**. Hebrew, RTL, mobile-friendly web app.

---

## 1. The Problem KolBox Solves

Winning an election isn't only about convincing people - it's about making sure your supporters **actually show up and vote**. Cold calls and mass SMS are ineffective; the most effective persuasion is **peer-to-peer**: a person you know personally asking you to vote ("relational organizing").

The operational problem:

1. Campaigns receive the official **voter registry (פנקס הבוחרים)** - thousands/millions of raw records (name, ID, address, polling station) with no idea who supports them.
2. They have hundreds of **activists (פעילים)** who each personally know some voters - but no way to aggregate that knowledge.
3. On **election day (יום הבחירות)** they need to know, in real time, _which tagged supporter hasn't voted yet_ - and send someone to get them out.

### The KolBox methodology - 3 stages

| Stage                           | What happens                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Data loading**             | Import the voter registry + historical campaign data.                                                                                                                              |
| **2. Supporter identification** | Activists search the registry and **classify** voters they know: supporter / potential / opponent. Gamified ranks reward productive activists.                                     |
| **3. Election-day activation**  | Tagging freezes. Observers mark tagged supporters as "voted" as they arrive. HQ watches a live war-room dashboard and directs activists to chase supporters who haven't voted yet. |

### Key roles

- **Campaign manager / HQ (מנהל קמפיין / מטה)** - sees everything: dashboards, analytics, activist performance, turnout.
- **Activist (פעיל)** - scoped to a group/area; searches voters, tags classifications, adds supporters.
- **Poll observer (משקיף)** - on election day, marks voters at a specific polling station as "voted".

### Core domain model

- **Voter (בוחר)** - ID, name, address, city, polling station #, phone.
- **Classification (סיווג)** - supporter (תומך) / potential (מתלבט) / opponent (מתנגד) / unclassified; who tagged it, when.
- **Activist (פעיל)** - user with area/group scope, tag count, gamified rank.
- **Polling station (קלפי)** - number, address, registered voters, live turnout.
- **Vote event** - election-day "voted" mark per voter.

---

## 2. Product Vision

**KolBox (קולבוקס)** - "כל קול בקופסה".

Two modes:

1. **🗳 Core Campaign Management mode** - the "before" phase: registry, classification, activists, analytics. **← MVP**
2. **🔴 Election Day mode** - the war room: live turnout, get-out-the-vote chase list, polling stations. **← Post-MVP**

### Non-negotiables

- **Hebrew, full RTL** (`dir="rtl"`, logical Tailwind utilities: `ms-*`/`me-*`, `start`/`end`)
- **Stunning UI** - headline requirement. Dark-sidebar dashboard aesthetic, Heebo/Rubik Hebrew font, purposeful color system, micro-animations, empty states, skeleton loaders. It should look like a funded SaaS, not a school project.
- **Mobile-friendly web app** - not a native app, but every screen must work beautifully on a phone browser: collapsible navigation (bottom nav / hamburger on mobile), tables collapse to cards, touch-sized tap targets (≥44px), drawers become full-screen sheets. Activists will use this on phones in the field - mobile is a primary form factor, not an afterthought.
- **Data**: Excel (.xlsx) import + bundled JSON mock dataset + a **mock API service layer** (async, typed, swappable for Supabase later) + localStorage persistence.
- **Auth**: real Supabase Auth (pulled forward from post-MVP, see §5.5) - single-campaign model, manager signs up once (bootstraps as manager), activists are invited by email (magic link, no password). Voters/activists/classification data still live in `MockApi`/localStorage - only identity moved to Supabase so far.

---

## 3. Architecture

```
src/
├── app/                  # App shell: router, layout, auth guard
│   ├── router.tsx
│   ├── AppLayout.tsx     # sidebar (desktop) / bottom-nav (mobile) + topbar + <Outlet/>
│   ├── AuthGuard.tsx
│   └── appShell.constants.ts
├── constants/            # Cross-cutting constants - routes, domain labels, app config, chart theme
├── hooks/                # Shared hooks - useAsyncData, useAsyncAction, useDebouncedValue, useIsDesktop, useCountUp
├── features/
│   ├── auth/             # LoginPage, authStore, auth.constants.ts
│   ├── dashboard/        # KPI section, charts (own files), leaderboard, useDashboardData
│   ├── voters/           # registry list, filters, drawer, classification, useVoterRegistry
│   ├── activists/        # podium, roster, drawer, ranks, useActivists
│   ├── import/            # 3-step wizard, useImportWizard
│   └── election-day/      # (post-MVP) war room
├── services/
│   ├── api/               # ApiClient interface + MockApi implementation
│   ├── storage/            # localStorage adapter
│   └── excel/               # xlsx parsing/export + column-mapping auto-detect
├── data/
│   ├── generator.ts        # deterministic seeded mock dataset generator
│   ├── pools.ts              # name/city/street pools
│   └── fixtures/             # sample-records.json - one example row per DB entity
├── components/ui/          # Button, Card, Badge, Modal, Drawer, Toast, Field, Skeleton, EmptyState, Pagination…
├── lib/                     # pure utils: formatters, ID checksum, rank math, activity binning
└── types/                    # domain types only - labels live in constants/labels.ts
```

Full conventions (constants-only text, hooks-first data fetching, component-splitting rules, commit style) are documented in `CLAUDE.md` - read it before adding new features.

_(Superseded by the Key decisions table above - kept here only as history.)_

---

## 4. Feature Breakdown

### ✅ MVP - Core Campaign Management mode

#### M0. Foundation ✅

- [x] Install deps: react-router, zustand, recharts, lucide-react, xlsx (SheetJS 0.20.3 patched build), @tanstack/react-virtual, clsx
- [x] Tailwind v4 theme: color tokens (primary indigo/violet, classification colors: green=תומך, amber=מתלבט, red=מתנגד, slate=לא מסווג), Heebo font, sidebar palette, motion keyframes, skeleton utility
- [x] `dir="rtl"` + `lang="he"` in index.html; Heebo loaded; KolBox favicon; viewport-fit for phones
- [x] Types for full domain model (`src/types/index.ts`); seeded deterministic mock data generator (`src/data/generator.ts`) - 5,000 voters in households across 14 cities, 28 polling stations, 25 activists w/ power-law productivity, ~1,790 classification events ramping toward today; valid ת"ז checksums (`src/lib/israeliId.ts`); rank thresholds (`src/lib/ranks.ts`)
- [x] `ApiClient` interface (`src/services/api/types.ts`) + `MockApi` (latency-simulated, debounced localStorage persistence) + storage adapter; smoke-tested via `scripts/smoke-m0.ts`

#### M1. App shell & auth ✅

- [x] Login page (fake auth): gradient brand panel + logo, role picker (מנהל קמפיין / פעיל שטח), auto-persisted session - verified at 375px
- [x] AuthGuard-protected routes; zustand auth store persisted to localStorage
- [x] App layout: RTL dark sidebar on desktop (user card + logout), mobile top bar + bottom nav; יום הבחירות nav item locked with "בקרוב" badge
- [x] Toast system (zustand store + imperative `toast.*` API), Modal (bottom-sheet on mobile), Button/Card/Badge/Skeleton/EmptyState primitives, Logo, PageHeader
- [x] Verified in headless Chromium (Playwright): login → dashboard → voters nav on desktop 1440px & mobile 375px, `dir=rtl`, no console errors; screenshots in `scripts/shots/`

#### M2. Dashboard (הדשבורד) ✅

- [x] KPI cards: total voters, supporters (+7-day delta), potentials, opponents, coverage %, active activists - rAF count-up animation, tone-colored icons; 2-col grid on phone
- [x] Charts (Recharts, ResponsiveContainer, chart palette CVD-validated via dataviz validator): classification donut w/ center coverage % + counts legend, 30-day cumulative trend lines (3 series + legend), supporters-by-city horizontal bars (RTL - reversed axis, bars grow leftward, value labels), top-5 activist leaderboard card w/ medal podium + rank badges
- [x] "Campaign goal" progress bar (gradient, animated, aria-progressbar)
- [x] Empty-state branch (no data → CTA to import); verified in Chromium desktop+mobile, no console errors (`scripts/drive-m2.mjs`)

#### M3. Voter registry (פנקס הבוחרים) ✅

- [x] Paginated list: table on desktop, stacked cards on mobile - name, ת"ז, city, address, phone, classification badge; page-size selector (10/25/50/100, default 10) + prev/next, resets to page 1 on filter/page-size change (server-side offset/limit via `ApiClient`, no client-side virtualization needed once pages are capped at ≤100 rows)
- [x] Debounced instant search (name/ת"ז/phone) + filters (city, classification) + sort (name/city/recent/birth-year); filters in a bottom-sheet on mobile
- [x] Voter detail drawer (side panel desktop / bottom sheet mobile): full info incl. polling station, classification history with activist attribution, quick-classify footer
- [x] One-click classification - ClassifySegment control (tap active value to clear), optimistic list merge + toast
- [x] Bulk actions: select-all/row checkboxes → bulk classify bar (new `bulkClassify` on ApiClient); auto-family classification checkbox in drawer ("סיווג גם את בני הבית")
- [x] Add voter modal: full form, ת"ז checksum validation, birth-year sanity, city→station cascading select, duplicate-ת"ז rejection
- [x] Verified in headless Chromium desktop+mobile: search → classify → drawer flows, no console errors (`scripts/drive-m3.mjs`)

#### M4. Activists (פעילים) ✅

- [x] Activist list: rank #, name + tag count, area, phone, rank badge, next-rank progress bar, last activity - table on desktop, cards on mobile
- [x] Gamified ranks: טוראי → רב"ט → סמל → רס"ר → סגן → סרן → אלוף by tag count, tier-colored RankBadge
- [x] Leaderboard podium top-3 with crown + gold/silver/bronze medals
- [x] Add/edit activist modal (create + edit share one form); list re-sorts on save
- [x] Activist detail drawer: gradient hero stat + next-rank progress, classification breakdown (3 tiles), 8-week activity bar chart, edit button
- [x] Verified in Chromium desktop+mobile incl. add-activist flow, no console errors (`scripts/drive-m4.mjs`)

#### M5. Data import (טעינת נתונים) ✅

- [x] Import wizard (3 steps w/ step indicator): drag&drop upload (.xlsx/.csv/.json) + "load demo data" reset → column mapping UI with regex auto-detect (Hebrew+English headers) → live valid/invalid counts + 5-row preview → commit
- [x] Dedup by ת"ז (update vs add); summary screen: added/updated/skipped w/ per-row skip reasons (collapsible)
- [x] Export current registry to Excel + downloadable import template (bonus)
- [x] Verified end-to-end in Chromium with a generated .xlsx fixture (6 valid + 2 invalid rows): auto-detect ✓, counts ✓, summary 6/0/2 ✓, imported voter searchable in registry ✓ (`scripts/drive-m5.mjs`)

#### M6. Polish & ship

- [ ] Micro-interactions: page transitions, hover states, chart animations
- [ ] Full RTL + **mobile audit on real phone viewport** (375px) + responsive audit; lighthouse pass
- [ ] README with screenshots; `npm run build` clean; seed demo flow for presentation

### 🔜 Post-MVP

#### P1. Election Day mode (מצב יום הבחירות) - ride coordination ✅

The original rough sketch below (war room/turnout/chase-list) was superseded by
a concrete spec: a ride-coordination screen loaded from its own independent
Excel file, filtered by a free-text "אחראי" (coordinator) column set at
import time - not the existing Activist/Voter entities.

- [x] `ElectionDayVoter` domain type (`types/index.ts`) - independent of `Voter`: firstName, lastName, street, houseNumber, city, phone, coordinator, rideArranged, rideArrangedAt - field set matched to the campaign's real ride-list export (`שם פרטי/שם משפחה/רחוב/מס בית/עיר/טלפון/אחראי`)
- [x] `ApiClient` + `MockApi`: `importElectionDayVoters` (replaces the list wholesale), `listElectionDayVoters`, `setRideArranged`, `get/setElectionDayDeadline` - own localStorage keys, separate from the main `dataset-v1` blob
- [x] Real nav route unlocked (`/election-day`, `ROUTES.electionDay`) - removed the old locked "בקרוב" sidebar placeholder
- [x] Excel/CSV/JSON drop-zone import (auto-detects שם פרטי/שם משפחה/רחוב/מס בית/עיר/טלפון/אחראי columns via header regex; only first/last name, phone, coordinator required, address optional; no manual mapping step) - `electionDayImport.ts`
- [x] Coordinator filter (`CoordinatorFilter`) - multi-select (`MultiSelectDropdown`, reused from the voters feature) scoping the list to one or more אחראים at once; added a generic "נקה הכל" (clear all) action to `MultiSelectDropdown` itself, benefiting every multi-select in the app
- [x] Global countdown deadline: one datetime field (`CountdownHeader`) persisted via `ApiClient`, live-ticking days:hours:minutes:seconds clock (`useCountdown`, 1s interval, purity-rule compliant)
- [x] Row list (table desktop / cards mobile, `ElectionDayList`/`ElectionDayRow`) - click opens a `Modal` (`ElectionDayContactModal`) with call button (`tel:`) and a WhatsApp ride-coordination button (`wa.me` deep link, prefilled Hebrew message) + a persisted "הסעה תואמה" ride-status toggle
- [x] Dashboard (`ElectionDayDashboard`, below the countdown): 4 KPI tiles (total contacts, rides arranged, remaining, coverage %, reusing the dashboard feature's `KpiCard`) + a per-coordinator progress breakdown, always computed from the full unfiltered dataset
- [x] ~~Pace-vs-deadline card~~ - built, then removed per user feedback ("annoying", small early sample sizes made the projection look unreliable/confusing); replaced with a **recent activity** card (`RecentActivityCard`) - last 5 contacts marked "הסעה תואמה", newest first, with `fmtRelative` timestamps (same pattern already used in `ActivistDrawer`/`VoterDrawer`). `useCountdown` reverted to its simpler pre-pace shape (no longer exposes `now`)
- [x] `normalizeIsraeliPhone()` (`lib/phone.ts`) - Excel/CSV numeric-coerces phone columns and drops the leading 0; restored for 9-digit numbers so `tel:`/`wa.me` links dial correctly. Found and fixed by test-parsing the campaign's actual ride-list CSV
- [x] tsc + lint clean; dev server compiles/HMRs the new route with no errors (not yet click-through verified in a real browser session)

**Original sketch (not built, kept for reference if revisited):** mode switch, live turnout % vs national avg dashboard, votes-per-hour chart, polling-station heat list, poll observer check-in screen, simulated live ticker.

#### P2. Real backend - Supabase

- [x] Supabase Auth - pulled forward, done early; see §5.5 for the full design
- [ ] Postgres schema for the rest of the domain (voters, activists, classifications, stations, vote_events) + RLS per role
- [ ] Swap `MockApi` → `SupabaseApi` (same `ApiClient` interface - zero UI changes); retire the `ensureActivistProfile` sync shim once activists live in Postgres too
- [ ] Realtime subscriptions to power Election Day mode for real

#### P3. Extended modules

- Call center module: call queue + scripts + outcome logging
- SMS/messaging campaign composer (mock send)
- Map view of polling stations (leaflet)
- i18n (Hebrew/English switch)
- "Smart targeting" - simple scoring heuristic

---

## 5. Implementation order (MVP)

1. **M0 Foundation** → 2. **M1 Shell & auth** → 3. **M3 Voter registry** (core value) → 4. **M2 Dashboard** (needs data flowing) → 5. **M4 Activists** → 6. **M5 Import** → 7. **M6 Polish**

**Definition of done for MVP:** a presenter can log in, load demo data (or their own Excel), browse & classify 5,000 voters smoothly, watch the dashboard update live, and show off the activist leaderboard - in Hebrew, beautiful, on both a laptop and a phone.

---

## 5.5. Auth architecture (real Supabase, single campaign)

Pulled forward from P2 because a real login/signup flow needed a real identity model, not a fuller fake one.

**Model:** one Supabase project = one campaign. There is no multi-tenant `campaigns` table - every signed-in user belongs to _this_ campaign.

**Roles & how each gets an account:**

| Role                  | How they sign up                                                                                                                                                                                                                                                                                     | Sign-in method            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| מנהל קמפיין (manager) | Self-serve, but only once - the **first** account created via the sign-up form auto-becomes manager (`handle_new_user` trigger). Any _later_ organic sign-up lands with `role = null` (pending) instead of silently becoming a second manager.                                                       | Email + password          |
| פעיל (activist)       | Invited by the manager from the Activists page (name + email + area) → Edge Function `invite-activist` calls `auth.admin.inviteUserByEmail` with `{role:'activist', name, phone, area}` as invite metadata → the trigger turns that into their `profiles` row when they accept. No open self-signup. | Magic link (passwordless) |
| משקיף (observer)      | Not wired up yet (election-day mode is post-MVP)                                                                                                                                                                                                                                                     | -                         |

**Schema (Supabase project `kolbox`, id `jcfzgyzqbhznncvldyvw`):**

- `public.profiles` - `id` (= `auth.users.id`), `role` (nullable: null = pending approval), `name`, `phone`, `area`, `tag_count`, `joined_at`, `last_active_at`. RLS: any authenticated user can read (roster/leaderboard); a user can update their own row but not their own `role`; managers can update any row.
- `handle_new_user()` - `security definer` trigger on `auth.users` insert, `EXECUTE` revoked from `anon`/`authenticated`/`PUBLIC` (only the trigger runs it). Reads `role` from invite metadata, or bootstraps the first manager, or leaves `role` null.
- Edge Function `invite-activist` - verifies the caller is a manager (via their own JWT + a `profiles` lookup) before using the service-role key to send the invite. Service role key never reaches the browser.

**Known limitation (by design, not a bug):** voters/activists/classification events still live in `MockApi` + localStorage, which is per-browser - it isn't the real shared backend yet (that's the rest of P2). A real activist's Supabase account has no matching row in that local mock store, so `useSyncActivistProfile` + `ApiClient.ensureActivistProfile()` create one on first login (keyed to their real user id) purely so tag-counts/leaderboard keep working per-browser. This shim goes away once P2 finishes the full `MockApi` → `SupabaseApi` swap.

**App-side pieces:** `src/services/supabase/client.ts` (typed client, reads `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` from `.env.local`), `authStore.ts` (session state via `onAuthStateChange`, no more localStorage-persisted fake session), `AuthGuard.tsx` (loading / unauthenticated / **pending-approval** / authenticated), `LoginPage.tsx` with manager/activist tabs (`ManagerAuthPanel.tsx`, `ActivistAuthPanel.tsx`).

**Manual setup step (not scriptable via the tools available):** in the Supabase dashboard → Authentication → URL Configuration, add `http://localhost:5173` (and later the deployed URL) to Site URL / Redirect URLs, or magic-link and confirmation emails will redirect somewhere wrong.

---

## 6. Progress Log

> Updated after every implementation step.

| Date       | Step                                                                      | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-15 | Project scaffolded (Vite + React 19 + TS + Tailwind v4 + ESLint/Prettier) | ✅     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-15 | Research + task plan written                                              | ✅     | Plan approved pending review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-15 | CLAUDE.md created                                                         | ✅     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-15 | M0. Foundation                                                            | ✅     | Deps in (xlsx → patched SheetJS 0.20.3); Tailwind theme + RTL base; domain types; deterministic generator (5,000 voters, seed 1948); ApiClient + MockApi + localStorage; build/lint clean; smoke test passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-15 | M1. App shell & auth                                                      | ✅     | Login (role picker, fake auth), AuthGuard, RTL dark sidebar + mobile bottom nav, UI primitives (Button/Card/Badge/Modal/Toast/Skeleton/EmptyState); Playwright-verified desktop+mobile, no console errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-07-15 | M3. Voter registry                                                        | ✅     | Virtualized registry (table/cards), debounced search + filters + sort, quick/bulk/family classification, voter drawer w/ history, add-voter modal w/ ת"ז checksum; browser-verified both viewports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-15 | M2. Dashboard                                                             | ✅     | Count-up KPIs, goal progress, donut + trend + RTL city bars (Recharts), leaderboard preview; palette CVD-validated; label-overlap bug found via screenshot and fixed; browser-verified both viewports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-15 | M4. Activists                                                             | ✅     | Podium top-3, ranked list w/ next-rank progress, tier-colored rank badges, add/edit modal, detail drawer w/ 8-week activity chart; React-Compiler purity fix (Date.now → fetch-time binning); verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-07-15 | M5. Data import                                                           | ✅     | 3-step wizard (upload → auto-mapped columns → summary), ת"ז dedup, Excel export + template; verified with real .xlsx fixture - 6 added, 2 skipped w/ reasons, voter searchable post-import                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-07-16 | Codebase hardening pass: constants, hooks, conventions                    | ✅     | `src/constants/` (routes, labels, config, chart, common-text) + per-feature `*.constants.ts` - zero hardcoded UI strings; `src/hooks/` (useAsyncData w/ optimistic setData, useAsyncAction, useDebouncedValue) replacing repeated fetch/mutation boilerplate; every feature page split into orchestrator + hook + small subcomponents (dashboard: 5 chart files; voters: filters/header/row/bulk-bar/virtual-list; activists: podium/row; import: 3 step components); sample DB row fixtures (`data/fixtures/sample-records.json`); CLAUDE.md rewritten with full overview + conventions; fixed 3 React Compiler `set-state-in-effect` violations via the render-phase-compare pattern; global `cursor: pointer` fix; tsc/lint/build clean; full M2–M5 Playwright suite re-verified with zero regressions                                                                                                                                                   |
| 2026-07-16 | Voter registry pagination                                                 | ✅     | Replaced virtualized infinite-scroll with real pagination - page-size selector (10/25/50/100, default 10), prev/next, server-side offset/limit; new generic `components/ui/Pagination.tsx` + `COMMON_TEXT.pagination`; page resets to 1 on filter/page-size change, selection clears on page/filter change (render-phase-compare pattern); removed now-unused `@tanstack/react-virtual` dep; browser-verified desktop+mobile, no console errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-17 | Real Supabase Auth (pulled forward from P2)                               | ✅     | New Supabase project `kolbox` (`jcfzgyzqbhznncvldyvw`, eu-central-1, free tier); `profiles` table + `handle_new_user` trigger (first signup → manager, later organic signups → pending/null role) + RLS; `invite-activist` Edge Function (manager-only, service-role invite by email); `@supabase/supabase-js` client + typed `Database`; `authStore`/`AuthGuard` rewritten for real sessions incl. pending-approval screen; `LoginPage` split into manager (password, sign-in/sign-up) + activist (magic link) tabs; `ActivistModal` create-mode now sends a real invite; `ensureActivistProfile` + `useSyncActivistProfile` shim keeps tag-counts working for real logins against the still-local voter/activist store; see §5.5 for full design. tsc clean. Not yet manually tested (needs a real inbox - see §5.5 setup step)                                                                                                                           |
| 2026-07-17 | Temporarily disabled AuthGuard                                            | ⚠️     | `router.tsx`'s `<AuthGuard>` wrapper commented out (with a TODO) so `/` renders straight to the dashboard with no login - a deliberate, temporary request. Must be un-commented before real deployment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-07-17 | P1. Election Day mode - ride coordination                                 | ✅     | See §4 P1 for the full breakdown. New independent `ElectionDayVoter` dataset (own localStorage keys) with its own Excel import, coordinator filter, global countdown-to-deadline clock, row list → modal w/ call + WhatsApp (wa.me) + persisted ride-status toggle; unlocked the real `/election-day` nav route (removed the old locked placeholder); field set and auto-detected column headers (שם פרטי/שם משפחה/רחוב/מס בית/עיר/טלפון/אחראי) matched to the campaign's actual ride-list CSV export after reviewing it; tsc/lint clean                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-17 | Election Day follow-ups: multi-select filter + dashboard                  | ✅     | Coordinator filter switched to multi-select (`MultiSelectDropdown` reused from voters, with a new generic "נקה הכל" clear-all action added to that shared component); added `ElectionDayDashboard` below the countdown clock - 4 KPI tiles (total/arranged/remaining/coverage %, reusing `KpiCard`) + per-coordinator progress breakdown, computed in `useElectionDay` from the unfiltered dataset; tsc/lint clean, dev server HMRs with no errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-17 | Election Day: pace-vs-deadline card                                       | ✅     | User asked what else to add to the dashboard; recommended pace-vs-deadline since it reuses the countdown already built - user said go. `useCountdown` now also returns the ticking `now` so `computePace` (`electionDayPace.ts`) can project a finish time and flag on-track/behind-schedule without calling `Date.now()` itself (purity rule); new `PaceCard` in `ElectionDayDashboard`; tsc/lint clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-17 | Election Day: pace card removed, recent-activity card added               | ✅     | User found the pace card confusing/annoying (small early sample sizes made the "X רכיבות לשעה" projection look unreliable) and asked for something else instead. Deleted `electionDayPace.ts` + `PaceCard`, reverted `useCountdown` to its pre-pace shape (no more `now` export); added `RecentActivityCard` - last 5 "הסעה תואמה" contacts, newest first, via `fmtRelative`. tsc/lint clean, dev server HMRs with no errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-17 | Election Day: import button, RTL date-picker click, activity column       | ✅     | Replaced the drag-and-drop import dropzone with a compact "טען נתונים מקובץ" button in the page header (`ElectionDayImportButton`, hidden file input + click), matching the voters/activists add-button pattern; shared `Input` (`components/ui/Field.tsx`) now auto-adds `cursor-pointer` and calls `showPicker()` on click for date/time-type inputs, so the whole field (not just the tiny icon) opens the native picker - benefits every date/time input in the app; extracted `RideStatusBadge` out of `ElectionDayRow` into its own file and reused it in `RecentActivityCard` as a "what happened" column. tsc/lint clean                                                                                                                                                                                                                                                                                                                            |
| 2026-07-17 | Election Day: real activity log + centered layout                         | ✅     | User pointed out the "recent activity" card was fake history - it derived from the contact's _current_ `rideArranged` value, so un-marking a ride made it vanish from the list entirely instead of logging the change; also complained the row was crammed to one side instead of centered. New `RideStatusEvent` domain type (`types/index.ts`) + `rideStatusEvents` array in `MockApi` (own localStorage key, cleared on a fresh import) record every toggle's `from`/`to`/timestamp, exposed via `ApiClient.listRideStatusEvents()`; `useElectionDay` fetches/reloads this log alongside contacts. `ElectionDayDashboard`'s activity card now reads real events (survives reverts) and lays each row out as 3 equal-width grid tracks (name / from→to badges / time) so the transition sits genuinely centered instead of bunched at one edge. tsc/lint clean, dev server HMRs with no errors                                                            |
| 2026-07-17 | Election Day: sortable table (city, status)                               | ✅     | Added click-to-sort on the עיר and סטטוס הסעה column headers (`ElectionDayList`'s `SortableHeader`, toggles asc/desc with `ArrowUp`/`ArrowDown`/`ChevronsUpDown`); sort state + comparator live in `useElectionDay` (client-side, since the whole list is already fetched - no server round-trip needed unlike the paginated voter registry). tsc/lint clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-17 | Election Day: city/status multi-select filters + pagination               | ✅     | Added `ElectionDayFilters` (folded the old standalone `CoordinatorFilter` in) - three `MultiSelectDropdown`s side by side: coordinator, city, and ride-status (arranged/not arranged), all combinable; new `cities`/`cityFilter`/`statusFilter` state + filtering logic in `useElectionDay`. Also added real pagination (`components/ui/Pagination`, same component as the voter registry) - page-size 10/25/50/100, resets to page 1 on any filter/sort change via the render-phase-compare pattern (mirrors `useVoterRegistry`'s selection-reset); caps how many rows mount at once, which should also reduce the jarring height-collapse the user reported when a filter drastically shrinks the result set. Also fixed the countdown clock to force `dir="ltr"` so days→hours→minutes→seconds always reads left-to-right regardless of page RTL (same pattern already used for phone numbers elsewhere). tsc/lint clean, dev server HMRs with no errors |
| 2026-07-17 | Election Day: fixed height-collapse on empty filtered results             | ✅     | Confirmed root cause of the earlier "UI jumps up" report - `ElectionDayList` swapped to the much-shorter `EmptyState` the instant a filter/sort matched zero rows. Gave the loading/empty/list states a shared min-height so the section no longer collapses when switching between them (bumped to `min-h-[70vh]` per follow-up - "like Voters," a full screen's worth, not a small box; skeleton row count bumped to 10 to match); also split the empty message in two - "אין עדיין אנשי קשר" (true empty, no data loaded) vs. a new "לא נמצאו התאמות" / "נסו לשנות את הסינון" (filters active but matched nothing), via a new `hasActiveFilters` flag from `useElectionDay`. tsc/lint clean, dev server HMRs with no errors                                                                                                                                                                                                                              |
| 2026-07-17 | Fixed, disabled "נקה הכל" footer in `MultiSelectDropdown`                 | ✅     | Moved the clear-all button out of the scrollable options list into its own fixed footer row (options scroll independently above it in their own `overflow-y-auto` div) so it's always visible without scrolling; changed from conditionally-rendered to always-rendered-but-`disabled` when nothing is selected, instead of appearing/disappearing. Shared component - applies to every multi-select filter in the app (election-day's three + voters' city/classification). tsc/lint clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|            | M6. Polish & ship                                                         | ⬜     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
