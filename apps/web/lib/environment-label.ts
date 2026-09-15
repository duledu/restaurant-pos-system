/**
 * PREPROD physical QA follow-up — the Kitchen/Bar header previously
 * hardcoded "produkcija" unconditionally, so a PREPROD screen (Vercel
 * Preview build of the `develop` branch) looked visually IDENTICAL to
 * real Production. A restaurant manager or QA tester had no way to tell
 * them apart just by looking at the screen — flagged as potentially
 * dangerous.
 *
 * NODE_ENV is NOT a safe signal for this distinction: Vercel builds
 * Preview deployments with the exact same optimized `next build` as
 * Production, so NODE_ENV is "production" for BOTH. The actual
 * authoritative signal Vercel provides specifically for this is
 * VERCEL_ENV — "production" only for the deployment bound to the
 * project's Production Branch (main, in this project), "preview" for
 * every other branch (including develop/PREPROD), "development" for
 * `vercel dev`. This mirrors the same principle already used by
 * scripts/lib/db-environment.mjs's database marker (never trust NODE_ENV
 * or a name alone; prefer the platform's own authoritative identity
 * signal) — applied here to Vercel's DEPLOYMENT identity rather than the
 * database identity, because PREPROD and a local developer machine can
 * both point at the same DEVELOPMENT database and would be
 * indistinguishable by the DB marker alone.
 *
 * Deliberately takes an explicit env object rather than reading
 * process.env itself, so this stays a pure, trivially unit-testable
 * function — see tests/unit/environment-label.test.ts, which proves a
 * Vercel Preview build (VERCEL_ENV=preview, NODE_ENV=production — the
 * exact combination a real PREPROD deployment runs under) can never
 * resolve to PRODUKCIJA.
 */
export function resolveEnvironmentLabel(env: { VERCEL_ENV?: string; NODE_ENV?: string }): string {
  if (env.VERCEL_ENV === "production") return "PRODUKCIJA";
  if (env.VERCEL_ENV === "preview") return "PREPROD";
  if (env.VERCEL_ENV === "development") return "RAZVOJ";
  if (env.NODE_ENV === "test") return "TEST";
  // No VERCEL_ENV at all — not a Vercel deployment (local `next dev`/`next
  // start`). NODE_ENV=production here is a locally-run production build,
  // never Vercel's actual Production — still must never say PRODUKCIJA.
  return "RAZVOJ";
}
