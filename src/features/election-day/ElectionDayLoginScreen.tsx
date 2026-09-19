import { EntryScreen } from "../../app/EntryScreen";

/**
 * `/election-day/login` - kept as a real, routable path because the Election
 * Owner hands out `/election-day/login?w=<code>` links and existing bookmarks
 * and suites use it. It now renders the SAME unified entry as `/` and
 * `/login`, so there is exactly one sign-in screen and one copy of the worker
 * credential form (see `EntryScreen`), not a principal-specific variant.
 *
 * The `?w=` handling lives in `EntryScreen` itself, so a workspace link keeps
 * behaving identically no matter which of the three paths it points at.
 */
export function ElectionDayLoginScreen() {
  return <EntryScreen />;
}
