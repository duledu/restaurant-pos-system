// @vitest-environment jsdom
/**
 * localStorage se ovde eksplicitno stub-uje jednostavnim in-memory
 * objektom umesto oslanjanja na jsdom-ov ugrađen Storage — u ovom
 * okruženju (Node 25 eksperimentalni globalni `localStorage`) taj global
 * ume da nadjača jsdom-ov pre nego što environment uopšte krene, ostavljajući
 * objekat bez setItem/clear metoda. Ovaj stub testira ISTU javnu ugovoreno
 * ponašanje (get/set/parse-safety) nezavisno od te okolinske nedoslednosti.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getQzSettings — defaults", () => {
  it("returns disabled/no-printer defaults when nothing is stored", async () => {
    const { getQzSettings } = await import("../../apps/web/lib/qz-settings");
    expect(getQzSettings()).toEqual({ enabled: false, printerName: null });
  });

  it("survives malformed JSON in localStorage without throwing", async () => {
    localStorage.setItem("tablecore.qzPrintSettings", "{not valid json");
    const { getQzSettings } = await import("../../apps/web/lib/qz-settings");
    expect(getQzSettings()).toEqual({ enabled: false, printerName: null });
  });

  it("coerces unexpected shapes back to safe defaults", async () => {
    localStorage.setItem("tablecore.qzPrintSettings", JSON.stringify({ enabled: "yes", printerName: 42 }));
    const { getQzSettings } = await import("../../apps/web/lib/qz-settings");
    const result = getQzSettings();
    expect(result.printerName).toBeNull();
  });
});

describe("saveQzSettings / getQzSettings round-trip", () => {
  it("persists and reads back the saved settings", async () => {
    const { saveQzSettings, getQzSettings } = await import("../../apps/web/lib/qz-settings");
    saveQzSettings({ enabled: true, printerName: "POS-58 (1)" });
    expect(getQzSettings()).toEqual({ enabled: true, printerName: "POS-58 (1)" });
  });
});

describe("isQzAutoPrintConfigured", () => {
  it("is false when disabled even with a printer selected", async () => {
    const { isQzAutoPrintConfigured } = await import("../../apps/web/lib/qz-settings");
    expect(isQzAutoPrintConfigured({ enabled: false, printerName: "POS-58 (1)" })).toBe(false);
  });

  it("is false when enabled but no printer selected", async () => {
    const { isQzAutoPrintConfigured } = await import("../../apps/web/lib/qz-settings");
    expect(isQzAutoPrintConfigured({ enabled: true, printerName: null })).toBe(false);
  });

  it("is true only when both enabled and a printer is selected", async () => {
    const { isQzAutoPrintConfigured } = await import("../../apps/web/lib/qz-settings");
    expect(isQzAutoPrintConfigured({ enabled: true, printerName: "POS-58 (1)" })).toBe(true);
  });
});
