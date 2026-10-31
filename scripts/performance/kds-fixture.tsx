// Local browser fixture: two KDS terminals sharing a synthetic authoritative API.
import React, { Profiler } from "react";
import { createRoot } from "react-dom/client";
import { KdsClient } from "../../apps/web/components/kds/KdsClient";

const bench = (window as any).bench = { renders: [] as any[], requests: [] as any[], delay: 800 };
const timestamp = new Date().toISOString();
const orders = Array.from({ length: 24 }, (_, i) => ({ orderId: `order-${i}`, tableLabel: `Table ${i}`, waiterName: "Fixture",
  submittedAt: timestamp, items: Array.from({ length: 4 }, (_, j) => ({ id: `item-${i}-${j}`, name: `Dish ${i}-${j}`,
    quantity: 1, note: null, status: "SUBMITTED", modifiers: [], submittedAt: timestamp })) }));
window.fetch = async (input, options = {}) => {
  const url = String(input), method = options.method ?? "GET";
  const entry = { url, method, start: performance.now(), end: 0 }; bench.requests.push(entry);
  // A polling snapshot is captured before its network delay, to exercise stale reads.
  const snapshot = structuredClone(orders);
  await new Promise(resolve => setTimeout(resolve, url.includes("/completed") || url.includes("/print-jobs") ? 1200 : bench.delay));
  let result: any;
  if (url === "/api/pos/me") result = { restaurantId: "r", employeeId: "e", firstName: "Cook", roles: ["KITCHEN"], locationIds: ["l"] };
  else if (url.includes("/terminal/status")) result = { applicable: false };
  else if (url.includes("/completed")) result = { orders: [] };
  else if (url.includes("/print-jobs")) result = { jobs: [], autoPrintEligible: false, printerStatus: { state: "NOT_CONFIGURED" } };
  else if (url.includes("/advance")) {
    const id = url.split("/")[5];
    const item = orders.flatMap(order => order.items).find(item => item.id === id)!;
    if (method === "POST") item.status = item.status === "SUBMITTED" ? "ACCEPTED" : "READY";
    result = { item };
  } else result = { orders: snapshot.map(order => ({ ...order, items: order.items.filter(item => item.status !== "READY") })).filter(order => order.items.length) };
  entry.end = performance.now();
  return new Response(JSON.stringify(result));
};

createRoot(document.getElementById("root")!).render(<div style={{ display: "flex" }}>
  {["a", "b"].map(id => <section id={id} key={id} style={{ width: "50%" }}>
    <Profiler id={id} onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      bench.renders.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
    }}><KdsClient station="KITCHEN" title="Kitchen" environmentLabel="TEST" /></Profiler>
  </section>)}
</div>);
