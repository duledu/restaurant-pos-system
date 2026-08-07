import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, normalizeEmail, WeakPasswordError } from "@rcs/auth";

describe("Password hashing", () => {
  it("verifikuje ispravnu lozinku", async () => {
    const hash = await hashPassword("DevOwner123!");
    expect(await verifyPassword("DevOwner123!", hash)).toBe(true);
  });

  it("odbija pogrešnu lozinku", async () => {
    const hash = await hashPassword("DevOwner123!");
    expect(await verifyPassword("WrongPassword1", hash)).toBe(false);
  });

  it("odbija lozinku kraću od minimuma", async () => {
    await expect(hashPassword("short")).rejects.toBeInstanceOf(WeakPasswordError);
  });
});

describe("normalizeEmail", () => {
  it("normalizuje na lowercase i trimuje razmake", () => {
    expect(normalizeEmail("  Owner@Dev.LOCAL  ")).toBe("owner@dev.local");
  });
});
