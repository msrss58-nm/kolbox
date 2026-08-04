# Changelog

Notable changes to KolBox, in reverse chronological order.

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
