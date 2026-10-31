// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { ReservationsClient } from "../../apps/web/app/waiter/reservations/reservations-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/reservations" }));
vi.mock("../../apps/web/components/ui/LogoutButton", () => ({ LogoutButton: () => null }));
vi.mock("../../apps/web/components/ui/QuickLockButton", () => ({ QuickLockButton: () => null }));

const base = { id: "r1", locationId: "l1", guestName: "Ana", phone: "060123456", partySize: 3,
  reservedAt: "2026-10-31T19:00:00Z", status: "CONFIRMED", note: "Window seat",
  table: { id: "t1", label: "7", floor: { id: "f1", name: "Main" } } };
const props = { locations: [{ id: "l1", name: "Main" }, { id: "l2", name: "Terrace" }], timeZone: "UTC", canManage: true };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
let rows: typeof base[];
let roots: Root[];
let hosts: HTMLDivElement[];
let fetchMock: ReturnType<typeof vi.fn>;
let intercept: (url: string, options?: RequestInit) => Response | Promise<Response> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T10:00:00Z"));
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rows = [];
  roots = [];
  hosts = [];
  intercept = () => undefined;
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const intercepted = intercept(url, options);
    if (intercepted) return intercepted;
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/api/pos/tables") return response({ floors: [{ id: "f1", name: "Main", tables: [{ id: "t1", label: "7", capacity: 4, status: "FREE" }] }] });
    if (options?.method === "POST" && parsed.pathname === "/api/pos/reservations") {
      const body = JSON.parse(String(options.body));
      const reservation = { ...base, ...body, id: `r${rows.length + 1}`, reservedAt: `${body.date}T${body.time}:00Z` };
      rows.push(reservation);
      return response({ reservation }, 201);
    }
    const id = parsed.pathname.split("/")[4];
    const reservation = rows.find(row => row.id === id);
    if (options?.method === "PATCH") {
      const body = JSON.parse(String(options.body));
      Object.assign(reservation!, body, { reservedAt: `${body.date}T${body.time}:00Z` });
      return response({ reservation });
    }
    if (options?.method === "POST") {
      const action = parsed.pathname.split("/")[5];
      reservation!.status = ({ seat: "SEATED", "no-show": "NO_SHOW", cancel: "CANCELLED", complete: "COMPLETED" })[action]!;
      return response({ reservation });
    }
    if (id && id !== "search") return response({ reservation: structuredClone(reservation) });
    return response({ reservations: structuredClone(rows.filter(row => row.locationId === parsed.searchParams.get("locationId") &&
      (id === "search" ? row.guestName.toLowerCase().includes(parsed.searchParams.get("q")!.toLowerCase()) : row.reservedAt.startsWith(parsed.searchParams.get("date")!)))) });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await act(async () => roots.forEach(root => root.unmount()));
  hosts.forEach(host => host.remove());
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function mount(mode: "admin" | "waiter", overrides = {}) {
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(React.createElement(ReservationsClient, { ...props, mode, ...overrides })));
  return host;
}
async function tick(ms = 4000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function click(host: Element, text: string) {
  const button = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}
async function change(host: Element, label: string, value: string) {
  const input = host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  expect(input, label).toBeTruthy();
  const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype : input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function create(host: Element, name: string) {
  await click(host, "+ Nova rezervacija");
  await change(host, "Ime gosta", name); await change(host, "Telefon", "060123456");
  await click(host, "Sačuvaj rezervaciju");
}

describe("Admin and Waiter share reservation records and polling", () => {
  it.each(["admin", "waiter"] as const)("%s creates and the other active screen sees it by the next 4-second poll", async mode => {
    const first = await mount(mode), other = await mount(mode === "admin" ? "waiter" : "admin");
    await create(first, "Shared Guest");
    expect(first.textContent).toContain("Shared Guest");
    expect(other.textContent).not.toContain("Shared Guest");
    await tick(3999); expect(other.textContent).not.toContain("Shared Guest");
    await tick(1); expect(other.textContent).toContain("Shared Guest");
    expect(rows).toHaveLength(1);
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith("/api/pos/"))).toBe(true);
  });

  it("Manager edits the same record and Waiter receives time, party size and note changes", async () => {
    rows = [{ ...base }];
    const admin = await mount("admin"), waiter = await mount("waiter");
    await click(admin, "Izmeni");
    await change(admin, "Vreme rezervacije", "20:30"); await change(admin, "Broj osoba", "5"); await change(admin, "Napomena", "");
    await click(admin, "Sačuvaj rezervaciju"); await tick();
    expect(waiter.textContent).toContain("20:30"); expect(waiter.textContent).toContain("5 osoba");
    expect(waiter.textContent).not.toContain("Window seat"); expect(rows[0].id).toBe("r1");
  });

  it("Waiter status changes refresh Admin lists and an open details dialog", async () => {
    rows = [{ ...base }];
    const admin = await mount("admin"), waiter = await mount("waiter");
    await click(admin, "Detalji");
    await click(waiter, "Gosti su stigli"); await click(waiter, "Smesti goste");
    await tick();
    expect(admin.querySelector('[role="dialog"]')!.textContent).toContain("Smešteni");
    await click(waiter, "Završeno"); await tick();
    expect(admin.querySelector('[role="dialog"]')!.textContent).toContain("Završeno");
  });

  it("cancellation refreshes an active Waiter search result", async () => {
    rows = [{ ...base }];
    const admin = await mount("admin"), waiter = await mount("waiter");
    await change(waiter, "Pretraga rezervacija", "Ana"); await tick(250);
    await click(admin, "Otkaži"); await click(admin, "Otkaži rezervaciju"); await tick();
    expect(waiter.textContent).toContain("Ana"); expect(waiter.textContent).toContain("Otkazano");
    expect([...waiter.querySelectorAll("button")].some(button => button.textContent === "Izmeni")).toBe(false);
  });

  it("filters date/status and prevents a late response from restoring another location", async () => {
    rows = [{ ...base }, { ...base, id: "r2", guestName: "Cancelled Guest", status: "CANCELLED" }, { ...base, id: "r3", guestName: "Tomorrow", reservedAt: "2026-11-01T19:00:00Z" }];
    const admin = await mount("admin");
    await change(admin, "Status rezervacije", "CANCELLED");
    expect(admin.textContent).not.toContain("Ana"); expect(admin.textContent).toContain("Cancelled Guest");
    await change(admin, "Status rezervacije", ""); await change(admin, "Izaberi datum", "2026-11-01");
    expect(admin.textContent).toContain("Tomorrow"); expect(admin.textContent).not.toContain("Cancelled Guest");
    const late = deferred<Response>();
    intercept = url => url.includes("/reservations?locationId=l1") ? late.promise : undefined;
    await tick();
    await change(admin, "Lokacija", "l2");
    await act(async () => late.resolve(response({ reservations: [{ ...base }] })));
    expect(admin.textContent).not.toContain("Ana");
  });

  it("polls never replace unsaved form input and edits use the restaurant timezone", async () => {
    rows = [{ ...base, reservedAt: "2026-10-30T23:30:00Z" }];
    // The API filters in restaurant timezone; return this row for the selected local day.
    intercept = url => url.includes("/reservations?") ? response({ reservations: rows }) : undefined;
    const admin = await mount("admin", { timeZone: "Europe/Belgrade" });
    await click(admin, "Izmeni");
    expect((admin.querySelector('[aria-label="Datum rezervacije"]') as HTMLInputElement).value).toBe("2026-10-31");
    expect((admin.querySelector('[aria-label="Vreme rezervacije"]') as HTMLInputElement).value).toBe("00:30");
    await change(admin, "Ime gosta", "Unsaved name"); rows[0].guestName = "Remote name"; await tick();
    expect((admin.querySelector('[aria-label="Ime gosta"]') as HTMLInputElement).value).toBe("Unsaved name");
  });

  it("shows conflict errors without claiming a successful create", async () => {
    intercept = (url, options) => url === "/api/pos/reservations" && options?.method === "POST" ? response({ error: "Sto već ima rezervaciju" }, 409) : undefined;
    const admin = await mount("admin"); await create(admin, "Conflict Guest");
    expect(admin.querySelector('[role="dialog"]')!.textContent).toContain("Sto već ima rezervaciju");
    expect(rows).toHaveLength(0);
  });

  it("reports refresh failure and recovers automatically without dropping existing data", async () => {
    rows = [{ ...base }]; const admin = await mount("admin");
    intercept = url => url.includes("/reservations?") ? response({}, 503) : undefined;
    await tick(); expect(admin.textContent).toContain("Prikaz možda nije ažuran"); expect(admin.textContent).toContain("Ana");
    intercept = () => undefined; rows[0].status = "CANCELLED"; await tick();
    expect(admin.textContent).toContain("Otkazano"); expect(admin.textContent).not.toContain("Prikaz možda nije ažuran");
  });

  it("a stale poll cannot erase a reservation created while that poll was in flight", async () => {
    const admin = await mount("admin");
    const pending = deferred<Response>(); let polls = 0;
    intercept = url => url.includes("/reservations?") && ++polls === 1 ? pending.promise : undefined;
    await tick(); await create(admin, "New Guest");
    await act(async () => pending.resolve(response({ reservations: [] })));
    expect(admin.textContent).toContain("New Guest");
  });

  it("a timed-out poll releases its single-flight guard and the next tick recovers", async () => {
    const admin = await mount("admin"); let blocked = true;
    intercept = (url, options) => url.includes("/reservations?") && blocked ? new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")));
    }) : undefined;
    await tick(); // request starts at t=4s
    await tick(10000); // timeout at t=14s, skipped polls did not overlap
    expect(admin.textContent).toContain("Prikaz možda nije ažuran");
    rows = [{ ...base }]; blocked = false; await tick(2000);
    expect(admin.textContent).toContain("Ana"); expect(admin.textContent).not.toContain("Prikaz možda nije ažuran");
  });

  it("refreshes on focus and stops polling on unmount", async () => {
    const admin = await mount("admin"); rows = [{ ...base }];
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(admin.textContent).toContain("Ana");
    await act(async () => roots[0].unmount()); roots = [];
    const count = fetchMock.mock.calls.length; await tick(12000);
    expect(fetchMock.mock.calls).toHaveLength(count);
  });

  it("read-only permission hides all management actions while retaining details", async () => {
    rows = [{ ...base }]; const admin = await mount("admin", { canManage: false });
    for (const label of ["Nova rezervacija", "Izmeni", "Otkaži", "Gosti su stigli", "Nisu došli"]) {
      expect([...admin.querySelectorAll("button")].some(button => button.textContent?.includes(label))).toBe(false);
    }
    await click(admin, "Detalji"); expect(admin.querySelector('[role="dialog"]')!.textContent).toContain("Window seat");
  });

  it("Admin navigation links to /reservations only with reservation view permission", async () => {
    const { AdminNav } = await import("../../apps/web/components/admin/AdminNav");
    const host = document.createElement("div"); hosts.push(host); const root = createRoot(host); roots.push(root);
    await act(async () => root.render(React.createElement(AdminNav, { canViewReservations: false })));
    expect(host.querySelector('a[href="/reservations"]')).toBeNull();
    await act(async () => root.render(React.createElement(AdminNav, { canViewReservations: true })));
    expect(host.querySelector('a[href="/reservations"]')!.textContent).toBe("Rezervacije");
  });
});
