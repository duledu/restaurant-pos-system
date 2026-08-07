import { describe, it, expect } from "vitest";
import { openOrderSchema, addOrderItemSchema, submitOrderSchema } from "@rcs/shared";

describe("openOrderSchema", () => {
  it("prihvata validan tableId sa opcionim brojem gostiju", () => {
    const result = openOrderSchema.safeParse({
      tableId: "123e4567-e89b-12d3-a456-426614174000",
      guestCount: 4,
    });
    expect(result.success).toBe(true);
  });

  it("odbija nerealno veliki broj gostiju (verovatna greška unosa)", () => {
    const result = openOrderSchema.safeParse({
      tableId: "123e4567-e89b-12d3-a456-426614174000",
      guestCount: 500,
    });
    expect(result.success).toBe(false);
  });
});

describe("addOrderItemSchema", () => {
  it("default količina je 1", () => {
    const parsed = addOrderItemSchema.parse({ menuItemId: "123e4567-e89b-12d3-a456-426614174000" });
    expect(parsed.quantity).toBe(1);
  });

  it("odbija količinu 0", () => {
    const result = addOrderItemSchema.safeParse({
      menuItemId: "123e4567-e89b-12d3-a456-426614174000",
      quantity: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("submitOrderSchema", () => {
  it("zahteva validan UUID idempotencyKey", () => {
    const result = submitOrderSchema.safeParse({ idempotencyKey: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("prihvata validan idempotencyKey", () => {
    const result = submitOrderSchema.safeParse({ idempotencyKey: "123e4567-e89b-12d3-a456-426614174000" });
    expect(result.success).toBe(true);
  });
});
