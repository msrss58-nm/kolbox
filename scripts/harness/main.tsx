import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ElectionDayPage } from "../../src/features/election-day/ElectionDayPage";
import "../../src/index.css";

// Renders the real, unmodified ElectionDayPage - only usePermissions is
// swapped for a mock pinned to "voting" (see vite.harness.config.ts +
// mockUsePermissions.ts). Fetches real, read-only data from the same
// Supabase project the real app uses (no mutation anywhere in this page's
// render path unless a button is clicked, and this harness never clicks
// one - it only inspects the rendered DOM).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ElectionDayPage />
  </StrictMode>,
);
