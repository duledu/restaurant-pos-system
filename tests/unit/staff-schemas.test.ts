import { describe, it, expect } from "vitest";
import { createEmployeeSchema, updateEmployeeSchema, resetPinSchema, setEmployeeStatusSchema } from "../../packages/shared/schemas";

describe("createEmployeeSchema", () => {
  it("accepts a PIN-only waiter with no email/password", () => {
    const result = createEmployeeSchema.safeParse({
      firstName: "Marko",
      lastName: "Marković",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: ["11111111-1111-1111-1111-111111111111"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid PIN format", () => {
    const result = createEmployeeSchema.safeParse({
      firstName: "Marko",
      lastName: "Marković",
      pin: "12",
      roleNames: ["WAITER"],
      locationIds: ["11111111-1111-1111-1111-111111111111"],
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one role and one location", () => {
    expect(
      createEmployeeSchema.safeParse({ firstName: "A", lastName: "B", roleNames: [], locationIds: ["11111111-1111-1111-1111-111111111111"] })
        .success
    ).toBe(false);
    expect(createEmployeeSchema.safeParse({ firstName: "A", lastName: "B", roleNames: ["WAITER"], locationIds: [] }).success).toBe(false);
  });
});

describe("updateEmployeeSchema", () => {
  it("allows a partial update (e.g. role only)", () => {
    const result = updateEmployeeSchema.safeParse({ roleNames: ["MANAGER"] });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object (no-op update)", () => {
    expect(updateEmployeeSchema.safeParse({}).success).toBe(true);
  });
});

describe("resetPinSchema / setEmployeeStatusSchema", () => {
  it("rejects a non-numeric PIN", () => {
    expect(resetPinSchema.safeParse({ pin: "abcd" }).success).toBe(false);
  });

  it("only allows ACTIVE or SUSPENDED status values", () => {
    expect(setEmployeeStatusSchema.safeParse({ status: "ACTIVE" }).success).toBe(true);
    expect(setEmployeeStatusSchema.safeParse({ status: "SUSPENDED" }).success).toBe(true);
    expect(setEmployeeStatusSchema.safeParse({ status: "TERMINATED" }).success).toBe(false);
  });
});
