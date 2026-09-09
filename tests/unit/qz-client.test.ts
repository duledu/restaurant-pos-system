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

function buildTicketData(overrides?: Partial<import("../../apps/web/lib/qz-ticket-html").QzKitchenBarTicketData>) {
  return {
    stationLabel: "KUHINJA",
    tableLabel: "5",
    orderNumber: "ABC12345",
    waiterName: "Marko",
    submittedAt: new Date().toISOString(),
    isAdditional: false,
    items: [{ quantity: 2, name: "Pljeskavica", note: null, modifiers: [] }],
    paperWidthMm: 58,
    ...overrides,
  };
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

describe("security promise wiring — signing credentials absent (production default today)", () => {
  it("does NOT register any QZ security promise, avoiding QZ's 'Failed to sign request'", async () => {
    fetchOkOnce({ certificate: "", signingConfigured: false });
    mockConnect.mockResolvedValue(undefined);
    const { connectQz } = await import("../../apps/web/lib/qz-client");

    await connectQz();

    expect(mockSetCertificatePromise).not.toHaveBeenCalled();
    expect(mockSetSignaturePromise).not.toHaveBeenCalled();
    expect(mockSetSignatureAlgorithm).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledTimes(1); // connection still proceeds — unsigned mode, not blocked
  });

  it("treats a missing signingConfigured field the same as false (safe default)", async () => {
    fetchOkOnce({ certificate: "" }); // no signingConfigured key at all
    mockConnect.mockResolvedValue(undefined);
    const { connectQz } = await import("../../apps/web/lib/qz-client");

    await connectQz();

    expect(mockSetSignaturePromise).not.toHaveBeenCalled();
  });

  it("still connects successfully even if the certificate-status fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    mockConnect.mockResolvedValue(undefined);
    const { connectQz } = await import("../../apps/web/lib/qz-client");

    await expect(connectQz()).resolves.toBeUndefined();
    expect(mockSetSignaturePromise).not.toHaveBeenCalled();
  });
});

describe("security promise wiring — signing credentials configured", () => {
  it("registers certificate + signature promises using the fetched certificate and calls qz-sign correctly when QZ invokes them", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/print/qz-certificate") {
        return Promise.resolve({ ok: true, json: async () => ({ certificate: "-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----", signingConfigured: true }) } as Response);
      }
      if (url === "/api/print/qz-sign") {
        const body = JSON.parse(String(init?.body));
        expect(body.toSign).toBe("nonce-123");
        return Promise.resolve({ ok: true, json: async () => ({ signature: "base64-signature" }) } as Response);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mockConnect.mockResolvedValue(undefined);
    const { connectQz } = await import("../../apps/web/lib/qz-client");

    await connectQz();

    expect(mockSetCertificatePromise).toHaveBeenCalledTimes(1);
    expect(mockSetSignatureAlgorithm).toHaveBeenCalledWith("SHA512");
    expect(mockSetSignaturePromise).toHaveBeenCalledTimes(1);

    // Exercise the registered certificate promise the way QZ itself would.
    const certResolve = vi.fn();
    mockSetCertificatePromise.mock.calls[0][0](certResolve);
    expect(certResolve).toHaveBeenCalledWith("-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----");

    // Exercise the registered signature promise the way QZ itself would.
    const signResult = await mockSetSignaturePromise.mock.calls[0][0]("nonce-123");
    expect(signResult).toBe("base64-signature");
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

    await printTicketViaQz(buildTicketData(), "POS-58 (1)");

    expect(mockPrint).toHaveBeenCalledTimes(1);
    const [config, data] = mockPrint.mock.calls[0];
    expect(config.printer).toBe("POS-58 (1)");
    expect(data[0]).toMatchObject({ type: "pixel", format: "html", flavor: "plain" });
    expect(data[0].data).toContain("Pljeskavica");
  });

  it("passes the two-pass measured height into qz.configs.create (not just width)", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["POS-58 (1)"]);
    mockPrint.mockResolvedValue(undefined);
    const { printTicketViaQz } = await import("../../apps/web/lib/qz-client");

    await printTicketViaQz(buildTicketData(), "POS-58 (1)");

    expect(mockConfigsCreate).toHaveBeenCalledTimes(1);
    const [, options] = mockConfigsCreate.mock.calls[0];
    expect(options.units).toBe("mm");
    expect(options.size.width).toBe(58);
    expect(options.size.height).toBeGreaterThan(0);
  });
});

describe("printTicketViaQz — printer not found", () => {
  it("throws QzPrinterNotFoundError without calling qz.print()", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["Some Other Printer"]);
    const { printTicketViaQz, QzPrinterNotFoundError } = await import("../../apps/web/lib/qz-client");

    await expect(printTicketViaQz(buildTicketData(), "POS-58 (1)")).rejects.toBeInstanceOf(QzPrinterNotFoundError);
    expect(mockPrint).not.toHaveBeenCalled();
  });
});

describe("printTicketViaQz — failed print does not resolve as success", () => {
  it("throws QzPrintFailedError when qz.print() rejects", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockFind.mockResolvedValue(["POS-58 (1)"]);
    mockPrint.mockRejectedValue(new Error("Printer offline"));
    const { printTicketViaQz, QzPrintFailedError } = await import("../../apps/web/lib/qz-client");

    await expect(printTicketViaQz(buildTicketData(), "POS-58 (1)")).rejects.toBeInstanceOf(QzPrintFailedError);
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
