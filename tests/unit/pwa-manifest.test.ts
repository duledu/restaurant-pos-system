import { describe, expect, it } from "vitest";
import manifest from "../../apps/web/app/manifest";

describe("P3.1 web app manifest", () => {
  const result = manifest();

  it("uses the exact TableCore brand name — short_name for home-screen labels, name for the fuller install-dialog title", () => {
    expect(result.short_name).toBe("TableCore");
    expect(result.name).toContain("TableCore");
    expect(result.short_name!.length).toBeLessThanOrEqual(12); // mobile home-screen label budget
  });

  it("launches at the existing root redirect, scoped to the whole app, in standalone display", () => {
    expect(result.start_url).toBe("/");
    expect(result.scope).toBe("/");
    expect(result.display).toBe("standalone");
  });

  it("uses the TableCore navy brand color for theme_color, not an invented palette", () => {
    expect(result.theme_color).toBe("#0A1931");
    expect(result.background_color).toBe("#F6FAFD");
  });

  it("declares at least one icon >=192px and one >=512px, including a maskable variant", () => {
    const icons = result.icons ?? [];
    expect(icons.length).toBeGreaterThan(0);
    const sizesOf = (sizes?: string) => Number((sizes ?? "0x0").split("x")[0]);
    expect(icons.some((i) => sizesOf(i.sizes) >= 192)).toBe(true);
    expect(icons.some((i) => sizesOf(i.sizes) >= 512)).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.startsWith("/icons/")).toBe(true);
    }
  });
});
