/**
 * DEPLOYMENT GATE - which KOLBOX deployment is answering this request.
 *
 * All four Vercel projects build the SAME `api/` tree, so every function is
 * reachable on every origin. Request `Origin` is not a control for this: it
 * says where the caller claims to be from, never which deployment answered.
 * Without this gate, the auth broker would be a second authorization surface
 * live on the election, platform and multi-entity origins.
 *
 * Two independent, server-only conditions, both required:
 *   1. `KOLBOX_SURFACE` - deliberately NOT `VITE_APP_SURFACE`, which is
 *      build-time, client-visible and therefore not trustworthy server-side.
 *   2. exact expected-host validation against `KOLBOX_SELF_ORIGIN`.
 *
 * FAIL CLOSED: an unset or unrecognised `KOLBOX_SURFACE` denies. A project
 * that forgets the variable loses the auth ops rather than silently exposing
 * them - which is also the deliberate EXPAND-phase and kill-switch state.
 */

export type KolboxSurface = "auth" | "election" | "platform" | "multi_entity";

const SURFACES: ReadonlySet<string> = new Set([
  "auth",
  "election",
  "platform",
  "multi_entity",
]);

/**
 * The realms each deployment may mint a session for. The election origin
 * legitimately serves TWO realms (worker and Election Owner share it); the
 * other two serve exactly one. `auth` mints nothing - it only issues handoffs.
 */
export const SURFACE_REALMS: Record<KolboxSurface, readonly string[]> = {
  auth: [],
  election: ["worker", "election_owner"],
  platform: ["platform_owner"],
  multi_entity: ["multi_entity_owner"],
};

/** The configured surface, or null when unset/unrecognised (⇒ deny). */
export function currentSurface(): KolboxSurface | null {
  const raw = (process.env.KOLBOX_SURFACE ?? "").trim();
  return SURFACES.has(raw) ? (raw as KolboxSurface) : null;
}

/** This deployment's own canonical origin, as configured (never derived from
 * the request). */
export function selfOrigin(): string | null {
  const raw = (process.env.KOLBOX_SELF_ORIGIN ?? "").trim();
  return raw === "" ? null : raw.replace(/\/+$/, "");
}

/** The canonical auth origin, as configured. */
export function authOrigin(): string | null {
  const raw = (process.env.KOLBOX_AUTH_ORIGIN ?? "").trim();
  return raw === "" ? null : raw.replace(/\/+$/, "");
}

/** Length-independent constant-time compare - no early exit on length, so a
 * mismatch never leaks where it diverged. */
export function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * True when the request really was answered by the deployment it claims to
 * be: `Host` must match `KOLBOX_SELF_ORIGIN` exactly. Both must be present.
 */
export function hostMatchesSelf(host: string | string[] | undefined): boolean {
  const self = selfOrigin();
  if (!self) return false;
  const h = Array.isArray(host) ? host[0] : host;
  if (!h) return false;
  return (
    constantTimeEquals(`https://${h}`, self) || constantTimeEquals(`http://${h}`, self)
  );
}

/** The broker may answer ONLY on the auth deployment, and only when that
 * deployment's own origin is the configured auth origin. */
export function isAuthDeployment(host: string | string[] | undefined): boolean {
  const auth = authOrigin();
  const self = selfOrigin();
  return (
    currentSurface() === "auth" &&
    auth !== null &&
    self !== null &&
    constantTimeEquals(self, auth) &&
    hostMatchesSelf(host)
  );
}

/**
 * The exchange legs may answer ONLY on a target deployment (never `auth`),
 * and the realms they will accept come from server env - never from the
 * request - so a forged header can never redirect a handoff to another realm.
 */
export function targetDeploymentRealms(
  host: string | string[] | undefined,
): readonly string[] | null {
  const surface = currentSurface();
  if (surface === null || surface === "auth") return null;
  if (!hostMatchesSelf(host)) return null;
  const realms = SURFACE_REALMS[surface];
  return realms.length > 0 ? realms : null;
}
