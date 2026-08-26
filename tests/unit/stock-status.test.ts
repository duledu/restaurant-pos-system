import { describe, expect, it } from "vitest";
import { inventory } from "@rcs/domain";

const { getInventoryStockStatus } = inventory;

describe("getInventoryStockStatus — P1.7 authoritative NEGATIVE/OUT/LOW/OK boundary", () => {
  it("stock 0 -> OUT", () => {
    expect(getInventoryStockStatus(0, 5)).toBe("OUT");
  });

  it("negative stock -> NEGATIVE (P1.7: a real, valid recorded deficit — never treated as plain OUT)", () => {
    expect(getInventoryStockStatus(-3, 5)).toBe("NEGATIVE");
    expect(getInventoryStockStatus(-0.001, null)).toBe("NEGATIVE"); // even a tiny deficit, with no minimum configured
  });

  it("stock > 0 and <= minimum -> LOW", () => {
    expect(getInventoryStockStatus(3, 5)).toBe("LOW");
    expect(getInventoryStockStatus(5, 5)).toBe("LOW"); // tačno na granici je i dalje LOW, ne OK
  });

  it("stock > minimum -> OK", () => {
    expect(getInventoryStockStatus(6, 5)).toBe("OK");
  });

  it("stock > 0 with no minimum configured (null) -> OK, never LOW", () => {
    expect(getInventoryStockStatus(1, null)).toBe("OK");
  });

  it("decimal boundaries (Inventory uses Decimal(12,3), e.g. 2.500/0.750)", () => {
    expect(getInventoryStockStatus(0.75, 1)).toBe("LOW");
    expect(getInventoryStockStatus(2.5, 2)).toBe("OK");
    expect(getInventoryStockStatus(2.5, 2.5)).toBe("LOW");
    expect(getInventoryStockStatus(0, 0)).toBe("OUT"); // 0 je uvek OUT bez obzira na minimum
    expect(getInventoryStockStatus(-0.5, 0)).toBe("NEGATIVE"); // negativno pobeđuje čak i kad je minimum 0
  });
});
