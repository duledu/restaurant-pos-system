// Inspect performance.getEntriesByType("measure") in local development.
// No employee/order payloads or production logging.
export function waiterTiming(name: string): () => void {
  if (process.env.NODE_ENV !== "development" || typeof performance === "undefined") return () => {};
  const start = performance.now();
  return () => { performance.measure(`waiter:${name}`, { start, end: performance.now() }); };
}

export function waiterNavigationStart() {
  if (process.env.NODE_ENV === "development") performance.mark("waiter:navigation");
}

export function waiterNavigationVisible(screen: "tables" | "menu") {
  if (process.env.NODE_ENV !== "development") return;
  if (performance.getEntriesByName("waiter:navigation").length) {
    performance.measure(`waiter:${screen}-visible`, "waiter:navigation");
    performance.clearMarks("waiter:navigation");
  }
}
