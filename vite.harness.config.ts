import path from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Stage 2 voting-role UI harness ONLY - never used by `npm run dev` or
// `npm run build` (those use vite.config.ts). Renders the real,
// unmodified ElectionDayPage component tree with one single module
// swapped: src/permissions/usePermissions.ts -> scripts/harness/
// mockUsePermissions.ts, which pins the resolved role to "voting" using
// the real hasPermission()/PERMISSIONS_BY_ROLE engine (not a second,
// hand-maintained permission list). Every other module resolves normally.
const REAL_USE_PERMISSIONS = path.resolve(__dirname, "src/permissions/usePermissions.ts");
const MOCK_USE_PERMISSIONS = path.resolve(
  __dirname,
  "scripts/harness/mockUsePermissions.ts",
);

function mockUsePermissionsForHarness(): Plugin {
  return {
    name: "mock-use-permissions-for-voting-harness",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.includes("usePermissions")) return null;
      const resolved = path.resolve(path.dirname(importer), source);
      const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`];
      return candidates.includes(REAL_USE_PERMISSIONS) ? MOCK_USE_PERMISSIONS : null;
    },
  };
}

export default defineConfig({
  plugins: [mockUsePermissionsForHarness(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    // Vite's build entry defaults to the root index.html when unset - that's
    // the real app, not this harness. Without this, `vite build --config
    // vite.harness.config.ts` silently built the main app instead of
    // scripts/harness/index.html (dev-server mode was unaffected, since Vite
    // resolves /scripts/harness/index.html directly from its request URL
    // there - only `build` needs an explicit entry).
    rollupOptions: {
      input: path.resolve(__dirname, "scripts/harness/index.html"),
    },
  },
});
