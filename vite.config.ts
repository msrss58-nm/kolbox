import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// vite.config.ts
import path from "path";

/**
 * The approved strict CSP for the dedicated KOLBOX Auth / IdP origin.
 *
 * WHY A BUILD-TIME <meta> AND NOT `vercel.json` HEADERS. All four Vercel
 * projects build this ONE repo and therefore share one `vercel.json`, which
 * has no per-project conditional. A header there would apply this policy to
 * the three application surfaces too, where `default-src 'none'` would break
 * them immediately. `VITE_APP_SURFACE` is the only per-surface switch that
 * exists at build time, so the strict policy is emitted only into the auth
 * surface's own HTML.
 *
 * `frame-ancestors` is deliberately ABSENT here: it is ignored when delivered
 * via <meta> (per the CSP spec, along with report-uri and sandbox). It is
 * delivered as a real HTTP header from `vercel.json` instead - safely for ALL
 * surfaces, because nothing in this application is ever framed (verified: no
 * iframe anywhere in src/).
 *
 * NO `unsafe-inline` AND NO `unsafe-eval`. Verified, not assumed: the auth
 * surface's component tree contains no inline `style` attributes, `LogoMark`
 * is an inline <svg> element rather than an <img>, and the only `data:` image
 * URIs in the codebase are the MFA QR codes, which live on the platform and
 * multi-entity surfaces - never here.
 *
 * `img-src 'self'` is the one addition beyond the approved list, and it is
 * required by the actually implemented page: `index.html` links the favicon
 * `/kolbox.svg`, and favicons are subject to img-src. Nothing else was added.
 */
const AUTH_CSP_TARGET_ORIGINS_DEFAULT = [
  "https://kolbox-gamma.vercel.app",
  "https://kolbox-platform.vercel.app",
  "https://kolbox-multi-entity.vercel.app",
].join(" ");

function authSurfaceCsp(formAction: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    // Required by the implemented page: the favicon link in index.html.
    "img-src 'self'",
    // The ONLY destinations this origin may ever post credentials-derived
    // material to. Even with script injection, a form here cannot target
    // anything else.
    `form-action ${formAction}`,
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Auth-surface-only HTML transform:
 *  1. injects the strict CSP above;
 *  2. REMOVES the Google Fonts preconnect + stylesheet.
 *
 * (2) is a deliberate choice over widening the policy. Keeping the webfont
 * would have required adding fonts.googleapis.com to style-src and
 * fonts.gstatic.com to font-src on the one origin that handles every
 * principal's password. The cost of dropping it is cosmetic (a system Hebrew
 * font on one screen); the benefit is that the credential page makes no
 * third-party request at all, so no third party can inject CSS into it or
 * observe sign-in traffic. The three application surfaces are untouched and
 * keep the webfont.
 */
function authSurfaceHardening() {
  const surface = process.env.VITE_APP_SURFACE;
  const formAction =
    process.env.VITE_CSP_TARGET_ORIGINS?.trim() || AUTH_CSP_TARGET_ORIGINS_DEFAULT;
  return {
    name: "kolbox-auth-surface-hardening",
    transformIndexHtml(html: string) {
      if (surface !== "auth") return html;
      const stripped = html
        .replace(/\s*<link rel="preconnect"[^>]*>/g, "")
        .replace(/\s*<link\s+href="https:\/\/fonts\.googleapis\.com[\s\S]*?\/>/g, "");
      return stripped.replace(
        "<title>",
        `<meta http-equiv="Content-Security-Policy" content="${authSurfaceCsp(formAction)}" />\n    <title>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), authSurfaceHardening()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
