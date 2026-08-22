import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * P3.1 regression test — apps/web/middleware.ts cannot be imported directly
 * from a DB-free unit test (it pulls in `@rcs/auth/session`, which this
 * project's vitest module resolution for `apps/web`'s own path aliases
 * doesn't cover outside the Next.js build — see the failed import attempt
 * during P3.1 development). Instead this reads the middleware's actual
 * `config.matcher` source text and evaluates it as the real regex Next.js
 * would compile, so a future edit to the matcher is still caught here
 * without needing to execute the whole module/its auth import chain.
 *
 * Why this test exists: during P3.1 development, `/manifest.webmanifest`
 * and `/icons/*.png` were found to 307-redirect to /login for an
 * unauthenticated request — Chrome/Android fetch these BEFORE any session
 * exists (e.g. right at the login screen) to decide whether TableCore is
 * installable, so this was a real, install-breaking bug, fixed by adding
 * both to the middleware's existing public-static-asset exclusion (the
 * same exclusion that already covered branding/ and Next's own assets).
 */
function readMiddlewareMatcher(): string {
  const source = fs.readFileSync(path.join(__dirname, "../../apps/web/middleware.ts"), "utf8");
  const match = source.match(/matcher:\s*\[\s*"([^"]+)"\s*\]/);
  if (!match) throw new Error("Could not find middleware.ts's config.matcher — has its shape changed?");
  return match[1];
}

describe("middleware.ts public-asset matcher", () => {
  const matcherSource = readMiddlewareMatcher();
  // Next.js compiles this matcher string as a path regex; for this simple
  // negative-lookahead pattern (no path-to-regexp glob tokens), evaluating
  // it directly as a JS RegExp against a leading-slash-stripped path
  // reproduces the same match/no-match decision.
  const matcherRegex = new RegExp("^" + matcherSource + "$");
  // NAPOMENA: pattern već sam počinje literalnim "/" (npr. "/((?!...).*)"),
  // pa se pathname prosleđuje SA vodećom kosom crtom, ne bez nje.
  const middlewareRunsOn = (pathname: string) => matcherRegex.test(pathname);

  it("does NOT run middleware on the PWA manifest or icons — they must be fetchable without a session", () => {
    expect(middlewareRunsOn("/manifest.webmanifest")).toBe(false);
    expect(middlewareRunsOn("/icons/icon-192.png")).toBe(false);
    expect(middlewareRunsOn("/icons/icon-512.png")).toBe(false);
    expect(middlewareRunsOn("/icons/icon-maskable-512.png")).toBe(false);
    expect(middlewareRunsOn("/icons/apple-touch-icon.png")).toBe(false);
  });

  it("still excludes the pre-existing public assets (branding, Next internals, favicon) — regression guard", () => {
    expect(middlewareRunsOn("/branding/tablecore-favicon-512.png")).toBe(false);
    expect(middlewareRunsOn("/favicon.ico")).toBe(false);
    expect(middlewareRunsOn("/_next/static/chunk.js")).toBe(false);
    expect(middlewareRunsOn("/_next/image?url=x")).toBe(false);
  });

  it("still runs middleware (auth required) on real pages and APIs — the fix must not over-exclude", () => {
    expect(middlewareRunsOn("/dashboard")).toBe(true);
    expect(middlewareRunsOn("/waiter/tables")).toBe(true);
    expect(middlewareRunsOn("/api/admin/reports/sales")).toBe(true);
    expect(middlewareRunsOn("/login")).toBe(true); // public page, but still middleware-evaluated (isPublicPath handles it inside)
  });
});
