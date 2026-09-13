// Local browser benchmark only. All APIs are synthetic; never contacts a database.
import React, { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WaiterShellProvider } from '../../apps/web/lib/waiter-shell';
import { OrderClient } from '../../apps/web/app/waiter/tables/[tableId]/order-client';
import { PosClient } from '../../apps/web/app/waiter/tables/pos-client';

const bench = (window as any).bench = { renders: [], requests: [], delay: 200, navigate: (_: string) => {}, ready: () => {} };
const categories = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Category ${i}`, type: 'DRINK' }));
const items = Array.from({ length: 240 }, (_, i) => ({ id: `m${i}`, name: `Drink ${i}`, categoryId: `c${i % 12}`, price: '200', modifierGroups: i === 0 ? [{ group: { id: 'g', name: 'Extras', isActive: true, required: false, minSelect: 0, maxSelect: 1, options: [{ id: 'lemon', name: 'Lemon', isActive: true, priceDelta: '20' }] } }] : [] }));
const floors = [{ id: 'f', name: 'Main', tables: Array.from({ length: 24 }, (_, i) => ({ id: `${i + 1}`, label: `Table ${i + 1}`, capacity: 4, status: i === 23 ? 'FREE' : 'OCCUPIED', activeOrderOwnerId: i === 23 ? null : 'e', readyItems: [] as any[] })) }];
const orders = new Map(floors[0].tables.map(t => [t.id, { id: `o${t.id}`, locationId: 'l', status: t.status === 'FREE' ? 'DRAFT' : 'SUBMITTED', table: { label: t.label }, items: t.status === 'FREE' ? [] : Array.from({ length: 80 }, (_, i) => ({ id: `${t.id}-i${i}`, menuItemId: `m${i + 1}`, name: `Drink ${i + 1}`, price: '200', quantity: 1, status: 'SUBMITTED', note: null, modifiers: [], submittedAt: i < 77 ? '2026-09-13T10:00:00Z' : '2026-09-13T11:00:00Z' })) as any[] }]));
bench.ready = () => { orders.get('1')!.items[0].status = 'READY'; floors[0].tables[0].readyItems = [{ id: '1-i0', name: 'Drink 1' }]; };
let sequence = 0;
window.fetch = async (input, options = {}) => {
  const url = String(input), method = options.method ?? 'GET', start = performance.now();
  const entry = { url, method, duration: 0 }; bench.requests.push(entry);
  await new Promise(r => setTimeout(r, bench.delay));
  const body = options.body ? JSON.parse(String(options.body)) : {};
  let result: any;
  if (url === '/api/pos/me') result = { restaurantId: 'r', employeeId: 'e', firstName: 'Fixture', lastName: '', roles: ['WAITER'], locationIds: ['l'] };
  else if (url.includes('/snapshot')) result = { restaurantId: 'r', locationId: 'l', categories, items, menuVersion: 1 };
  else if (url.includes('/availability')) result = { locationId: 'l', items: items.map(i => ({ menuItemId: i.id, stock: null, recipeAvailability: null, availability: { isAvailable: true, reasonCode: null, reasonLabel: null } })) };
  else if (url.includes('/shift')) result = { shift: { id: 's', status: 'OPEN' } };
  else if (url.includes('/tables')) result = { floors };
  else if (url === '/api/pos/orders') result = { order: orders.get(body.tableId) };
  else {
    const match = url.match(/\/orders\/o(\d+)(?:\/items(?:\/([^/]+))?)?/);
    if (!match) throw new Error('Unmocked API');
    const order = orders.get(match[1])!;
    if (method === 'POST' && url.endsWith('/items')) {
      const menu = items.find(i => i.id === body.menuItemId)!;
      const item = { id: `new${++sequence}`, menuItemId: menu.id, name: menu.name, price: body.modifierOptionIds?.length ? '220' : menu.price, quantity: body.quantity, status: 'DRAFT', note: null, modifiers: (body.modifierOptionIds ?? []).map((id: string) => ({ modifierOptionId: id, optionName: 'Lemon', priceDelta: '20' })) };
      order.items.push(item); result = { item };
    } else if (method === 'PATCH') { const item = order.items.find(i => i.id === match[2]); item.quantity = body.quantity; result = { item }; }
    else if (method === 'DELETE') { order.items = order.items.filter(i => i.id !== match[2]); result = { ok: true }; }
    else result = { order };
  }
  entry.duration = performance.now() - start;
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
function App() {
  const [route, navigate] = useState('/waiter/tables'); bench.navigate = navigate;
  const table = route.match(/\/tables\/(\d+)/)?.[1];
  return <Profiler id="waiter" onRender={(_, phase, actualDuration, baseDuration, startTime, commitTime) => bench.renders.push({ phase, actualDuration, baseDuration, startTime, commitTime })}>
    <WaiterShellProvider>{table ? <OrderClient tableId={table} /> : <PosClient />}</WaiterShellProvider>
  </Profiler>;
}
createRoot(document.getElementById('root')!).render(<App />);
