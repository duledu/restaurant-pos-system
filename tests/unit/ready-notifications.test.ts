import { describe, expect, it } from "vitest";
import { myReadyItemIds, hasNewReadyId } from "../../apps/web/lib/ready-notifications";

describe("myReadyItemIds — only the responsible waiter's tables ('do not notify unrelated waiters')", () => {
  it("collects ready item ids only from tables owned by the given employee", () => {
    const tables = [
      { activeOrderOwnerId: "waiter-1", readyItems: [{ id: "a" }, { id: "b" }] },
      { activeOrderOwnerId: "waiter-2", readyItems: [{ id: "c" }] }, // drugi konobar — ne sme uticati
      { activeOrderOwnerId: null, readyItems: [] },
    ];
    expect(myReadyItemIds(tables, "waiter-1")).toEqual(new Set(["a", "b"]));
  });

  it("returns an empty set when employeeId is null (not yet loaded)", () => {
    const tables = [{ activeOrderOwnerId: "waiter-1", readyItems: [{ id: "a" }] }];
    expect(myReadyItemIds(tables, null)).toEqual(new Set());
  });

  it("returns an empty set when the waiter has no ready items anywhere", () => {
    const tables = [{ activeOrderOwnerId: "waiter-1", readyItems: [] }];
    expect(myReadyItemIds(tables, "waiter-1")).toEqual(new Set());
  });
});

describe("hasNewReadyId — sound fires only for a genuinely NEW ready event", () => {
  it("is true when current has an id not present in known", () => {
    expect(hasNewReadyId(new Set(["a"]), new Set(["a", "b"]))).toBe(true);
  });

  it("is false when current is identical to known — never replay for the same poll result", () => {
    expect(hasNewReadyId(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(false);
  });

  it("is false when current is a subset of known (some items were picked up, none are new)", () => {
    expect(hasNewReadyId(new Set(["a", "b"]), new Set(["a"]))).toBe(false);
  });

  it("is false when both are empty (no ready items, nothing new)", () => {
    expect(hasNewReadyId(new Set(), new Set())).toBe(false);
  });

  it("simulates repeated polling: fires exactly once for one new item across three identical follow-up polls", () => {
    let known = new Set<string>(["a"]);
    const pollResults = [new Set(["a", "b"]), new Set(["a", "b"]), new Set(["a", "b"])];
    const fired: boolean[] = [];
    for (const current of pollResults) {
      fired.push(hasNewReadyId(known, current));
      known = current;
    }
    expect(fired).toEqual([true, false, false]);
  });
});
