import { describe, expect, it } from "vitest";
import { ticketWaitBasis } from "../../apps/web/lib/kds-wait-time";

describe("ticketWaitBasis", () => {
  it("uses the earliest item submittedAt, not the order's (frozen at the table's first-ever round)", () => {
    const result = ticketWaitBasis("2026-09-13T10:00:00Z", [
      { submittedAt: "2026-09-13T12:30:00Z" },
      { submittedAt: "2026-09-13T12:31:00Z" },
    ]);
    expect(result).toBe("2026-09-13T12:30:00Z");
  });

  it("falls back to the order's submittedAt when no item carries one", () => {
    expect(ticketWaitBasis("2026-09-13T10:00:00Z", [])).toBe("2026-09-13T10:00:00Z");
    expect(ticketWaitBasis("2026-09-13T10:00:00Z", [{ submittedAt: null }])).toBe("2026-09-13T10:00:00Z");
  });

  it("ignores null item timestamps when at least one real one exists", () => {
    expect(ticketWaitBasis(null, [{ submittedAt: null }, { submittedAt: "2026-09-13T12:00:00Z" }])).toBe("2026-09-13T12:00:00Z");
  });

  it("returns null when there is truly no timestamp anywhere", () => {
    expect(ticketWaitBasis(null, [])).toBeNull();
  });
});
