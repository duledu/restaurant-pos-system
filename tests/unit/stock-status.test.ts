import { describe, expect, it } from "vitest";
import { inventory } from "@rcs/domain";

const { getInventoryStockStatus } = inventory;

describe("getInventoryStockStatus — P3.3 #36/#59 authoritative OUT/LOW/OK boundary", () => {
  it("stock 0 -> OUT", () => {
    expect(getInventoryStockStatus(0, 5)).toBe("OUT");
  });

  it("negative stock (defensive input) -> OUT", () => {
    expect(getInventoryStockStatus(-3, 5)).toBe("OUT");
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
    expect(getInventoryStockStatus(0, 0)).toBe("OUT"); // <=0 uvek OUT bez obzira na minimum
  });
});
