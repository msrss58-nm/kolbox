// SIDE-EFFECT IMPORT, DELIBERATELY FIRST - do not reorder.
// The Platform Owner recovery flow depends on this module being evaluated
// before ANY Supabase client is constructed (every client auto-initializes
// with detectSessionInUrl on, and would otherwise consume the recovery
// tokens into its own storage key). router.tsx imports it first as well;
// pinning it here too means a future import added above ./app/router cannot
// silently reintroduce the race. See platformOwnerRecoveryUrl.ts.
import "./features/platform-owner/platformOwnerRecoveryUrl";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import "./index.css";
import { router } from "./app/router";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
