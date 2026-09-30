import { describe, expect, it } from "vitest";
import { finalizeGuestOrderSchema, guestOrderTokenSchema, claimGuestOrderHandoffSchema } from "../../packages/shared/guest-order-schemas";

function validItem(overrides: Partial<{ menuItemId: string; quantity: number; note: string }> = {}) {
  return { menuItemId: "11111111-1111-1111-1111-111111111111", quantity: 1, ...overrides };
}

describe("finalizeGuestOrderSchema — first line of abuse protection on a public endpoint", () => {
  it("accepts a well-formed request", () => {
    const result = finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [validItem()] });
    expect(result.success).toBe(true);
  });

  it("lowercases and trims the slug", () => {
    const result = finalizeGuestOrderSchema.safeParse({ slug: "  MASA  ", items: [validItem()] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.slug).toBe("masa");
  });

  it("rejects an empty item list", () => {
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [] }).success).toBe(false);
  });

  it("rejects more than 20 line items", () => {
    const items = Array.from({ length: 21 }, () => validItem());
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items }).success).toBe(false);
  });

  it("accepts exactly 20 line items (the boundary)", () => {
    const items = Array.from({ length: 20 }, () => validItem());
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items }).success).toBe(true);
  });

  it("rejects a quantity over 20", () => {
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [validItem({ quantity: 21 })] }).success).toBe(false);
  });

  it("rejects a zero or negative quantity", () => {
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [validItem({ quantity: 0 })] }).success).toBe(false);
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [validItem({ quantity: -1 })] }).success).toBe(false);
  });

  it("rejects a non-integer quantity", () => {
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [validItem({ quantity: 1.5 })] }).success).toBe(false);
  });

  it("rejects a note over 140 characters", () => {
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [validItem({ note: "x".repeat(141) })] }).success).toBe(false);
  });

  it("accepts a note at exactly 140 characters", () => {
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [validItem({ note: "x".repeat(140) })] }).success).toBe(true);
  });

  it("rejects a non-uuid menuItemId — never trusts an arbitrary client-supplied id shape", () => {
    expect(finalizeGuestOrderSchema.safeParse({ slug: "masa", items: [validItem({ menuItemId: "not-a-uuid" })] }).success).toBe(false);
  });

  it("rejects a missing slug", () => {
    expect(finalizeGuestOrderSchema.safeParse({ items: [validItem()] }).success).toBe(false);
  });
});

describe("guestOrderTokenSchema / claimGuestOrderHandoffSchema", () => {
  it("rejects a short token (below the entropy-consistent minimum length)", () => {
    expect(guestOrderTokenSchema.safeParse({ token: "short" }).success).toBe(false);
  });

  it("accepts a realistic base64url token", () => {
    const token = "a".repeat(43); // matches randomBytes(32).toString('base64url') length
    expect(guestOrderTokenSchema.safeParse({ token }).success).toBe(true);
  });

  it("claim requires a valid tableId (uuid) alongside the token", () => {
    const token = "a".repeat(43);
    expect(claimGuestOrderHandoffSchema.safeParse({ token, tableId: "not-a-uuid" }).success).toBe(false);
    expect(claimGuestOrderHandoffSchema.safeParse({ token, tableId: "11111111-1111-1111-1111-111111111111" }).success).toBe(true);
  });
});
