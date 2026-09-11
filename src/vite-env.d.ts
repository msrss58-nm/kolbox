/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** ORIGIN SEPARATION build-time surface selector - "election" (default when
   * absent), "platform", "both" (EXPAND only) or "multi_entity" (Platform
   * Stage 5). See src/app/router.tsx's APP_SURFACE. Optional so an existing
   * deployment that never sets it still type-checks. */
  readonly VITE_APP_SURFACE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
