import { describe, it, expect } from "vitest";
import { resolveRedirectPath, ADMIN_ROLES, WAITER_ROLES, KITCHEN_ROLES, BAR_ROLES } from "@rcs/shared";

describe("resolveRedirectPath", () => {
  it("OWNER ide na /admin", () => {
    expect(resolveRedirectPath(["OWNER"])).toBe("/admin");
  });
  it("KITCHEN ide na /kitchen", () => {
    expect(resolveRedirectPath(["KITCHEN"])).toBe("/kitchen");
  });
  it("BAR ide na /bar", () => {
    expect(resolveRedirectPath(["BAR"])).toBe("/bar");
  });
  it("WAITER ide na /waiter", () => {
    expect(resolveRedirectPath(["WAITER"])).toBe("/waiter");
  });
  it("korisnik bez ijedne poznate role ide na /login", () => {
    expect(resolveRedirectPath([])).toBe("/login");
  });
  it("OWNER+WAITER (teorijski) prioritizuje /admin", () => {
    expect(resolveRedirectPath(["WAITER", "OWNER"])).toBe("/admin");
  });
});

describe("Route guard role liste — konzistentnost sa bezbednosnim zahtevom", () => {
  it("WAITER rola nije u ADMIN_ROLES (konobar ne sme na /admin)", () => {
    expect(ADMIN_ROLES).not.toContain("WAITER");
  });
  it("KITCHEN rola nije u ADMIN_ROLES", () => {
    expect(ADMIN_ROLES).not.toContain("KITCHEN");
  });
  it("BAR rola nije u WAITER_ROLES niti KITCHEN_ROLES (razdvojeni ekrani)", () => {
    expect(WAITER_ROLES).not.toContain("BAR");
    expect(KITCHEN_ROLES).not.toContain("BAR");
  });
  it("KITCHEN rola nije u BAR_ROLES (kuhinja ne vidi šank ekran i obrnuto)", () => {
    expect(BAR_ROLES).not.toContain("KITCHEN");
  });
});
