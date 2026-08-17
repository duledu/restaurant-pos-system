import { describe, it, expect } from "vitest";
import { isMeaningfulVoidExplanation, VOID_REASON_CODES, VOID_REASON_LABELS } from "../../packages/shared/void-reasons";

describe("isMeaningfulVoidExplanation", () => {
  it("rejects empty and whitespace-only input", () => {
    expect(isMeaningfulVoidExplanation("")).toBe(false);
    expect(isMeaningfulVoidExplanation("   ")).toBe(false);
  });

  it("rejects the specific junk examples from the spec", () => {
    expect(isMeaningfulVoidExplanation(".")).toBe(false);
    expect(isMeaningfulVoidExplanation("-")).toBe(false);
    expect(isMeaningfulVoidExplanation("x")).toBe(false);
    expect(isMeaningfulVoidExplanation("test")).toBe(false);
    expect(isMeaningfulVoidExplanation("Test")).toBe(false);
    expect(isMeaningfulVoidExplanation("n/a")).toBe(false);
  });

  it("rejects a single character repeated", () => {
    expect(isMeaningfulVoidExplanation("xxxxxxxxxx")).toBe(false);
    expect(isMeaningfulVoidExplanation("..........")).toBe(false);
  });

  it("rejects short strings under the minimum meaningful length", () => {
    expect(isMeaningfulVoidExplanation("wrong qty")).toBe(false); // 9 chars
  });

  it("accepts a real explanation", () => {
    expect(isMeaningfulVoidExplanation("Entered 2 instead of 1 by mistake.")).toBe(true);
    expect(isMeaningfulVoidExplanation("Gost je promenio narudžbinu pre nego sto je posluzeno.")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isMeaningfulVoidExplanation("   Entered 2 instead of 1 by mistake.   ")).toBe(true);
  });
});

describe("VOID_REASON_CODES / VOID_REASON_LABELS", () => {
  it("has a label for every reason code", () => {
    for (const code of VOID_REASON_CODES) {
      expect(VOID_REASON_LABELS[code]).toBeTruthy();
    }
  });

  it("includes the reasons from the spec", () => {
    expect(VOID_REASON_CODES).toContain("ORDERED_BY_MISTAKE");
    expect(VOID_REASON_CODES).toContain("WRONG_QUANTITY");
    expect(VOID_REASON_CODES).toContain("CUSTOMER_CHANGED_MIND");
    expect(VOID_REASON_CODES).toContain("WRONG_ITEM");
    expect(VOID_REASON_CODES).toContain("KITCHEN_UNAVAILABLE");
    expect(VOID_REASON_CODES).toContain("KITCHEN_ISSUE");
    expect(VOID_REASON_CODES).toContain("QUALITY_ISSUE");
    expect(VOID_REASON_CODES).toContain("MANAGER_DECISION");
    expect(VOID_REASON_CODES).toContain("OTHER");
  });
});
