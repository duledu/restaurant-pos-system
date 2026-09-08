// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockIsQzLibraryLoaded = vi.fn();
const mockConnectQz = vi.fn();

vi.mock("../../apps/web/lib/qz-client", () => ({
  isQzLibraryLoaded: mockIsQzLibraryLoaded,
  connectQz: mockConnectQz,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveAutoPrintTransport", () => {
  it("uses BrowserPrintTransport when QZ is not enabled in device settings", async () => {
    const { resolveAutoPrintTransport } = await import("../../apps/web/lib/qz-auto-transport");
    const { BrowserPrintTransport } = await import("../../apps/web/lib/print-transport");

    const transport = await resolveAutoPrintTransport({ enabled: false, printerName: "POS-58 (1)" });
    expect(transport).toBeInstanceOf(BrowserPrintTransport);
    expect(mockConnectQz).not.toHaveBeenCalled();
  });

  it("uses BrowserPrintTransport when enabled but no printer is selected", async () => {
    const { resolveAutoPrintTransport } = await import("../../apps/web/lib/qz-auto-transport");
    const { BrowserPrintTransport } = await import("../../apps/web/lib/print-transport");

    const transport = await resolveAutoPrintTransport({ enabled: true, printerName: null });
    expect(transport).toBeInstanceOf(BrowserPrintTransport);
  });

  it("falls back to BrowserPrintTransport when the QZ library is not loaded (QZ Tray not running)", async () => {
    mockIsQzLibraryLoaded.mockReturnValue(false);
    const { resolveAutoPrintTransport } = await import("../../apps/web/lib/qz-auto-transport");
    const { BrowserPrintTransport } = await import("../../apps/web/lib/print-transport");

    const transport = await resolveAutoPrintTransport({ enabled: true, printerName: "POS-58 (1)" });
    expect(transport).toBeInstanceOf(BrowserPrintTransport);
    expect(mockConnectQz).not.toHaveBeenCalled();
  });

  it("falls back to BrowserPrintTransport when QZ is configured but unreachable (connect fails)", async () => {
    mockIsQzLibraryLoaded.mockReturnValue(true);
    mockConnectQz.mockRejectedValue(new Error("QZ Tray not running"));
    const { resolveAutoPrintTransport } = await import("../../apps/web/lib/qz-auto-transport");
    const { BrowserPrintTransport } = await import("../../apps/web/lib/print-transport");

    const transport = await resolveAutoPrintTransport({ enabled: true, printerName: "POS-58 (1)" });
    expect(transport).toBeInstanceOf(BrowserPrintTransport);
  });

  it("uses QzPrintTransport when enabled, configured, and QZ connects successfully", async () => {
    mockIsQzLibraryLoaded.mockReturnValue(true);
    mockConnectQz.mockResolvedValue(undefined);
    const { resolveAutoPrintTransport } = await import("../../apps/web/lib/qz-auto-transport");
    const { QzPrintTransport } = await import("../../apps/web/lib/print-transport");

    const transport = await resolveAutoPrintTransport({ enabled: true, printerName: "POS-58 (1)" });
    expect(transport).toBeInstanceOf(QzPrintTransport);
  });
});
