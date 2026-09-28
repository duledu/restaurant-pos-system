import { describe, expect, it } from "vitest";
import { resolveQrMenuTheme, type QrMenuThemeInput } from "../../packages/shared/qr-menu-theme";

function input(overrides: Partial<QrMenuThemeInput> = {}): QrMenuThemeInput {
  return {
    themePreset: "WARM",
    accentColor: null,
    typographyPreset: "MODERN",
    cardStyle: "BALANCED",
    imageShape: "ROUNDED",
    ...overrides,
  };
}

describe("resolveQrMenuTheme — default theme (spec section 26, branding fallback)", () => {
  it("produces a complete, usable token set with no configuration at all", () => {
    const tokens = resolveQrMenuTheme(input());
    expect(tokens["--menu-primary"]).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(tokens["--menu-background"]).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(tokens["--menu-surface"]).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(tokens["--menu-text"]).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(tokens["--menu-muted"]).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(tokens["--menu-border"]).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(tokens["--menu-on-primary"]).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("resolveQrMenuTheme — the 4 presets are visually distinct", () => {
  it("LIGHT/DARK/WARM/ELEGANT each produce a different background", () => {
    const backgrounds = (["LIGHT", "DARK", "WARM", "ELEGANT"] as const).map((themePreset) => resolveQrMenuTheme(input({ themePreset }))["--menu-background"]);
    expect(new Set(backgrounds).size).toBe(4);
  });

  it("DARK preset is actually dark (low luminance background)", () => {
    const tokens = resolveQrMenuTheme(input({ themePreset: "DARK" }));
    const hex = tokens["--menu-background"].replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    expect(r).toBeLessThan(60); // near-black
  });

  it("LIGHT preset is actually light (high luminance background)", () => {
    const tokens = resolveQrMenuTheme(input({ themePreset: "LIGHT" }));
    const hex = tokens["--menu-background"].replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    expect(r).toBeGreaterThan(200);
  });
});

describe("resolveQrMenuTheme — accent color", () => {
  it("uses the theme preset's own default accent when none is configured", () => {
    const withAccent = resolveQrMenuTheme(input({ themePreset: "ELEGANT", accentColor: null }));
    expect(withAccent["--menu-primary"]).toBeTruthy();
  });

  it("uses a custom accent color when provided", () => {
    const tokens = resolveQrMenuTheme(input({ accentColor: "#123ABC" }));
    expect(tokens["--menu-primary"]).toBe("#123ABC");
  });

  it("falls back to the theme default for a malformed accent instead of crashing (never trust stored input blindly)", () => {
    const tokens = resolveQrMenuTheme(input({ themePreset: "WARM", accentColor: "not-a-color" }));
    expect(tokens["--menu-primary"]).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("resolveQrMenuTheme — automatic contrast-safe on-accent text (spec section 27)", () => {
  it("a light/bright accent gets dark on-accent text", () => {
    const tokens = resolveQrMenuTheme(input({ accentColor: "#FFFFFF" }));
    expect(tokens["--menu-on-primary"]).toBe("#111111");
  });

  it("a dark accent gets white on-accent text", () => {
    const tokens = resolveQrMenuTheme(input({ accentColor: "#000000" }));
    expect(tokens["--menu-on-primary"]).toBe("#FFFFFF");
  });

  it("never produces low-contrast on-accent text regardless of the chosen accent (always exactly black or white)", () => {
    const samples = ["#B8860B", "#F5A524", "#8B6D3F", "#DC2626", "#111827", "#FEF2F2"];
    for (const accentColor of samples) {
      const tokens = resolveQrMenuTheme(input({ accentColor }));
      expect(["#111111", "#FFFFFF"]).toContain(tokens["--menu-on-primary"]);
    }
  });
});

describe("resolveQrMenuTheme — image shape controls border radius", () => {
  it("ROUNDED/SOFT/SQUARE each produce a different radius", () => {
    const radii = (["ROUNDED", "SOFT", "SQUARE"] as const).map((imageShape) => resolveQrMenuTheme(input({ imageShape }))["--menu-radius"]);
    expect(new Set(radii).size).toBe(3);
  });
});

describe("public menu text contrast", () => {
  it("keeps normal and secondary text readable in every restaurant theme", () => {
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    for (const themePreset of ["LIGHT", "DARK", "WARM", "ELEGANT"] as const) {
      const tokens = resolveQrMenuTheme(input({ themePreset }));
      for (const key of ["--menu-text", "--menu-muted"] as const) {
        const a = luminance(tokens[key]), b = luminance(tokens["--menu-background"]);
        expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), `${themePreset} ${key}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
