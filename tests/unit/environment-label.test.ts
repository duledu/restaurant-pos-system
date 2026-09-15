import { describe, expect, it } from "vitest";
import { resolveEnvironmentLabel } from "../../apps/web/lib/environment-label";

describe("resolveEnvironmentLabel — a Vercel PREPROD build must never render itself as PRODUKCIJA", () => {
  it("Production (VERCEL_ENV=production) shows PRODUKCIJA", () => {
    expect(resolveEnvironmentLabel({ VERCEL_ENV: "production", NODE_ENV: "production" })).toBe("PRODUKCIJA");
  });

  it("PREPROD (VERCEL_ENV=preview, the exact combination a develop-branch Vercel deployment runs under) shows PREPROD, never PRODUKCIJA", () => {
    // This is the precise regression case: Vercel Preview builds run the
    // same optimized `next build` as Production, so NODE_ENV is
    // "production" here too — a NODE_ENV-only check would have (and did)
    // wrongly rendered PRODUKCIJA for this exact PREPROD deployment.
    expect(resolveEnvironmentLabel({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("PREPROD");
  });

  it("a preview deployment of any other branch also shows PREPROD, never PRODUKCIJA (VERCEL_ENV alone decides, not the branch name)", () => {
    expect(resolveEnvironmentLabel({ VERCEL_ENV: "preview", NODE_ENV: "production" })).not.toBe("PRODUKCIJA");
  });

  it("`vercel dev` (VERCEL_ENV=development) shows RAZVOJ", () => {
    expect(resolveEnvironmentLabel({ VERCEL_ENV: "development", NODE_ENV: "development" })).toBe("RAZVOJ");
  });

  it("local `next dev` (no VERCEL_ENV at all) shows RAZVOJ, never PRODUKCIJA", () => {
    expect(resolveEnvironmentLabel({ NODE_ENV: "development" })).toBe("RAZVOJ");
  });

  it("a local production build with no VERCEL_ENV (e.g. `next build && next start` on a laptop) still never shows PRODUKCIJA", () => {
    // The dangerous case this whole fix exists for: NODE_ENV=production is
    // NOT sufficient evidence of being the real Production deployment.
    expect(resolveEnvironmentLabel({ NODE_ENV: "production" })).not.toBe("PRODUKCIJA");
  });

  it("test runs (NODE_ENV=test, no VERCEL_ENV) show TEST", () => {
    expect(resolveEnvironmentLabel({ NODE_ENV: "test" })).toBe("TEST");
  });

  it("an empty/unset environment never defaults to PRODUKCIJA (fail closed toward a visibly non-production label)", () => {
    expect(resolveEnvironmentLabel({})).not.toBe("PRODUKCIJA");
  });
});
