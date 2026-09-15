// @vitest-environment jsdom
//
// Admin -> Osoblje urgent QA follow-up — reported bug: clicking an
// employee-specific action (PIN/edit/access) from the Osoblje list could
// appear to act on the WRONG employee ("admin@dev.local" showing instead of
// the clicked employee). A full trace of every layer (click handler -> modal
// state -> apiFetch URL -> server route -> employee-service.ts scoping)
// found every layer already keys strictly off the clicked employee's own
// `id`, never a shared/stale "selected employee" or the logged-in admin's
// own id. These tests prove that end-to-end from the client's perspective,
// for BOTH the desktop table and the mobile card stack (same component,
// same handlers, rendered twice by CSS breakpoint — jsdom does not evaluate
// `md:hidden`, so both trees are present in the DOM and must be queried
// from their own container to avoid a false "duplicate button" match).
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffClient } from "../../apps/web/app/(admin)/staff/staff-client";

function response(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as Response;
}

const admin = {
  id: "admin-1",
  firstName: "Admin",
  lastName: "Nalog",
  username: "admin@dev.local",
  status: "ACTIVE" as const,
  hasPin: false,
  pinLoginEnabled: false,
  hasLoginCredentials: true,
  createdAt: "2026-01-01T00:00:00Z",
  roles: [{ role: { name: "OWNER" } }],
  locations: [{ location: { id: "l1", name: "Glavna lokacija" } }],
};
const sank = {
  id: "emp-sank",
  firstName: "sank_new",
  lastName: "test",
  username: null,
  status: "ACTIVE" as const,
  hasPin: true,
  pinLoginEnabled: true,
  hasLoginCredentials: false,
  createdAt: "2026-01-01T00:00:00Z",
  roles: [{ role: { name: "BAR" } }],
  locations: [{ location: { id: "l1", name: "Glavna lokacija" } }],
};
const kuhinja = {
  id: "emp-kuhinja",
  firstName: "kuhinja_new",
  lastName: "test",
  username: null,
  status: "ACTIVE" as const,
  hasPin: false,
  pinLoginEnabled: false,
  hasLoginCredentials: false,
  createdAt: "2026-01-01T00:00:00Z",
  roles: [{ role: { name: "KITCHEN" } }],
  locations: [{ location: { id: "l1", name: "Glavna lokacija" } }],
};
const locationsBody = { locations: [{ id: "l1", name: "Glavna lokacija" }] };

let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let custom: (url: string, options?: RequestInit) => Response | Promise<Response> | undefined;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  custom = () => undefined;
  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    const url = String(input);
    const result = custom(url, options);
    if (result) return result;
    if (url === "/api/admin/employees") return response({ employees: [admin, sank, kuhinja] });
    if (url === "/api/admin/employees/locations") return response(locationsBody);
    return response({ employee: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(React.createElement(StaffClient));
  });
}
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
function mobileContainer(): HTMLElement {
  return host.querySelector(".md\\:hidden") as HTMLElement;
}
function desktopContainer(): HTMLElement {
  return host.querySelector(".md\\:block") as HTMLElement;
}
function findRow(container: HTMLElement, employeeFullName: string): HTMLElement {
  const nameEl = [...container.querySelectorAll("p,span")].find(
    (el) => el.textContent?.replace(/\s+/g, " ").trim() === employeeFullName
  );
  expect(nameEl, `name element for "${employeeFullName}" not found`).toBeTruthy();
  let row: HTMLElement = nameEl as HTMLElement;
  while (row.parentElement && !row.querySelector("button")) {
    row = row.parentElement;
  }
  expect(row.querySelector("button"), `no action buttons found in row for "${employeeFullName}"`).toBeTruthy();
  return row;
}
function findButtonWithin(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}
async function clickAction(container: HTMLElement, employeeName: string, actionText: string) {
  const row = findRow(container, employeeName);
  const button = findButtonWithin(row, actionText);
  await act(async () => {
    button.click();
  });
}
function fillInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("StaffClient — employee action targeting (Osoblje urgent fix)", () => {
  it("1: clicking Izmeni PIN for one employee opens a PIN modal identifying that exact employee", async () => {
    await mount();
    await clickAction(desktopContainer(), "sank_new test", "Izmeni PIN");
    expect(host.textContent).toContain("sank_new test");
    expect(host.querySelector("h2, h3")?.textContent ?? host.textContent).not.toContain("Promeni PIN —");
  });

  it("2: the PIN modal never falls back to the logged-in admin's own identity", async () => {
    await mount();
    await clickAction(desktopContainer(), "sank_new test", "Izmeni PIN");
    // The modal body must show the clicked employee, not the admin account used elsewhere on the page.
    const pinLabel = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Novi PIN"));
    expect(pinLabel).toBeTruthy();
    const modalRoot = pinLabel!.closest("div")!.parentElement!;
    expect(modalRoot.textContent).toContain("sank_new");
    expect(modalRoot.textContent).not.toContain("Admin Nalog");
    expect(modalRoot.textContent).not.toContain("admin@dev.local");
  });

  it("3: opening employee A's modal then employee B's modal never carries over A's identity (no stale state)", async () => {
    await mount();
    await clickAction(desktopContainer(), "sank_new test", "Izmeni PIN");
    expect(host.textContent).toContain("sank_new test");
    // Cancel A's modal.
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Otkaži")!.click();
    });
    await clickAction(desktopContainer(), "kuhinja_new test", "Postavi PIN");
    const pinLabel = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Novi PIN"));
    const modalRoot = pinLabel!.closest("div")!.parentElement!;
    expect(modalRoot.textContent).toContain("kuhinja_new");
    expect(modalRoot.textContent).not.toContain("sank_new");
  });

  it("4: desktop and mobile resolve the identical target employee for the same action", async () => {
    await mount();
    await clickAction(desktopContainer(), "kuhinja_new test", "Postavi PIN");
    let pinLabel = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Novi PIN"));
    expect(pinLabel!.closest("div")!.parentElement!.textContent).toContain("kuhinja_new");
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Otkaži")!.click();
    });

    await clickAction(mobileContainer(), "kuhinja_new test", "Postavi PIN");
    pinLabel = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Novi PIN"));
    expect(pinLabel!.closest("div")!.parentElement!.textContent).toContain("kuhinja_new");
  });

  it("5: submitting a PIN change only calls the API for the selected employee's id, and the success notice names them", async () => {
    await mount();
    await clickAction(desktopContainer(), "kuhinja_new test", "Postavi PIN");
    const inputs = [...host.querySelectorAll("input[inputmode='numeric']")] as HTMLInputElement[];
    fillInput(inputs[0], "1234");
    fillInput(inputs[1], "1234");
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Sačuvaj novi PIN")!.click();
    });
    await flush();
    const pinCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/pin"));
    expect(pinCalls).toHaveLength(1);
    expect(String(pinCalls[0][0])).toBe(`/api/admin/employees/${kuhinja.id}/pin`);
    expect(String(pinCalls[0][0])).not.toContain(admin.id);
    expect(String(pinCalls[0][0])).not.toContain(sank.id);
    expect(host.textContent).toContain("PIN je uspešno promenjen za kuhinja_new test.");
  });

  it("6: Isključi PIN toggles only the selected employee's own row and API call", async () => {
    await mount();
    await clickAction(desktopContainer(), "sank_new test", "Isključi PIN");
    await flush();
    const patchCalls = fetchMock.mock.calls.filter(
      ([u, o]) => String(u) === `/api/admin/employees/${sank.id}` && (o as RequestInit)?.method === "PATCH"
    );
    expect(patchCalls).toHaveLength(1);
    expect(JSON.parse((patchCalls[0][1] as RequestInit).body as string)).toEqual({ pinLoginEnabled: false });
    // kuhinja's row must still say "Uključi PIN" (unaffected).
    const kuhinjaRow = findRow(desktopContainer(), "kuhinja_new test");
    expect(kuhinjaRow.textContent).toContain("Uključi PIN");
  });

  it("7: Postavi/Resetuj pristup mutates only the selected employee's login credentials", async () => {
    await mount();
    await clickAction(desktopContainer(), "sank_new test", "Postavi pristup");
    const usernameInput = host.querySelector("input[name='tablecore-employee-login-name']") as HTMLInputElement;
    const passInput = host.querySelector("input[name='tablecore-employee-new-password']") as HTMLInputElement;
    const confirmInput = host.querySelector("input[name='tablecore-employee-new-password-confirm']") as HTMLInputElement;
    fillInput(usernameInput, "sank.test");
    fillInput(passInput, "supersecretpw");
    fillInput(confirmInput, "supersecretpw");
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Postavi podatke")!.click();
    });
    await flush();
    const credCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/login-credentials"));
    expect(credCalls).toHaveLength(1);
    expect(String(credCalls[0][0])).toBe(`/api/admin/employees/${sank.id}/login-credentials`);
  });

  it("8: Deaktiviraj mutates only the selected employee's status", async () => {
    await mount();
    await clickAction(desktopContainer(), "sank_new test", "Deaktiviraj");
    await flush();
    const statusCalls = fetchMock.mock.calls.filter(([u]) => String(u) === `/api/admin/employees/${sank.id}/status`);
    expect(statusCalls).toHaveLength(1);
    expect(JSON.parse((statusCalls[0][1] as RequestInit).body as string)).toEqual({ status: "SUSPENDED" });
    const kuhinjaRow = findRow(desktopContainer(), "kuhinja_new test");
    expect(kuhinjaRow.textContent).toContain("Aktivan");
  });

  it("9: Obriši deletes only the selected employee after typing their exact name to confirm", async () => {
    await mount();
    await clickAction(desktopContainer(), "sank_new test", "Obriši");
    const confirmInput = [...host.querySelectorAll("input")].find((i) => i.placeholder === "sank_new test") as HTMLInputElement;
    expect(confirmInput).toBeTruthy();
    fillInput(confirmInput, "sank_new test");
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Obriši trajno")!.click();
    });
    await flush();
    const deleteCalls = fetchMock.mock.calls.filter(([, o]) => (o as RequestInit)?.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(String(deleteCalls[0][0])).toBe(`/api/admin/employees/${sank.id}`);
  });

  it("11: the admin's own account is never targeted by any call made while acting on a different employee", async () => {
    await mount();
    await clickAction(desktopContainer(), "kuhinja_new test", "Deaktiviraj");
    await flush();
    await clickAction(desktopContainer(), "sank_new test", "Isključi PIN");
    await flush();
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(admin.id);
    }
  });

  it("PIN labels: shows 'Izmeni PIN' when the employee already has a PIN and 'Postavi PIN' when they do not, never a bare 'PIN' button", async () => {
    await mount();
    const sankRow = findRow(desktopContainer(), "sank_new test");
    const kuhinjaRow = findRow(desktopContainer(), "kuhinja_new test");
    expect(findButtonWithin(sankRow, "Izmeni PIN")).toBeTruthy();
    expect(findButtonWithin(kuhinjaRow, "Postavi PIN")).toBeTruthy();
    expect([...sankRow.querySelectorAll("button")].some((b) => b.textContent?.trim() === "PIN")).toBe(false);
    const mobileSankRow = findRow(mobileContainer(), "sank_new test");
    expect(findButtonWithin(mobileSankRow, "Izmeni PIN")).toBeTruthy();
  });
});
