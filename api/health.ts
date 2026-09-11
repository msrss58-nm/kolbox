// Liveness probe, and - since ORIGIN SEPARATION - the deployment-identity
// anchor for the dual-project CUTOVER gate.
//
// The Platform Owner console and the Election Day application are deployed as
// two separate Vercel projects from the SAME repository and branch. They can
// legitimately diverge (a failed or queued build, a one-sided rollback, an
// alias still pointing at an older deployment), so a cutover must prove BOTH
// origins are serving the SAME commit. This endpoint is that proof: one
// unauthenticated GET per origin returns the commit each deployment was built
// from and which surface it was built as.
//
// Deliberately served by the deployment itself rather than read from the
// Vercel API or CLI: the CLI's `inspect --json` shape does not reliably carry
// `meta.githubCommitSha`, and CLI credentials for this project have been lost
// before and can only be restored by a human. Evidence that needs no
// authentication cannot be blocked that way.
//
// Discloses no secret: the surface is already obvious from the URL, and the
// commit SHA is an opaque identifier that reveals nothing the deployed bundle
// does not already contain.

/** Returned instead of a SHA when the platform provides none - i.e. any local
 * or non-Vercel run. Explicit and deterministic on purpose: a placeholder that
 * could be mistaken for a real revision (a zero-filled or invented 40-hex
 * string) would make the cutover gate silently unfalsifiable. */
const LOCAL_COMMIT_FALLBACK = "local";

/** The surfaces a deployment may be built as. "both" is the transitional
 * EXPAND state in which one deployment serves every route; cutover is the flip
 * from "both" to "election". "multi_entity" (Platform Stage 5) is the Multi-
 * Entity Owner's own origin and is never part of "both". Mirrors
 * src/app/router.tsx's APP_SURFACE. */
const KNOWN_SURFACES = ["election", "platform", "both", "multi_entity"] as const;

/** Anything unset or unrecognised resolves to "election", matching the
 * router's own default so the reported surface can never disagree with the
 * routes the bundle actually registered. */
function resolveSurface(raw: string | undefined): string {
  return KNOWN_SURFACES.includes(raw as (typeof KNOWN_SURFACES)[number])
    ? (raw as string)
    : "election";
}

export default function handler(
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
) {
  res.status(200).json({
    ok: true,
    // Vercel sets this at build time for Git-connected deployments. `||` (not
    // `??`) so an empty string falls back too.
    commit: process.env.VERCEL_GIT_COMMIT_SHA || LOCAL_COMMIT_FALLBACK,
    // Mirrors src/app/router.tsx's APP_SURFACE resolution exactly, including
    // its default: anything outside the known set is the election surface.
    surface: resolveSurface(process.env.VITE_APP_SURFACE),
  });
}
