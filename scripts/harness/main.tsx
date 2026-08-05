import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { ElectionDayPage } from "../../src/features/election-day/ElectionDayPage";
import type { ElectionDayOutletContext } from "../../src/features/election-day/ElectionDayGuard";
import "../../src/index.css";

// ElectionDayPage reads `isBootstrap` via `useOutletContext` (the bootstrap
// fix, commit 51377a5) - it must be rendered under a real react-router
// Outlet providing that context, exactly like the real `ElectionDayGuard`
// does, or `useOutletContext` resolves to `undefined` and the page crashes.
// `isBootstrap: false` here since the voting role is never the bootstrap
// window's role - this harness renders the "signed-in session" shape.
function HarnessOutlet() {
  return <Outlet context={{ isBootstrap: false } satisfies ElectionDayOutletContext} />;
}

const router = createMemoryRouter([
  {
    element: <HarnessOutlet />,
    children: [{ path: "/", element: <ElectionDayPage /> }],
  },
]);

// Renders the real, unmodified ElectionDayPage - only usePermissions is
// swapped for a mock pinned to "voting" (see vite.harness.config.ts +
// mockUsePermissions.ts). Fetches real, read-only data from the same
// Supabase project the real app uses (no mutation anywhere in this page's
// render path unless a button is clicked, and this harness never clicks
// one - it only inspects the rendered DOM).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
