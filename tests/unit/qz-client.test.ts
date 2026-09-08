// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIsActive = vi.fn();
const mockConnect = vi.fn();
const mockFind = vi.fn();
const mockConfigsCreate = vi.fn();
const mockPrint = vi.fn();
const mockSetCertificatePromise = vi.fn();
const mockSetSignatureAlgorithm = vi.fn();
const mockSetSignaturePromise = vi.fn();

vi.mock("qz-tray", () => ({
  websocket: { isActive: mockIsActive, connect: mockConnect },
  printers: { find: mockFind },
  configs: { create: mockConfigsCreate },
  print: mockPrint,
  security: {
    setCertificatePromise: mockSetCertificatePromise,
    setSignatureAlgorithm: mockSetSignatureAlgorithm,
    setSignaturePromise: mockSetSignaturePromise,
  },
}));

function fetchOkOnce(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => body } as Response)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsActive.mockReturnValue(false);
  mockConfigsCreate.mockImplementation((printer: string, options: unknown) => ({ printer, options }));
  fetchOkOnce({ certificate: "", signature: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildTicketRoot(): HTMLElement {
  const root = document.createElement("div");
  root.className = "print-ticket-root";
  const inner = document.createElement("div");
  inner.className = "print-ticket";
  inner.textContent = "TICKET";
  root.appendChild(inner);
  document.body.appendChild(root);
  return root;
}

describe("isQzLibraryLoaded", () => {
  it("is true when the qz-tray module is present", async () => {
    const { isQzLibraryLoaded } = await import("../../apps/web/lib/qz-client");
    expect(isQzLibraryLoaded()).toBe(true);
  });
});

describe("connectQz", () => {
  it("resolves immediately without calling connect() when already active", async () => {
    mockIsActive.mockReturnValue(true);
    const { connectQz } = await import("../../apps/web/lib/qz-client");
    await connectQz();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("calls websocket.connect() when not active and resolves on success", async () => {
    mockConnect.mockResolvedValue(undefined);
    const { connectQz } = await import("../../apps/web/lib/qz-client");
    await expect(connectQz()).resolves.toBeUndefined();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("throws QzUnavailableError when the connection fails (QZ Tray not running)", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));
    const { connectQz, QzUnavailableError } = await import("../../apps/web/lib/qz-client");
    await expect(connectQz()).rejects.toBeInstanceOf(QzUnavailableError);
  });

  it("dedupes concurrent connect attempts into a single websocket.connect() call", async () => {
    let resolveConnect!: () => void;
    mockConnect.mockReturnValue(new Promise<void>((r) => (resolveConnect = r)));
    const { connectQz } = await import("../../apps/web/lib/qz-client");

    const p1 = connectQz();
    const p2 = connectQz();
    resolveConnect();
    await Promise.all([p1, p2]);

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

describe("listPrinters / isPrinterAvailable", () => {
  it("returns the printer list from qz.printers.find()", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["POS-58 (1)", "POS-80 Bar"]);
    const { listPrinters } = await import("../../apps/web/lib/qz-client");
    expect(await listPrinters()).toEqual(["POS-58 (1)", "POS-80 Bar"]);
  });

  it("wraps a single-string result from qz.printers.find() into an array", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue("POS-58 (1)");
    const { listPrinters } = await import("../../apps/web/lib/qz-client");
    expect(await listPrinters()).toEqual(["POS-58 (1)"]);
  });

  it("isPrinterAvailable is true only for a printer actually reported by QZ", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["POS-58 (1)"]);
    const { isPrinterAvailable } = await import("../../apps/web/lib/qz-client");
    expect(await isPrinterAvailable("POS-58 (1)")).toBe(true);
    expect(await isPrinterAvailable("Some Other Printer")).toBe(false);
  });
});

describe("printTicketViaQz — successful print path", () => {
  it("calls qz.print() with the configured printer and resolves", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["POS-58 (1)"]);
    mockPrint.mockResolvedValue(undefined);
    const { printTicketViaQz } = await import("../../apps/web/lib/qz-client");

    await printTicketViaQz(buildTicketRoot(), "POS-58 (1)");

    expect(mockPrint).toHaveBeenCalledTimes(1);
    const [config, data] = mockPrint.mock.calls[0];
    expect(config.printer).toBe("POS-58 (1)");
    expect(data[0]).toMatchObject({ type: "pixel", format: "html", flavor: "plain" });
    expect(data[0].data).toContain("TICKET");
  });
});

describe("printTicketViaQz — printer not found", () => {
  it("throws QzPrinterNotFoundError without calling qz.print()", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["Some Other Printer"]);
    const { printTicketViaQz, QzPrinterNotFoundError } = await import("../../apps/web/lib/qz-client");

    await expect(printTicketViaQz(buildTicketRoot(), "POS-58 (1)")).rejects.toBeInstanceOf(QzPrinterNotFoundError);
    expect(mockPrint).not.toHaveBeenCalled();
  });
});

describe("printTicketViaQz — failed print does not resolve as success", () => {
  it("throws QzPrintFailedError when qz.print() rejects", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["POS-58 (1)"]);
    mockPrint.mockRejectedValue(new Error("Printer offline"));
    const { printTicketViaQz, QzPrintFailedError } = await import("../../apps/web/lib/qz-client");

    await expect(printTicketViaQz(buildTicketRoot(), "POS-58 (1)")).rejects.toBeInstanceOf(QzPrintFailedError);
  });
});

describe("qzTestPrint — never touches order/print-job endpoints", () => {
  it("prints via QZ without calling any /api/pos or /api/production endpoint", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["POS-58 (1)"]);
    mockPrint.mockResolvedValue(undefined);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ certificate: "", signature: "" }) });
    vi.stubGlobal("fetch", fetchSpy);

    const { qzTestPrint } = await import("../../apps/web/lib/qz-client");
    await qzTestPrint("POS-58 (1)", 58);

    expect(mockPrint).toHaveBeenCalledTimes(1);
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.every((u) => !u.includes("/api/pos/") && !u.includes("/api/production/"))).toBe(true);
  });
});
