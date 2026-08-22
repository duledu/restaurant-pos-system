import { describe, expect, it } from "vitest";
import { OFFLINE_MESSAGE, canShowInstallCta, isStandaloneDisplay } from "../../apps/web/lib/pwa";

describe("isStandaloneDisplay", () => {
  it("is true when the standalone media query matches (Android/Chrome/desktop installed PWA)", () => {
    expect(isStandaloneDisplay({ matchesStandaloneMediaQuery: true })).toBe(true);
  });

  it("is true when iOS reports navigator.standalone, even without the media query", () => {
    expect(isStandaloneDisplay({ matchesStandaloneMediaQuery: false, iosStandalone: true })).toBe(true);
  });

  it("is false in ordinary browser tabs", () => {
    expect(isStandaloneDisplay({ matchesStandaloneMediaQuery: false, iosStandalone: false })).toBe(false);
    expect(isStandaloneDisplay({ matchesStandaloneMediaQuery: false })).toBe(false);
  });
});

describe("canShowInstallCta", () => {
  it("shows the install affordance only when the browser actually offered a deferred prompt", () => {
    expect(canShowInstallCta({ isInstalled: false, hasDeferredPrompt: true })).toBe(true);
  });

  it("never fabricates install availability when the browser never fired beforeinstallprompt (e.g. Safari/iOS)", () => {
    expect(canShowInstallCta({ isInstalled: false, hasDeferredPrompt: false })).toBe(false);
  });

  it("hides the affordance once the app is already installed, even if a stale prompt reference remains", () => {
    expect(canShowInstallCta({ isInstalled: true, hasDeferredPrompt: true })).toBe(false);
  });
});

describe("OFFLINE_MESSAGE", () => {
  it("is the exact required Serbian wording, and never implies an action was saved", () => {
    expect(OFFLINE_MESSAGE).toBe(
      "Nema internet veze. TableCore zahteva vezu sa serverom za rad sa porudžbinama i naplatom."
    );
  });
});
